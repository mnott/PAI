/**
 * loop-stop.ts — the loop guard's hard stop, made independent of Claude Code.
 *
 * `"continue": false` from a PreToolUse hook does not end a headless
 * (`claude -p`) session, so the hook also leaves a marker the run's finalise
 * step reads (the worker then ends failed with reason "loop-stopped") and
 * signals the worker's own claude process.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadStatus, saveStatus } from "./status.js";

export const loopStopMarkerPath = (logDir: string, id: string): string => join(logDir, `${id}.loop-stop`);

export interface LoopStopMarker {
  ts: string;
  reason: string;
}

export interface LoopStopDeps {
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Pid of the claude process the hook runs under; default: the hook's parent, skipping a wrapping shell. */
  claudePid?: () => number | undefined;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);

function psField(pid: number, field: "comm" | "ppid"): string | undefined {
  try {
    return execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The hook's parent, or its parent's parent when the hook was started through a shell. */
export function defaultClaudePid(): number | undefined {
  let pid = process.ppid;
  const comm = psField(pid, "comm")?.split("/").pop() ?? "";
  if (SHELLS.has(comm.replace(/^-/, ""))) {
    const up = Number(psField(pid, "ppid"));
    if (up > 1) pid = up;
  }
  return pid > 1 ? pid : undefined;
}

/** Mark the worker loop-stopped (marker file + status note) and SIGTERM its claude process. Never throws. */
export function requestLoopStop(logDir: string, id: string, reason: string, deps: LoopStopDeps = {}): void {
  const { kill = (pid, sig) => process.kill(pid, sig), claudePid = defaultClaudePid } = deps;
  try {
    const m: LoopStopMarker = { ts: new Date().toISOString(), reason };
    writeFileSync(loopStopMarkerPath(logDir, id), JSON.stringify(m));
  } catch {
    // the signal below still ends the run
  }
  try {
    const st = loadStatus(logDir, id);
    if (st && st.state === "running") saveStatus(logDir, { ...st, last: `loop-stopped: ${reason}` });
  } catch {
    // best effort
  }
  try {
    const pid = claudePid();
    if (pid) kill(pid, "SIGTERM");
  } catch {
    // process already gone
  }
}

/** The marker of a loop-stopped worker, consumed on read; null when there is none. */
export function takeLoopStop(logDir: string, id: string): LoopStopMarker | null {
  const p = loopStopMarkerPath(logDir, id);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as LoopStopMarker;
  } catch {
    return { ts: "", reason: "loop guard" };
  } finally {
    try {
      unlinkSync(p);
    } catch {
      // already gone
    }
  }
}

/** The marker without consuming it. */
export function peekLoopStop(logDir: string, id: string): LoopStopMarker | null {
  const p = loopStopMarkerPath(logDir, id);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as LoopStopMarker;
  } catch {
    return { ts: "", reason: "loop guard" };
  }
}
