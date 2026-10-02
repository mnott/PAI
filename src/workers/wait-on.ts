/**
 * wait-on.ts — bounded wait for a detached job, the worker alternative to a
 * long blocking foreground call (which starves operator messages and
 * supervision). Recipe: `nohup sh -c 'CMD; echo $? > /tmp/job.rc' > /tmp/job.log 2>&1 & echo $! > /tmp/job.pid`,
 * then `pai worker wait-on $(cat /tmp/job.pid) --log /tmp/job.log` until exit 0.
 *
 * Exit codes: 0 pid gone, 3 still running at --max, 2 pid never existed or not ours.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

export const WAIT_DEFAULT_SECS = 110;
export const WAIT_CAP_SECS = 115;
const POLL_MS = 2000;
const HEARTBEAT_MS = 20_000;
/** Slack between the first observation and a process start time (ps lstart has 1 s resolution). */
const REUSE_SLACK_MS = 2000;

export interface WaitOnOpts {
  pid: number;
  log?: string;
  maxSecs?: number;
  tail?: number;
}

export interface WaitOnDeps {
  /** "alive" | "gone" | "foreign" (exists, not ours). */
  probe: (pid: number) => "alive" | "gone" | "foreign";
  /** Process start time in ms epoch, null when unknown. */
  startTime: (pid: number) => number | null;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  out: (line: string) => void;
}

export const realDeps: WaitOnDeps = {
  probe(pid) {
    try {
      process.kill(pid, 0);
      return "alive";
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM" ? "foreign" : "gone";
    }
  },
  startTime(pid) {
    try {
      const t = Date.parse(execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim());
      return Number.isFinite(t) ? t : null;
    } catch {
      return null;
    }
  },
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  out: (l) => console.log(l),
};

const readLines = (file: string | undefined): string[] => {
  if (!file || !existsSync(file)) return [];
  const t = readFileSync(file, "utf8");
  return t === "" ? [] : t.replace(/\n$/, "").split("\n");
};

function rcOf(pid: number, log?: string): string | null {
  for (const f of [log && `${log}.rc`, log && log.replace(/\.[^./]+$/, ".rc"), `/tmp/${pid}.rc`]) {
    if (f && existsSync(f)) return readFileSync(f, "utf8").trim();
  }
  return null;
}

export async function waitOn(o: WaitOnOpts, d: WaitOnDeps = realDeps): Promise<number> {
  const maxMs = Math.min(o.maxSecs ?? WAIT_DEFAULT_SECS, WAIT_CAP_SECS) * 1000;
  const tail = o.tail ?? 20;
  const t0 = d.now();
  const baseLines = readLines(o.log).length;

  const finish = (): number => {
    const rc = rcOf(o.pid, o.log);
    d.out(`pid ${o.pid} gone${rc !== null ? `, exit code ${rc}` : ""}`);
    if (tail > 0) for (const l of readLines(o.log).slice(-tail)) d.out(l);
    return 0;
  };

  if (!Number.isInteger(o.pid) || o.pid <= 0) {
    d.out(`wait-on: invalid pid ${o.pid}`);
    return 2;
  }
  const first = d.probe(o.pid);
  if (first === "foreign") {
    d.out(`wait-on: pid ${o.pid} is not owned by this user`);
    return 2;
  }
  if (first === "gone") {
    // A job that finished between two wait-on calls leaves an rc or a log; neither means the pid never existed.
    if (rcOf(o.pid, o.log) !== null || (o.log && existsSync(o.log))) return finish();
    d.out(`wait-on: pid ${o.pid} does not exist`);
    return 2;
  }

  let nextBeat = t0 + HEARTBEAT_MS;
  while (d.now() - t0 < maxMs) {
    await d.sleep(Math.min(POLL_MS, Math.max(0, maxMs - (d.now() - t0))));
    const st = d.startTime(o.pid);
    if (d.probe(o.pid) !== "alive" || (st !== null && st > t0 + REUSE_SLACK_MS)) return finish();
    if (d.now() >= nextBeat) {
      d.out(`running ${Math.round((d.now() - t0) / 1000)}s, log +${readLines(o.log).length - baseLines} lines`);
      nextBeat += HEARTBEAT_MS;
    }
  }
  d.out(`still running after ${Math.round((d.now() - t0) / 1000)}s (pid ${o.pid}); call wait-on again`);
  if (tail > 0) for (const l of readLines(o.log).slice(-tail)) d.out(l);
  return 3;
}

/** The documented long-job recipe, quoted by the worker contract and every deny message. */
export const WAIT_RECIPE =
  "`nohup sh -c 'CMD; echo $? > /tmp/job.rc' > /tmp/job.log 2>&1 & echo $! > /tmp/job.pid`, then repeat " +
  "`pai worker wait-on $(cat /tmp/job.pid) --log /tmp/job.log` (each call returns within 2 min; do other work between calls) until it exits 0";
