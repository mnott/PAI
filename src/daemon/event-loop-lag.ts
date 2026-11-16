/**
 * event-loop-lag.ts — the daemon's own event-loop lag, sampled continuously.
 *
 * "daemon down" and "daemon slow" looked identical: `pai daemon status` timed
 * out while a task held the loop, and the cockpit said the daemon was down
 * although its process was alive (2026-11: local-idle ran 34 s of wall time —
 * all awaited subprocess — while the daemon stayed responsive; a task that
 * blocks the loop for seconds makes every IPC call time out). The lag is the
 * one number that tells them apart: this histogram's p50/p99/max over the last
 * minute go into `status` and the cockpit, and slow-task.ts brackets each task
 * with the same sampler's max to say WHICH task held it.
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

/** The loop delay's max since the last reset (ms). */
export function loopDelayMaxMs(): number {
  return Math.round(hist.max / 1e6);
}

function snapshot(at: number): LoopLag {
  const p = (f: number): number => Math.round(hist.percentile(f) / 1e6);
  return { p50: p(0.5), p99: p(0.99), max: loopDelayMaxMs(), at };
}

/** The last rolled window's lag; null before startLoopLag (or after its stop). */
export function loopLag(): LoopLag | null {
  return current;
}

/**
 * Start sampling: every windowMs (60 s default) the histogram is snapshotted
 * into loopLag() and reset, so the numbers describe the last minute, not the
 * process lifetime. Returns a stop function; call once per daemon boot.
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
