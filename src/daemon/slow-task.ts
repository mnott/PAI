/**
 * slow-task.ts — a periodic daemon task has a time budget. Wall time alone
 * cannot tell a task that blocks the event loop (the daemon goes unresponsive:
 * IPC calls time out, the cockpit says "daemon down") from one that merely
 * awaits a slow subprocess (local-idle ran 34 s of wall while the daemon kept
 * answering). So each run is measured on two axes: wall time to settle, and
 * the synchronous time it held the loop, from node's event-loop-delay sampler
 * (its max over the run: a block longer than the resolution always shows up).
 * Over budget logs
 * "SLOW-TASK <name> wall <ms> (blocked <ms>)", rate-limited to one line per
 * task per 10 min; a task that held the loop over budget always logs
 * "BLOCKED <name> <ms>" — that is the line worth reading every time.
 */

import { loopDelayMaxMs } from "./event-loop-lag.js";

/** The default budget of a 30 s task, in ms. */
export const TASK_BUDGET_MS = 50;

/** A blocked run this long always logs, rate limit notwithstanding. */
export const ALWAYS_LOG_BLOCKED_MS = 1_000;

/** One wall-time line per task name per window, unless blocked past ALWAYS_LOG_BLOCKED_MS. */
export const SLOW_TASK_LOG_WINDOW_MS = 10 * 60_000;

export function slowTaskLine(name: string, wallMs: number, blockedMs: number, budgetMs: number): string {
  return `[pai-daemon] SLOW-TASK ${name} wall ${Math.round(wallMs)}ms (blocked ${Math.round(blockedMs)}ms) (budget ${budgetMs}ms)\n`;
}

export function blockedTaskLine(name: string, blockedMs: number, budgetMs: number): string {
  return `[pai-daemon] BLOCKED ${name} ${Math.round(blockedMs)}ms (budget ${budgetMs}ms)\n`;
}

/** What timedTask measures with: a clock, the lag sampler's max reader, and the log sink. */
export interface TaskTimingEnv {
  now: () => number;
  /** ms of event-loop delay since the last call reset the sampler (the histogram's max over the task). */
  loopMaxMs: () => number;
  log: (line: string) => void;
}

/** Coalesce repeated wall-time lines per name (BLOCKED lines are never rate-limited). */
export interface SlowTaskLimiter {
  /** true when a wall line for `name` may be logged now; records this one. */
  allow(name: string, atMs: number): boolean;
}

export function createSlowTaskLimiter(windowMs = SLOW_TASK_LOG_WINDOW_MS): SlowTaskLimiter {
  const lastAt = new Map<string, number>();
  return {
    allow(name, at) {
      const prev = lastAt.get(name);
      if (prev !== undefined && at - prev < windowMs) return false;
      lastAt.set(name, at);
      return true;
    },
  };
}

const defaultLimiter = createSlowTaskLimiter();

/** How many timedTask measurements are open right now (exported for tests). */
export function openTaskCount(): number {
  return open;
}

let open = 0;

/**
 * Run `fn`, timing it to its settle (sync or async). The blocked time is the
 * loop's max delay over the run, attributed to this task only while no other
 * measurement shares the sampler — two overlapping slow tasks cannot split one
 * global histogram, so an overlap reports 0 for the sampled part rather than
 * blaming both. Returns fn's result; a throw measures and logs like a settle.
 */
export function timedTask<T>(
  name: string,
  fn: () => T,
  budgetMs = TASK_BUDGET_MS,
  log: (line: string) => void = (l) => void process.stderr.write(l),
  now: () => number = performance.now.bind(performance)
): T {
  return runMeasured(name, fn, budgetMs, { now, loopMaxMs: loopDelayMaxMs, log }, defaultLimiter);
}

/** timedTask's machinery, fully injectable (tests pass their own timings). */
export function runMeasured<T>(
  name: string,
  fn: () => T,
  budgetMs: number,
  env: TaskTimingEnv,
  limiter: SlowTaskLimiter = defaultLimiter
): T {
  const t0 = env.now();
  // the loop-max window opens before fn runs and closes at settle; `open`
  // counts how many measurements overlap it
  const lagStart = env.loopMaxMs();
  open++;
  let r: T;
  try {
    r = fn();
  } catch (e) {
    finish(t0, name, budgetMs, lagStart, env, limiter);
    throw e;
  }
  if (r instanceof Promise) return r.finally(() => finish(t0, name, budgetMs, lagStart, env, limiter)) as T;
  finish(t0, name, budgetMs, lagStart, env, limiter);
  return r;
}

function finish(t0: number, name: string, budgetMs: number, lagStart: number, env: TaskTimingEnv, limiter: SlowTaskLimiter): void {
  open--;
  const wall = env.now() - t0;
  const lagEnd = env.loopMaxMs();
  // the loop's max over the task's window is this task's blocked time only
  // while no other measurement shares the sampler; an overlap reports 0 for
  // the sampled part — the wall line still shows, just with nothing to blame.
  const blocked = open === 0 ? Math.max(lagStart, lagEnd) : 0;
  if (wall > budgetMs) {
    if (blocked >= ALWAYS_LOG_BLOCKED_MS || limiter.allow(name, Date.now())) {
      env.log(slowTaskLine(name, wall, blocked, budgetMs));
    }
  }
  if (blocked > budgetMs) env.log(blockedTaskLine(name, blocked, budgetMs));
}
