/**
 * preempt.ts — a `--now` run on a local provider goes first. The other local
 * workers on that provider are paused at once (reason "preempted by <id>", so
 * the router also aborts the request each has in flight and re-sends it on
 * resume), they stop counting against the provider's cap while paused, and
 * they resume exactly when the now run ends. Paused time is added to their
 * deadline (active-time.ts preemptedMsOf).
 */

import { getProviderOrNative, isLocalProvider, readWorkersSection } from "./config.js";
import { setWorkerPaused, setWorkerPriority } from "./engine-control.js";
import { appendLedger } from "./ledger.js";
import { ledgerPath } from "./paths.js";
import { isLive, loadStatuses, loadStatus, saveStatus, type WorkerStatus } from "./status.js";

/** An urgent worker still running or waiting on `provider`, other than `except`. */
function otherUrgent(statuses: WorkerStatus[], provider: string, except: string): WorkerStatus | undefined {
  return statuses.find((s) => s.id !== except && s.now && s.provider === provider && (s.state === "running" || s.state === "queued"));
}

/** Pause every other running, not yet paused worker on `provider` for the now run `by`; returns the ids paused. */
export function preemptLocal(logDir: string, provider: string, by: string, now = Date.now()): string[] {
  const paused: string[] = [];
  for (const s of loadStatuses(logDir)) {
    // urgent workers never pause each other: they share the engine's slots among themselves
    if (s.id === by || s.now || s.provider !== provider || s.state !== "running" || s.paused) continue;
    try {
      if (setWorkerPaused(logDir, s.id, true, `preempt:${by}`, by, now)) paused.push(s.id);
    } catch {
      /* ended meanwhile */
    }
  }
  return paused;
}

/**
 * Resume exactly the workers `by` paused; one the operator paused separately (pausedBy cleared) stays paused.
 * While another urgent worker still runs on the provider the victims stay paused, now preempted by that one.
 */
export function resumePreempted(logDir: string, by: string, now = Date.now()): string[] {
  const resumed: string[] = [];
  const all = loadStatuses(logDir);
  for (const s of all) {
    if (s.pausedBy !== by || !loadStatus(logDir, s.id)?.paused) continue;
    const next = otherUrgent(all, s.provider, by);
    if (next) {
      try {
        const cur = loadStatus(logDir, s.id);
        if (cur?.paused && cur.pausedBy === by) {
          cur.pausedBy = next.id;
          saveStatus(logDir, cur, new Date(now), true);
        }
      } catch {
        /* gone */
      }
      continue;
    }
    try {
      if (setWorkerPaused(logDir, s.id, false, `preempt:${by}`, undefined, now)) resumed.push(s.id);
    } catch {
      /* gone */
    }
  }
  return resumed;
}

/**
 * Make a worker urgent (`pai worker priority <id> now`): its engine requests go first and, on a
 * local provider, the other local workers pause. A queued worker's own gate sees the flag at its
 * next poll, goes to the front and preempts when it is admitted; a running one preempts here.
 * Returns the ids paused now.
 */
export function makeUrgent(logDir: string, id: string, local: boolean, who = "cli", now = Date.now()): string[] {
  const s = loadStatus(logDir, id);
  if (!s) throw new Error(`no worker named "${id}"`);
  if (s.state !== "running" && s.state !== "queued") throw new Error(`worker ${id} is ${s.state}; only a running or queued worker can be made urgent`);
  const from = s.priority ?? "normal";
  s.now = true;
  s.priority = "high";
  saveStatus(logDir, s, new Date(now), true);
  appendLedger(ledgerPath(logDir), "WORKER-PRIORITY", { who, id, from, to: "now" });
  return s.state === "running" && local ? preemptLocal(logDir, s.provider, id, now) : [];
}

export type PriorityLevel = "high" | "normal" | "low" | "now";

/** `pai worker priority <id> <level>` / worker_priority: "now" makes the worker urgent (makeUrgent); any other level ends its urgency. Returns the previous level and who was paused. */
export function applyPriority(logDir: string, id: string, level: PriorityLevel, who = "cli"): { from: string; paused: string[] } {
  const cur = loadStatus(logDir, id);
  if (!cur) throw new Error(`no worker named "${id}"`);
  if (level === "now") {
    const p = getProviderOrNative(readWorkersSection().workers, cur.provider);
    return { from: cur.now ? "now" : cur.priority ?? "normal", paused: makeUrgent(logDir, id, !!p && isLocalProvider(p.baseUrl), who) };
  }
  const wasNow = cur.now === true;
  const from = setWorkerPriority(logDir, id, level, who);
  if (wasNow) {
    const s = loadStatus(logDir, id);
    if (s) {
      delete s.now;
      saveStatus(logDir, s, new Date(), true);
    }
    resumePreempted(logDir, id);
  }
  return { from: wasNow ? "now" : from, paused: [] };
}

/**
 * Supervision sweep (daemon, every 30 s): a worker paused with "preempted by X" whose X is no longer
 * running (killed, crashed, never started) is resumed, or handed to another urgent worker still running
 * on its provider. Preemption always gives back what it took.
 */
export function resumeOrphaned(logDir: string, now = Date.now()): string[] {
  const all = loadStatuses(logDir);
  const resumed: string[] = [];
  for (const s of all) {
    if (!s.paused || !s.pausedBy) continue;
    const by = all.find((x) => x.id === s.pausedBy);
    if (by && isLive(by)) continue;
    const next = otherUrgent(all.filter((x) => isLive(x)), s.provider, s.pausedBy);
    try {
      if (next) {
        const cur = loadStatus(logDir, s.id);
        if (cur?.paused && cur.pausedBy === s.pausedBy) {
          cur.pausedBy = next.id;
          saveStatus(logDir, cur, new Date(now), true);
        }
      } else if (setWorkerPaused(logDir, s.id, false, `preempt:${s.pausedBy}`, undefined, now)) resumed.push(s.id);
    } catch {
      /* ended meanwhile */
    }
  }
  return resumed;
}
