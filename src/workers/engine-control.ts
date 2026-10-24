/**
 * engine-control.ts — priority and pause of a worker's requests to the local engine.
 *
 * The local model server decodes one request at a time, so the router's
 * scheduler (src/router/scheduler.ts) decides who goes next. Two per-worker
 * controls live in the worker's status file:
 *
 *   priority  high | normal | low   admission order at the engine
 *   paused    true                  the next request parks in the router
 *
 * `pai worker priority|pause|resume`, the MCP tools and the cockpit write them
 * here (one ledger line each); the router reads the CURRENT value for every
 * admission decision (readEngineControl), so a change applies to the next
 * request. Nothing is ever killed: a pause lets the request in flight finish.
 */

import { readFileSync, statSync } from "node:fs";
import { appendLedger } from "./ledger.js";
import { QUEUE_PRIORITIES, type QueuePriority } from "./config.js";
import { ledgerPath, statusPath } from "./paths.js";
import { loadStatus, saveStatus, type WorkerStatus } from "./status.js";

export type EnginePriority = QueuePriority;

export interface EngineControl {
  priority: EnginePriority;
  paused: boolean;
}

export const PRIORITY_EVENT = "WORKER-PRIORITY";
export const PAUSE_EVENT = "WORKER-PAUSE";
export const RESUME_EVENT = "WORKER-RESUME";

/** `high|normal|low`; anything else is an error, never a silent normal. */
export function parseEnginePriority(v: unknown): EnginePriority {
  if (!(QUEUE_PRIORITIES as readonly unknown[]).includes(v)) throw new Error(`priority must be high, normal or low (got ${String(v)})`);
  return v as EnginePriority;
}

function load(logDir: string, id: string): WorkerStatus {
  const s = loadStatus(logDir, id);
  if (!s) throw new Error(`no worker named "${id}"`);
  return s;
}

/** Change a worker's engine priority; effective from its next request. Returns the previous level. */
export function setWorkerPriority(logDir: string, id: string, level: EnginePriority, who = "cli"): EnginePriority {
  const status = load(logDir, id);
  const from = status.priority ?? "normal";
  status.priority = level;
  saveStatus(logDir, status, new Date(), true);
  appendLedger(ledgerPath(logDir), PRIORITY_EVENT, { who, id, from, to: level });
  return from;
}

/** Pause or resume a worker's engine requests. Returns false when it was already in that state. */
export function setWorkerPaused(logDir: string, id: string, paused: boolean, who = "cli"): boolean {
  const status = load(logDir, id);
  if (!!status.paused === paused) return false;
  if (paused && status.state !== "running" && status.state !== "queued") throw new Error(`worker ${id} is ${status.state}; only a running worker can be paused`);
  status.paused = paused;
  saveStatus(logDir, status, new Date(), true);
  appendLedger(ledgerPath(logDir), paused ? PAUSE_EVENT : RESUME_EVENT, { who, id, priority: status.priority ?? "normal" });
  return true;
}

/**
 * The router's reader: the worker's current controls from its status file,
 * re-parsed only when the file changed. An unknown or unreadable worker reads
 * as normal and not paused (fail open: the engine never stalls on a bad file);
 * `hint` is the priority the run announced in its x-pai-priority header.
 */
export function engineControlReader(logDir: () => string): (worker: string, hint?: EnginePriority) => EngineControl {
  const cache = new Map<string, { path: string; mtimeMs: number; size: number; control: Partial<EngineControl> }>();
  return (worker, hint) => {
    let c: Partial<EngineControl> = {};
    try {
      const path = statusPath(logDir(), worker);
      const st = statSync(path);
      const hit = cache.get(worker);
      if (hit && hit.path === path && hit.mtimeMs === st.mtimeMs && hit.size === st.size) c = hit.control;
      else {
        const j = JSON.parse(readFileSync(path, "utf8")) as Partial<WorkerStatus>;
        c = {
          ...((QUEUE_PRIORITIES as readonly unknown[]).includes(j.priority) ? { priority: j.priority } : {}),
          paused: j.paused === true && (j.state === "running" || j.state === "queued"),
        };
        cache.set(worker, { path, mtimeMs: st.mtimeMs, size: st.size, control: c });
      }
    } catch {
      /* no status for this id (a bare client): header hint or normal */
    }
    return { priority: c.priority ?? hint ?? "normal", paused: c.paused === true };
  };
}
