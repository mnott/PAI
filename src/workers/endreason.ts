/**
 * Who or what ended a worker. One place decides the reason; the runner's
 * signal handlers and the deadline record it, `pai worker kill` and the daemon
 * leave a kill-request marker (`<logDir>/<id>.kill`) before signalling so the
 * runner can tell their stops from an external one.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendLedger } from "./ledger.js";

export type EndReason = "exit" | "deadline" | "pai-worker-kill" | "parent-gone" | "external-signal";

export interface EndInfo {
  reason: EndReason;
  by?: string;
  note?: string;
}

export interface KillRequest {
  ts: string;
  by: string;
  pid: number;
  ppid: number;
  cwd: string;
}

export const killMarkerPath = (logDir: string, id: string): string => join(logDir, `${id}.kill`);

/** Best description of the invoking session: PAI parent/AIBroker session env, else the Claude Code session id. */
export function callerDescription(env: NodeJS.ProcessEnv = process.env): string {
  const name =
    env.PAI_WORKER_PARENT ?? env.PAI_SESSION_NAME ?? env.AIBROKER_SESSION_NAME ?? env.AIBROKER_SESSION;
  if (name) return name;
  if (env.CLAUDE_CODE_SESSION_ID) return `claude-session:${env.CLAUDE_CODE_SESSION_ID}`;
  return env.CLAUDECODE ? "claude-code" : "shell";
}

/** Write the kill-request marker and the WORKER-KILL ledger line; call right before signalling. */
export function requestKill(logDir: string, ledger: string, id: string, by: string = callerDescription()): void {
  const req: KillRequest = {
    ts: new Date().toISOString(),
    by,
    pid: process.pid,
    ppid: process.ppid,
    cwd: process.cwd(),
  };
  writeFileSync(killMarkerPath(logDir, id), JSON.stringify(req));
  appendLedger(ledger, "WORKER-KILL", { id, by, pid: req.pid, ppid: req.ppid, cwd: req.cwd });
}

function readMarker(logDir: string, id: string): KillRequest | null {
  const p = killMarkerPath(logDir, id);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as KillRequest;
  } catch {
    return { ts: "", by: "unknown", pid: 0, ppid: 0, cwd: "" };
  } finally {
    try {
      unlinkSync(p);
    } catch {
      /* already gone */
    }
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Command name of a pid (`ps -o comm=`), or undefined when it is gone or ps fails. */
export function commOf(pid: number): string | undefined {
  try {
    return execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Parent facts recorded at start, for the end report ("parent: claude"). */
export function parentInfo(): { parentPid: number; parentComm?: string; parentBackground?: boolean } {
  const parentPid = process.ppid;
  return {
    parentPid,
    parentComm: commOf(parentPid),
    // a Claude Code Bash task carries CLAUDECODE; the runner strips it from children only
    parentBackground: process.env.CLAUDECODE ? true : undefined,
  };
}

/**
 * The single decision. `signal` = the signal the runner received (absent for a
 * deadline stop or a normal exit); `timedOut` = the deadline fired. Reads (and
 * consumes) the kill marker.
 */
export function decideEndReason(a: {
  logDir: string;
  id: string;
  signal?: string;
  timedOut?: boolean;
  parentPid?: number;
  parentComm?: string;
  parentBackground?: boolean;
  isAlive?: (pid: number) => boolean;
}): EndInfo {
  if (a.timedOut) return { reason: "deadline" };
  if (!a.signal) return { reason: "exit" };
  const marker = readMarker(a.logDir, a.id);
  if (marker) return { reason: "pai-worker-kill", by: marker.by, note: `${a.signal} requested by pid ${marker.pid}` };
  const alive = (a.isAlive ?? pidAlive)(a.parentPid ?? process.ppid);
  const parent = `parent ${a.parentPid ?? "?"}${a.parentComm ? ` (${a.parentComm})` : ""}`;
  if (!alive) return { reason: "parent-gone", note: `${a.signal}; ${parent} not alive` };
  return {
    reason: "external-signal",
    note:
      `${a.signal}; sender unknown (not deadline, not pai worker kill); a Claude Code background task stop ` +
      `(TaskStop, Bash timeout, session end) is the usual source; ${parent} alive` +
      (a.parentBackground ? "; started from a Claude Code session" : ""),
  };
}

/** The status/ledger fields for an end. */
export function endFields(e: EndInfo): { reason: EndReason; by?: string } {
  return { reason: e.reason, ...(e.by ? { by: e.by } : {}) };
}

/** "external-signal", "pai-worker-kill by <caller>" for a finished worker; null when nothing was recorded. */
export function endLabel(s: { endReason?: string; endBy?: string }): string | null {
  return s.endReason ? `${s.endReason}${s.endBy ? ` by ${s.endBy}` : ""}` : null;
}
