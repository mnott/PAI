/**
 * waiting.ts — what a worker is waiting on, in the job's own words.
 *
 * `pai worker wait-on <pid>` records `waitingOn` in the worker's status; the
 * ps table, the follow pane (ticker, footer) and the transcript all render it
 * through waitingLine/detachedLine so the operator reads the job
 * ("tools/batch.sh --land …"), not the mechanism (a pid file).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { shortText } from "./args.js";

/** What `wait-on` writes into WorkerStatus.waitingOn. */
export interface WaitingOn {
  pid: number;
  /** Raw command line of the pid, captured when the wait began (survives its exit). */
  cmd: string;
  /** Epoch ms the pid started (ps lstart), null when unknown. */
  startedAt: number | null;
  log?: string | null;
}

/** A live process: its command line and start time; null from `proc` means gone. */
export interface ProcInfo {
  cmd: string;
  startedAt: number | null;
}

export interface WaitDeps {
  proc: (pid: number) => ProcInfo | null;
  /** Last non-empty line of a log file, "" when there is none. */
  logTail: (file: string) => string;
}

const PS_LINE = /^\s*(\w{3} \w{3}\s+\d+ [\d:]{8} \d{4})\s+(.*)$/;

export function realProc(pid: number): ProcInfo | null {
  try {
    const m = PS_LINE.exec(
      execFileSync("ps", ["-o", "lstart=", "-o", "command=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).split("\n")[0] ?? ""
    );
    if (!m) return null;
    const t = Date.parse(m[1]);
    return { cmd: m[2], startedAt: Number.isFinite(t) ? t : null };
  } catch {
    return null;
  }
}

export function lastLogLine(file: string): string {
  if (!file || !existsSync(file)) return "";
  try {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim()) return lines[i].trim();
  } catch {
    // unreadable log: show nothing
  }
  return "";
}

export const realWaitDeps: WaitDeps = { proc: realProc, logTail: lastLogLine };

/** `4m12s` — the runtime shape shared by the status row and the waiting line. */
export function fmtElapsed(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/**
 * The job behind a command line: strips `nohup`, the shell wrapper
 * (`sh -c '…'`), an interpreter prefix (`node`, `bash`) and the `; echo $? > rc`
 * trailer of the documented recipe, then shortens with an ellipsis at the end.
 */
export function shortCmd(raw: string, max = 50): string {
  let c = raw.trim();
  for (let prev = ""; prev !== c; ) {
    prev = c;
    c = c.replace(/^nohup\s+/, "").replace(/^(?:\/\S*\/)?(?:ba|z)?sh\s+(?:-\w+\s+)*/, "");
    c = c.replace(/^(["'])([\s\S]*)\1$/, "$2").trim();
  }
  c = c.replace(/\s*;\s*echo\s+\$\?\s*>.*$/, "").replace(/^(?:\/\S*\/)?(?:node|python3?)\s+/, "");
  return shortText(c, max);
}

/**
 * `waiting on: <cmd> · running 4m12s · log: <last line>` — running time is
 * the pid's own age (not the wait's), re-read at render time. A pid that is
 * gone (or was reused by another process) reads `· ended`.
 */
export function waitingLine(w: WaitingOn, now = Date.now(), d: WaitDeps = realWaitDeps, width = 50): string {
  const head = `waiting on: ${shortCmd(w.cmd, width)}`;
  const p = d.proc(w.pid);
  const reused = p && p.startedAt !== null && w.startedAt !== null && Math.abs(p.startedAt - w.startedAt) > 2000;
  if (!p || reused) return `${head} · ended`;
  const parts = [head];
  const since = w.startedAt ?? p.startedAt;
  if (since !== null) parts.push(`running ${fmtElapsed((now - since) / 1000)}`);
  const tail = w.log ? d.logTail(w.log) : "";
  if (tail) parts.push(`log: ${shortText(tail, 60)}`);
  return parts.join(" · ");
}

/** The pid and `--log` of a `pai worker wait-on` Bash command; the pid may be `$(cat file)`. */
export function parseWaitOn(
  command: string,
  readPid: (file: string) => number | null = (f) => {
    const n = Number(readFileOr(f).trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  }
): { pid: number | null; log: string | null } | null {
  const m = /\bpai\s+worker\s+wait-on\s+(?:(\d+)|"?\$\(cat\s+(\S+?)\)"?)(?:\s|$)/.exec(command);
  if (!m) return null;
  const log = /--log[ =](\S+)/.exec(command)?.[1] ?? null;
  return { pid: m[1] ? Number(m[1]) : readPid(m[2]), log };
}

function readFileOr(f: string): string {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return "";
  }
}

/** Transcript line for a Bash call that blocks in wait-on; null when `command` is not one. */
export function waitOnCallLine(command: string, now = Date.now(), d: WaitDeps = realWaitDeps, readPid?: (f: string) => number | null): string | null {
  const w = parseWaitOn(command, readPid);
  if (!w) return null;
  const p = w.pid !== null ? d.proc(w.pid) : null;
  if (w.pid === null || !p) return `waiting on: ${w.pid === null ? "a background job" : `pid ${w.pid}`} · ended`;
  return waitingLine({ pid: w.pid, cmd: p.cmd, startedAt: p.startedAt, log: w.log }, now, d);
}

/** Transcript line for a result of `wait-on`: `done (exit 7) after 6m03s`, or the still-running note. */
export function waitOnResultLine(text: string): string | null {
  const done = /^pid \d+ gone(?: after (\d+m\d+s))?(?:, exit code (\S+))?/.exec(text);
  if (done) return `done${done[2] !== undefined ? ` (exit ${done[2]})` : ""}${done[1] ? ` after ${done[1]}` : ""}`;
  const still = /^still running after (\S+) \(pid (\d+)\)/.exec(text);
  return still ? `still running after ${still[1]} (pid ${still[2]}), waiting again` : null;
}

/** `started in the background: <cmd>` for a Bash call that detaches a job (`nohup … &`); null otherwise. */
export function detachedLine(command: string): string | null {
  const m = /\bnohup\s+([\s\S]*?)(?:\s+>\s*\S+(?:\s+2>&1)?)?\s*(?<![>&])&(?![&\d])/.exec(command);
  return m ? `started in the background: ${shortCmd(m[1])}` : null;
}
