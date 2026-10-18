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
import { loadStatus, saveStatus } from "./status.js";
import { fmtElapsed, realProc, type ProcInfo, type WaitingOn } from "./waiting.js";

export const WAIT_DEFAULT_SECS = 110;
export const WAIT_CAP_SECS = 590;
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
  /** "alive" | "gone" | "foreign" (exists, not ours) | "zombie" (exited, not yet reaped by its parent: finished). */
  probe: (pid: number) => "alive" | "gone" | "foreign" | "zombie";
  /** Process start time in ms epoch, null when unknown. */
  startTime: (pid: number) => number | null;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  out: (line: string) => void;
  /** Command line + start of the awaited pid; absent = not recorded. */
  proc?: (pid: number) => ProcInfo | null;
  /** Record (or, with null, clear) what this worker waits on in its status. */
  mark?: (w: WaitingOn | null) => void;
}

/** A `mark` that writes `waitingOn` into worker `id`'s status file; a no-op for an unknown id. */
export function statusMarker(logDir: string, id: string): (w: WaitingOn | null) => void {
  return (w) => {
    const s = loadStatus(logDir, id);
    if (!s) return;
    s.waitingOn = w;
    saveStatus(logDir, s);
  };
}

function isZombie(pid: number): boolean {
  try {
    return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z");
  } catch {
    return false;
  }
}

export const realDeps: WaitOnDeps = {
  probe(pid) {
    try {
      process.kill(pid, 0);
      // kill(0) succeeds on a zombie (exited, parent has not reaped it); that job is finished
      return isZombie(pid) ? "zombie" : "alive";
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM" ? "foreign" : "gone";
    }
  },
  startTime(pid) {
    try {
      const t = Date.parse(execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim());
      return Number.isFinite(t) ? t : null;
    } catch {
      return null;
    }
  },
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  out: (l) => console.log(l),
  proc: realProc,
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

  let ranSince: number | null = null;
  const finish = (): number => {
    const rc = rcOf(o.pid, o.log);
    const after = ranSince !== null ? ` after ${fmtElapsed((d.now() - ranSince) / 1000)}` : "";
    d.out(`pid ${o.pid} gone${after}${rc !== null ? `, exit code ${rc}` : ""}`);
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
  if (first === "zombie") return finish();
  if (first === "gone") {
    // A job that finished between two wait-on calls leaves an rc or a log; neither means the pid never existed.
    if (rcOf(o.pid, o.log) !== null || (o.log && existsSync(o.log))) return finish();
    d.out(`wait-on: pid ${o.pid} does not exist`);
    return 2;
  }

  const p = d.proc?.(o.pid) ?? null;
  ranSince = p?.startedAt ?? null;
  d.mark?.({ pid: o.pid, cmd: p?.cmd ?? "", startedAt: p?.startedAt ?? null, log: o.log ?? null });
  try {
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
  } finally {
    d.mark?.(null);
  }
}

/** The documented long-job recipe, quoted by the worker contract and every deny message. */
export const WAIT_RECIPE =
  "`nohup sh -c 'CMD; echo $? > /tmp/job.rc' > /tmp/job.log 2>&1 & echo $! > /tmp/job.pid`, then repeat " +
  "`pai worker wait-on $(cat /tmp/job.pid) --log /tmp/job.log` (each call returns within 2 min; do other work between calls) until it exits 0";

/** One line naming the bounded wait for each thing a worker can wait on; quoted by the contract and the tier-2 advice. */
export const WAIT_VERBS =
  "Waiting never needs sleep; use the verb for what you wait on (each returns within 110 s by default, --max up to 590, exit 0 = ready, 3 = not yet, call again): " +
  "child workers `pai worker wait <id...> [--max 100]` (returns when ANY finishes, one status line per id; drop finished ids on the next call); " +
  "a detached job `pai worker wait-on <pid> [--log f]`; a server `pai worker wait-url <url>`; files `pai worker wait-file <path...>`.";
