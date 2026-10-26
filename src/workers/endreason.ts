/**
 * Who or what ended a worker. One place decides the reason; the runner's
 * signal handlers and the deadline record it, `pai worker kill` and the daemon
 * leave a kill-request marker (`<logDir>/<id>.kill`) before signalling so the
 * runner can tell their stops from an external one.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { writeFileAtomic } from "../config/atomic-file.js";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { eventsPath } from "./paths.js";
import { appendLedger } from "./ledger.js";
import { pidAlive } from "./status.js";

export type EndReason = "exit" | "deadline" | "loop-stopped" | "pai-worker-kill" | "parent-gone" | "external-signal" | "external" | "pane-closed" | "malformed-tool-call" | "degenerate-answer";

export interface EndInfo {
  reason: EndReason;
  by?: string;
  note?: string;
  /** The stated reason of a `pai worker kill`. */
  killReason?: string;
  forced?: boolean;
}

export interface KillRequest {
  ts: string;
  by: string;
  pid: number;
  ppid: number;
  cwd: string;
  forced?: boolean;
  reason?: string;
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
export function requestKill(logDir: string, ledger: string, id: string,
  by: string = callerDescription(),
  forced = false,
  reason?: string
): void {
  const req: KillRequest = {
    ts: new Date().toISOString(),
    by,
    pid: process.pid,
    ppid: process.ppid,
    cwd: process.cwd(),
    ...(forced ? { forced } : {}),
    ...(reason ? { reason } : {}),
  };
  writeFileAtomic(killMarkerPath(logDir, id), JSON.stringify(req));
  appendLedger(ledger, "WORKER-KILL", { id, by, pid: req.pid, ppid: req.ppid, cwd: req.cwd, ...(forced ? { forced: 1 } : {}), ...(reason ? { reason } : {}) });
}

function peekMarker(logDir: string, id: string): KillRequest | null {
  try {
    return JSON.parse(readFileSync(killMarkerPath(logDir, id), "utf8")) as KillRequest;
  } catch {
    return null;
  }
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

/** Command name of a pid (`ps -o comm=`), or undefined when it is gone or ps fails. */
export function commOf(pid: number): string | undefined {
  try {
    return execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** "pid:comm" for `start` and its ancestors (one ps call per hop, at most 12), so an unattributed signal names who the runner hung under. */
export function ppidChain(start: number = process.pid, hops = 12): string {
  const out: string[] = [];
  let pid = start;
  for (let i = 0; i < hops && pid > 0; i++) {
    try {
      const row = execFileSync("ps", ["-o", "ppid=,tty=,comm=", "-p", String(pid)], { encoding: "utf8" }).trim().split(/\s+/);
      if (row.length < 3) break;
      out.push(`${pid}:${row.slice(2).join(" ").split("/").pop()}@${row[1]}`);
      pid = Number(row[0]);
    } catch {
      break;
    }
  }
  return out.join(" < ");
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
  loopStopped?: boolean;
  parentPid?: number;
  parentComm?: string;
  parentBackground?: boolean;
  /** Signal that ended the claude child while the runner itself got none. */
  childSignal?: string;
  isAlive?: (pid: number) => boolean;
  /** Ancestor chain of the runner, injected by tests. */
  chain?: () => string;
}): EndInfo {
  if (a.timedOut) return { reason: "deadline" };
  if (a.loopStopped) return { reason: "loop-stopped" };
  // a stop PAI made by SIGKILL of the child group (pane audit) leaves a marker but no signal reaches the runner
  const marker = a.signal || peekMarker(a.logDir, a.id)?.by === "pane audit" ? readMarker(a.logDir, a.id) : null;
  const chain = () => (a.chain ?? (() => ppidChain()))();
  if (!a.signal && !marker && a.childSignal) {
    return { reason: "external", by: "external", note: `child ended by ${a.childSignal} with no PAI kill request; sender unknown; runner chain ${chain()}` };
  }
  if (!a.signal && !marker) return { reason: "exit" };
  if (!a.signal && marker) {
    return { reason: "pai-worker-kill", by: marker.by, note: `killed by ${marker.by}${marker.reason ? `: ${marker.reason}` : ""}`, ...(marker.reason ? { killReason: marker.reason } : {}), forced: true };
  }
  if (marker) {
    return {
      reason: "pai-worker-kill",
      by: marker.by,
      note: `${a.signal} requested by pid ${marker.pid}${marker.forced ? " (forced)" : ""}${marker.reason ? `: ${marker.reason}` : ""}`,
      ...(marker.reason ? { killReason: marker.reason } : {}),
      ...(marker.forced ? { forced: true } : {}),
    };
  }
  // a closed pane/terminal delivers SIGHUP to the foreground group; nothing in PAI sends it to a worker
  if (a.signal === "SIGHUP") {
    return { reason: "pane-closed", by: "pane-closed", note: `SIGHUP: the worker's pane or terminal was closed; runner chain ${chain()}` };
  }
  const alive = (a.isAlive ?? ((p: number) => pidAlive(p, { epermAlive: true })))(a.parentPid ?? process.ppid);
  const parent = `parent ${a.parentPid ?? "?"}${a.parentComm ? ` (${a.parentComm})` : ""}`;
  if (!alive) return { reason: "parent-gone", by: "external", note: `${a.signal}; ${parent} not alive; runner chain ${chain()}` };
  return {
    reason: "external-signal",
    by: "external",
    note:
      `${a.signal}; sender unknown (not deadline, not pai worker kill); a Claude Code background task stop ` +
      `(TaskStop, Bash timeout, session end) is the usual source; ${parent} alive` +
      (a.parentBackground ? "; started from a Claude Code session" : "") +
      `; runner chain ${chain()}`,
  };
}

/** The status/ledger fields for an end. */
export function endFields(e: EndInfo): { reason: EndReason; by?: string } {
  return { reason: e.reason, ...(e.by ? { by: e.by } : {}) };
}

/** "external-signal", "pai-worker-kill by <caller>" for a finished worker; null when nothing was recorded. */
export function endLabel(s: { endReason?: string; endBy?: string; endKillReason?: string; endForced?: boolean }): string | null {
  if (!s.endReason) return null;
  if (s.endReason === "malformed-tool-call") return "instrument: malformed tool call";
  if (s.endReason === "degenerate-answer") return "instrument: degenerate answer";
  return `${s.endReason}${s.endBy ? ` by ${s.endBy}` : ""}${s.endForced ? " (forced)" : ""}${s.endKillReason ? `: ${s.endKillReason}` : ""}`;
}

export interface StopRecord {
  killed_by: string;
  forced: boolean;
  reason: string;
}

/** Final event in the worker's own event log (what `pai worker replay` and the owner read). Never throws. */
export function appendStopEvent(logDir: string, id: string, stop: StopRecord): void {
  try {
    appendFileSync(eventsPath(logDir, id), JSON.stringify({ type: "worker-stopped", ...stop, _ts: new Date().toISOString() }) + "\n");
  } catch {
    /* the log is gone; the ledger line stays */
  }
}
