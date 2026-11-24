/**
 * loop-stop.ts — the loop guard's hard stop, made independent of Claude Code.
 *
 * `"continue": false` from a PreToolUse hook does not end a headless
 * (`claude -p`) session, so the hook also leaves a marker the run's finalise
 * step reads (the worker then ends failed with reason "loop-stopped") and
 * signals the worker's own claude process.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { writeFileAtomic } from "../config/atomic-file.js";
import { join } from "node:path";
import { appendStopEvent } from "./endreason.js";
import { loadStatus, saveStatus } from "./status.js";
import { buildsDir, releaseBuildsOf } from "../builds/queue.js";
import { captureOnLoopStop } from "./proxy/loop-capture.js";
import { LOOP_CAPTURE_FLUSH_PATH } from "../router/router-loop-capture.js";
import { routerUrl } from "./run-env.js";

export const loopStopMarkerPath = (logDir: string, id: string): string => join(logDir, `${id}.loop-stop`);

/** The repeated call a loop stop names: tool, first chars of its command/input, repeat count, first chars of the result it kept getting. */
export interface LoopStopCall {
  tool: string;
  input: string;
  count: number;
  result: string;
}

export interface LoopStopMarker {
  ts: string;
  reason: string;
  call?: LoopStopCall;
}

export interface LoopStopDeps {
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Pid of the claude process the hook runs under; default: the hook's parent, skipping a wrapping shell. */
  claudePid?: () => number | undefined;
  /** Router base URL for the capture-flush notification; default: the loopback router. */
  routerBase?: () => string;
  /** The repeated call, carried into the marker for the L0 notice. */
  call?: LoopStopCall;
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
  const { kill = (pid, sig) => process.kill(pid, sig), claudePid = defaultClaudePid, routerBase = routerUrl, call } = deps;
  try {
    const m: LoopStopMarker = { ts: new Date().toISOString(), reason, ...(call ? { call } : {}) };
    writeFileAtomic(loopStopMarkerPath(logDir, id), JSON.stringify(m));
  } catch {
    // the signal below still ends the run
  }
  appendStopEvent(logDir, id, { killed_by: "loop-guard", forced: false, reason });
  // local runs: flush whatever this process still holds for this run (no-op when
  // the ring is empty, e.g. a cloud run or a different process)
  try {
    captureOnLoopStop(logDir, id, reason);
  } catch {
    // best effort
  }
  // the ring that matters lives in the router process, and a stopped worker never
  // sends the next request that would flush it: ask the router to write now
  notifyRouterLoopCapture(id, reason, routerBase);
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
  // a loop-stopped worker frees the machine-wide build lock and kills its build tree
  void releaseBuildsOf(buildsDir(), id).catch(() => []);
}

/**
 * Tell the router to flush this run's kept turns to the capture file now.
 * Fire-and-forget on the loopback router; never throws, never blocks the stop.
 */
function notifyRouterLoopCapture(id: string, reason: string, routerBase: () => string): void {
  try {
    const base = routerBase();
    if (!base) return;
    const req = fetch(`${base}${LOOP_CAPTURE_FLUSH_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, reason }),
      signal: AbortSignal.timeout(2000),
    });
    req.catch(() => {});
  } catch {
    // best effort
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
