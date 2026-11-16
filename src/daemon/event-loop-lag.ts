/**
 * event-loop-lag.ts — the daemon's own event-loop lag, sampled continuously.
 *
 * "daemon down" and "daemon slow" looked identical: `pai daemon status` timed
 * out while a task held the loop, and the cockpit said the daemon was down
 * although its process was alive (2026-11: local-idle ran 34 s of wall time —
 * all awaited subprocess — while the daemon stayed responsive; a task that
 * blocks the loop for seconds makes every IPC call time out). The lag is the
 * one number that tells them apart, so one histogram (node's
 * monitorEventLoopDelay) is sampled here: its max is read live by slow-task.ts
 * to attribute a block to the running task, and p50/p99/max over the last
 * minute are exposed in `status` and the cockpit.
 */

import { monitorEventLoopDelay } from "node:perf_hooks";

/** Percentiles of the loop delay over the last window, ms. -1 = no samples yet. */
export interface LoopLag {
  p50: number;
  p99: number;
  max: number;
  /** epoch ms the window was last rolled (a fresh sample every intervalMs). */
  at: number;
}

const HIST_WINDOW_MS = 60_000;
const HIST_RESOLUTION_MS = 20;

const hist = monitorEventLoopDelay({ resolution: HIST_RESOLUTION_MS });

let current: LoopLag | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let enabled = false;

/** The loop delay's max since the last reset (ms) — slow-task.ts brackets a task with two of these reads; only meaningful once sampling is enabled. */
export function loopDelayMaxMs(): number {
  return Math.round(hist.max / 1e6);
}

/** Forget everything accumulated so far: the next read starts from an empty window. While sampling is off the histogram holds nothing, so a test that enables it itself calls this first. */
export function resetLoopDelay(): void {
  hist.reset();
}

function snapshot(at: number): LoopLag {
  const p = (f: number): number => Math.round(hist.percentile(f) / 1e6);
  return { p50: p(0.5), p99: p(0.99), max: loopDelayMaxMs(), at };
}

/** The last rolled window's lag; null before startLoopLag (or after stop). */
export function loopLag(): LoopLag | null {
  return current;
}

/**
 * Start sampling: every windowMs (60 s default) the histogram is snapshotted
 * into loopLag() and reset, so the numbers describe the last minute, not the
 * process lifetime. The same histogram feeds loopDelayMaxMs(), which stays
 * live between rolls. Returns a stop function; call once per daemon boot.
 */
export function startLoopLag(windowMs = HIST_WINDOW_MS): () => void {
  if (!enabled) {
    hist.enable();
    enabled = true;
  }
  const roll = (): void => {
    current = snapshot(Date.now());
    hist.reset();
  };
  // one sample right away so `status` answers with something from boot on
  roll();
  if (timer) clearInterval(timer);
  timer = setInterval(roll, windowMs);
  if (timer.unref) timer.unref();
  return () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    hist.disable();
    enabled = false;
    current = null;
  };
}
