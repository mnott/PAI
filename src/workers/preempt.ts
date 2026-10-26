/**
 * preempt.ts — a `--now` run on a local provider goes first. The other local
 * workers on that provider are paused at once (reason "preempted by <id>", so
 * the router also aborts the request each has in flight and re-sends it on
 * resume), they stop counting against the provider's cap while paused, and
 * they resume exactly when the now run ends. Paused time is added to their
 * deadline (active-time.ts preemptedMsOf).
 */

import { setWorkerPaused } from "./engine-control.js";
import { loadStatuses, loadStatus } from "./status.js";

/** Pause every other running, not yet paused worker on `provider` for the now run `by`; returns the ids paused. */
export function preemptLocal(logDir: string, provider: string, by: string, now = Date.now()): string[] {
  const paused: string[] = [];
  for (const s of loadStatuses(logDir)) {
    if (s.id === by || s.provider !== provider || s.state !== "running" || s.paused) continue;
    try {
      if (setWorkerPaused(logDir, s.id, true, `preempt:${by}`, by, now)) paused.push(s.id);
    } catch {
      /* ended meanwhile */
    }
  }
  return paused;
}

/** Resume exactly the workers `by` paused; one the operator paused separately (pausedBy cleared) stays paused. */
export function resumePreempted(logDir: string, by: string, now = Date.now()): string[] {
  const resumed: string[] = [];
  for (const s of loadStatuses(logDir)) {
    if (s.pausedBy !== by || !loadStatus(logDir, s.id)?.paused) continue;
    try {
      if (setWorkerPaused(logDir, s.id, false, `preempt:${by}`, undefined, now)) resumed.push(s.id);
    } catch {
      /* gone */
    }
  }
  return resumed;
}
