/**
 * wait-on.ts — bounded wait for a detached job, the worker alternative to a
 * long blocking foreground call (which starves operator messages and
 * supervision). Recipe: `nohup sh -c 'CMD; echo $? > $TMPDIR/job.rc' > $TMPDIR/job.log 2>&1 & echo $! > $TMPDIR/job.pid`,
 * then `pai worker wait-on $(cat $TMPDIR/job.pid) --log $TMPDIR/job.log` until exit 0.
 *
 * Exit codes: 0 pid gone, 3 still running at --max, 2 pid never existed or not ours,
 * 4 killed by the ceiling (--max-minutes) or the stall rule (--stall-minutes); a silent tree that is busy
 * (CPU time advancing, or an open loopback connection) is not stalled.
 * A `pai worker run` process (queued or running) is exempt from both: it has its own deadline; use `pai worker wait <id>`.
 */

import { parseStamp } from "./ledger.js";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { loadStatus, loadStatuses, pidAlive, saveStatus, statusPids, type WorkerStatus } from "./status.js";
import { fmtElapsed, realProc, type ProcInfo, type WaitingOn } from "./waiting.js";

export const WAIT_DEFAULT_SECS = 110;
export const WAIT_CAP_SECS = 590;
const POLL_MS = 2000;
const HEARTBEAT_MS = 20_000;
/** Slack between the first observation and a process start time (ps lstart has 1 s resolution). */
const REUSE_SLACK_MS = 2000;
export const WAIT_KILLED_EXIT = 4;
export const MAX_MINUTES_DEFAULT = 30;
export const STALL_MINUTES_DEFAULT = 5;
const KILL_GRACE_MS = 5000;

export interface WaitOnOpts {
  pid: number;
  log?: string;
  maxSecs?: number;
  tail?: number;
  /** Hard ceiling on the process's age; still alive then = kill its tree (default 30). */
  maxMinutes?: number;
  /** With a log: no growth for this long while alive = kill its tree (default 5). */
  stallMinutes?: number;
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
  /** Modification time (ms epoch) of a file, null when absent. */
  logMtime?: (file: string) => number | null;
  /** SIGTERM the pid and its descendants, SIGKILL the survivors after 5 s. */
  killTree?: (pid: number) => Promise<void>;
  /** Is the tree of pid doing work although silent: a descendant's CPU time advancing, or an open loopback TCP connection (a model/router request in flight)? */
  busy?: (pid: number) => Promise<{ busy: boolean; why: string }>;
  /** Worker status of the awaited pid: queued behind the provider cap (capacity gate) or not, and when it left the queue (ms epoch); null = not a worker. */
  queue?: (pid: number) => { queued: boolean; started: number | null; id?: string } | null;
}

/** A `queue` dep reading the worker status whose pid is the awaited one. */
export function statusQueue(logDir: string): NonNullable<WaitOnDeps["queue"]> {
  return (pid) => {
    const s = loadStatuses(logDir).find(
      (w) => (w.pid === pid || w.runPid === pid) && (w.state === "running" || w.state === "queued")
    );
    if (!s) return null;
    const t = parseStamp(s.started);
    // the state says it outright now; `capacity` stays for older status files
    return { queued: s.state === "queued" || !!s.capacity, started: Number.isFinite(t) ? t : null, id: s.id };
  };
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

/** `pid` followed by all its live descendants, parents first (from one `ps` snapshot). */
export function processTree(pid: number): number[] {
  let rows: string[] = [];
  try {
    rows = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }).split("\n");
  } catch {
    return [pid];
  }
  const kids = new Map<number, number[]>();
  for (const r of rows) {
    const [c, pp] = r.trim().split(/\s+/).map(Number);
    if (Number.isInteger(c) && Number.isInteger(pp)) kids.set(pp, [...(kids.get(pp) ?? []), c]);
  }
  const out = [pid];
  for (let i = 0; i < out.length; i++) out.push(...(kids.get(out[i]) ?? []).filter((k) => !out.includes(k)));
  return out;
}

/** `ps -o time=` ("M:SS.cc" or "H:MM:SS.cc") in seconds; NaN when unreadable. */
export function parseCpuTime(t: string): number {
  const parts = t.trim().split(":").map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return NaN;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function treeCpuSecs(tree: number[]): number {
  try {
    const rows = execFileSync("ps", ["-axo", "pid=,time="], { encoding: "utf8" }).split("\n");
    let sum = 0;
    for (const r of rows) {
      const [pid, time] = r.trim().split(/\s+/);
      if (tree.includes(Number(pid))) sum += parseCpuTime(time ?? "") || 0;
    }
    return sum;
  } catch {
    return 0;
  }
}

/** An ESTABLISHED TCP connection from the tree to a loopback address (the local model server or router). */
function treeLoopbackConn(tree: number[]): boolean {
  try {
    const out = execFileSync("lsof", ["-nP", "-a", "-p", tree.join(","), "-iTCP", "-sTCP:ESTABLISHED"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\n").some((l) => /->(127\.0\.0\.1|\[::1\]|localhost):\d+/.test(l));
  } catch {
    return false; // lsof exits 1 with no match
  }
}

/** A `pai worker run` client in the tree: the work runs in a pane under its own deadline, so the client itself is idle by design. */
function treeWorkerRun(tree: number[]): boolean {
  try {
    const rows = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n");
    return rows.some((r) => {
      const m = r.trim().match(/^(\d+)\s+(.*)$/);
      return !!m && tree.includes(Number(m[1])) && isWorkerRunCmd(m[2]);
    });
  } catch {
    return false;
  }
}

/**
 * A running or queued worker whose client, writer or wrapper-shell pid is in the tree. The command-line scan misses
 * a client that is not argv-visible as `pai worker run` (a wrapper, a renamed binary); the status files name it anyway.
 */
export function treeOwnsWorker(tree: number[], statuses: Pick<WorkerStatus, "pid" | "runPid" | "parentPid" | "state" | "pool">[]): boolean {
  return statuses.some((s) => (s.state === "running" || s.state === "queued") && statusPids(s).some((p) => tree.includes(p)));
}

/** Silent is not hung: a worker run client or a live worker owned by the tree, CPU time advanced over a one-second sample, or an open loopback connection. */
export async function treeBusy(pid: number, logDir?: string): Promise<{ busy: boolean; why: string }> {
  const tree = processTree(pid);
  if (treeWorkerRun(tree)) return { busy: true, why: "worker run in tree" };
  if (logDir && treeOwnsWorker(tree, loadStatuses(logDir))) return { busy: true, why: "live worker owned by tree" };
  const before = treeCpuSecs(tree);
  await new Promise((r) => setTimeout(r, 1000));
  const after = treeCpuSecs(processTree(pid));
  if (after > before) return { busy: true, why: `cpu +${Math.round((after - before) * 100) / 100}s` };
  if (treeLoopbackConn(tree)) return { busy: true, why: "open loopback connection" };
  return { busy: false, why: "no cpu, no i/o" };
}

const running = (pid: number): boolean => pidAlive(pid) && !isZombie(pid);

export async function killProcessTree(pid: number, graceMs = KILL_GRACE_MS): Promise<void> {
  const tree = processTree(pid);
  const send = (sig: NodeJS.Signals, pids: number[]) => {
    for (const p of pids) {
      try {
        process.kill(p, sig);
      } catch {
        /* gone between the snapshot and the signal */
      }
    }
  };
  send("SIGTERM", tree);
  const until = Date.now() + graceMs;
  while (Date.now() < until && tree.some(running)) await new Promise((r) => setTimeout(r, 100));
  send("SIGKILL", tree.filter(running));
}

export const realDeps: WaitOnDeps = {
  probe(pid) {
    // kill(0) succeeds on a zombie (exited, parent has not reaped it); that job is finished
    if (pidAlive(pid)) return isZombie(pid) ? "zombie" : "alive";
    return pidAlive(pid, { epermAlive: true }) ? "foreign" : "gone";
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
  logMtime(file) {
    try {
      return statSync(file).mtimeMs;
    } catch {
      return null;
    }
  },
  killTree: killProcessTree,
  busy: treeBusy,
};

const readLines = (file: string | undefined): string[] => {
  if (!file || !existsSync(file)) return [];
  const t = readFileSync(file, "utf8");
  return t === "" ? [] : t.replace(/\n$/, "").split("\n");
};

function rcOf(pid: number, log?: string): string | null {
  for (const f of [log && `${log}.rc`, log && log.replace(/\.[^./]+$/, ".rc")]) {
    if (f && existsSync(f)) return readFileSync(f, "utf8").trim();
  }
  return null;
}

/** A command line that is a `pai worker run` client. */
export const isWorkerRunCmd = (cmd: string): boolean => /(?:\bpai|\/dist\/cli\/index\.mjs)\s+worker\s+run\b/.test(cmd);

const fmtMinutes = (ms: number): string => `${Math.round((ms / 60_000) * 100) / 100}m`;

export async function waitOn(o: WaitOnOpts, d: WaitOnDeps = realDeps): Promise<number> {
  const maxMs = Math.min(o.maxSecs ?? WAIT_DEFAULT_SECS, WAIT_CAP_SECS) * 1000;
  const tail = o.tail ?? 20;
  const t0 = d.now();
  const ceilMs = (o.maxMinutes ?? MAX_MINUTES_DEFAULT) * 60_000;
  const stallMs = (o.stallMinutes ?? STALL_MINUTES_DEFAULT) * 60_000;
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
    let sayBusy = false;
    // The ceiling counts from the process start, so it holds across repeated wait-on calls.
    const born0 = ranSince ?? t0;
    // A `pai worker run` queued behind the provider cap is waiting, not hung: no stall kill, and the
    // ceiling counts from when it left the queue (the status `started` is rewritten then).
    let born = born0;
    let queued = false;
    // A worker has its own deadline and supervision; stall/ceiling rules are for builds and tests.
    let isWorker = false;
    const killed = async (why: string): Promise<number> => {
      await d.killTree?.(o.pid);
      d.out(`wait-on: pid ${o.pid} ${why}, killed process tree; likely hang or infinite loop`);
      if (tail > 0) for (const l of readLines(o.log).slice(-tail)) d.out(l);
      return WAIT_KILLED_EXIT;
    };
    while (d.now() - t0 < maxMs) {
      await d.sleep(Math.min(POLL_MS, Math.max(0, maxMs - (d.now() - t0))));
      const st = d.startTime(o.pid);
      if (d.probe(o.pid) !== "alive" || (st !== null && st > t0 + REUSE_SLACK_MS)) return finish();
      const q = d.queue?.(o.pid) ?? null;
      queued = q?.queued ?? false;
      if (!isWorker && (q || isWorkerRunCmd(p?.cmd ?? ""))) {
        isWorker = true;
        const id = q?.id ?? "<id>";
        d.out(`pid ${o.pid} is worker ${id}: waiting without stall/ceiling kill; prefer \`pai worker wait ${id}\``);
      }
      born = queued ? d.now() : Math.max(born0, q?.started ?? 0);
      if (queued || isWorker) {
        if (d.now() >= nextBeat) {
          d.out(`running ${Math.round((d.now() - t0) / 1000)}s, ${queued ? "worker queued behind the provider cap" : "worker running"}`);
          nextBeat += HEARTBEAT_MS;
        }
        continue;
      }
      if (d.now() - born >= ceilMs) return await killed(`still running after ${fmtMinutes(ceilMs)}`);
      const m = o.log ? d.logMtime?.(o.log) : null;
      if (m != null && d.now() - Math.max(m, born) >= stallMs) {
        const b = d.busy ? await d.busy(o.pid) : null;
        if (!b?.busy) return await killed(`no output for ${fmtMinutes(stallMs)}`);
        if (!sayBusy || d.now() >= nextBeat) {
          sayBusy = true;
          d.out(`running ${Math.round((d.now() - t0) / 1000)}s, silent but busy (${b.why}), not stalled`);
          nextBeat += HEARTBEAT_MS;
        }
        continue;
      }
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
  "`nohup sh -c 'CMD; echo $? > $TMPDIR/job.rc' > $TMPDIR/job.log 2>&1 & echo $! > $TMPDIR/job.pid`, then repeat " +
  "`pai worker wait-on $(cat $TMPDIR/job.pid) --log $TMPDIR/job.log` (each call returns within 2 min; do other work between calls) until it exits 0";

/** One line naming the bounded wait for each thing a worker can wait on; quoted by the contract and the tier-2 advice. */
export const WAIT_VERBS =
  "Waiting never needs sleep; use the verb for what you wait on (each returns within 110 s by default, --max up to 590, exit 0 = ready, 3 = not yet, call again): " +
  "child workers `pai worker wait <id...> [--max 100]` (returns when ANY finishes, one status line per id; drop finished ids on the next call); " +
  "a detached job `pai worker wait-on <pid> [--log f]`; a server `pai worker wait-url <url>`; files `pai worker wait-file <path...>`.";
