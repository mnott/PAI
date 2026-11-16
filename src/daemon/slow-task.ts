/**
 * slow-task.ts — a periodic daemon task has a time budget. Wall time alone
 * cannot tell a task that blocks the event loop (the daemon goes unresponsive:
 * IPC calls time out, the cockpit says "daemon down") from one that merely
 * awaits a slow subprocess (local-idle ran 34 s of wall while the daemon kept
 * answering). So each run is measured on two axes: wall time to settle, and
 * the synchronous time it actually held the loop. Over budget logs
 * "SLOW-TASK <name> wall <ms> (blocked <ms>)", rate-limited to one line per
 * task per 10 min; a task that held the loop over budget always logs
 * "BLOCKED <name> <ms>" — that is the line worth reading every time.
 */

import { monitorEventLoopDelay } from "node:perf_hooks";

/** The default budget of a 30 s task, in ms. */
export const TASK_BUDGET_MS = 50;

/** A blocked run this long always logs, rate limit notwithstanding. */
export const ALWAYS_LOG_BLOCKED_MS = 1_000;

/** One wall-time line per task name per window, unless blocked past ALWAYS_LOG_BLOCKED_MS. */
export const SLOW_TASK_LOG_WINDOW_MS = 10 * 60_000;

/** The lag sampler's resolution: a block shorter than this cannot be attributed reliably. */
const SLICE_RESOLUTION_MS = 5;

/** How long after a task's settle its window may stay open for the delayed read (the sampler updates ~one tick late). */
const WINDOW_RELEASE_MS = SLICE_RESOLUTION_MS + 5;

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

/**
 * The daemon's event-loop-delay histogram, read once per task. node updates it
 * one tick LATE (measured on 22.16: a 300 ms sync block reads max 0 at the
 * task's settle; ~20 ms later it reads 300), so a single bracketing read sees
 * nothing of the block that just ended — flush() re-reads after that tick,
 * once every measurement has settled. event-loop-lag.ts's minute rolls need no
 * such fix: they happen long after any block settled.
 */
let taskHist: ReturnType<typeof monitorEventLoopDelay> | undefined;
function defaultLoopMaxMs(): number {
  if (!taskHist) {
    taskHist = monitorEventLoopDelay({ resolution: SLICE_RESOLUTION_MS });
    taskHist.enable();
  }
  const ms = Math.round(taskHist.max / 1e6);
  taskHist.reset();
  return ms;
}

/** How many timedTask measurements are open right now (exported for tests). */
export function openTaskCount(): number {
  return open;
}

let open = 0;

/** The measurement that currently owns the shared sampler, if any. */
let ownerRun: OwnerState | undefined;

interface OwnerState {
  /** what the sampler showed when the task settled (a just-ended block reads 0 there) */
  settleMax: number;
  /** the window is still open: a sync task's delayed read may complete it */
  holdOpen: boolean;
}

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
  return runMeasured(name, fn, budgetMs, { now, loopMaxMs: defaultLoopMaxMs, log }, defaultLimiter);
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
  open++;
  // This measurement owns the shared sampler only while it is the sole one
  // open: reset before fn runs, read at settle. A task that overlaps another
  // reads nothing (blocked 0) rather than blame two tasks for one delay.
  const owner = open === 1;
  const state: OwnerState | undefined = owner ? { settleMax: 0, holdOpen: true } : undefined;
  if (owner) {
    env.loopMaxMs(); // open this measurement's window
    ownerRun = state;
    // A sync task settles before the sampler's next update lands: keep its
    // window open one tick past settle so flush() sees the block. The awaited
    // case releases earlier — at the first continuation, via releaseOwner().
    setTimeout(() => {
      if (state && ownerRun === state && state.holdOpen) {
        state.settleMax = Math.max(state.settleMax, env.loopMaxMs());
        state.holdOpen = false;
      }
    }, WINDOW_RELEASE_MS).unref?.();
  }
  // the task's first continuation (its first await resolving): whatever delay
  // is visible by then belongs to this sole owner — what follows was awaited.
  const releaseOwner = (): void => {
    if (state && ownerRun === state && state.holdOpen) {
      state.settleMax = Math.max(state.settleMax, env.loopMaxMs());
      state.holdOpen = false;
    }
  };
  queueMicrotask(() => setTimeout(releaseOwner, WINDOW_RELEASE_MS).unref?.());
  const atSettle = (): void => {
    if (!state) return;
    state.settleMax = Math.max(state.settleMax, env.loopMaxMs());
    // holdOpen stays true only for a sync task (armed above); an awaited task
    // releases through releaseOwner on its first continuation.
  };
  let r: T;
  try {
    r = fn();
  } catch (e) {
    atSettle();
    settle(owner, state, name, t0, budgetMs, env, limiter);
    throw e;
  }
  if (r instanceof Promise) {
    return r.finally(() => {
      atSettle();
      settle(owner, state, name, t0, budgetMs, env, limiter);
    }) as T;
  }
  atSettle();
  settle(owner, state, name, t0, budgetMs, env, limiter);
  return r;
}

interface PendingLine { name: string; wall: number; state?: OwnerState; budgetMs: number; env: TaskTimingEnv; limiter: SlowTaskLimiter }
const pending: PendingLine[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function settle(owner: boolean, state: OwnerState | undefined, name: string, t0: number, budgetMs: number, env: TaskTimingEnv, limiter: SlowTaskLimiter): void {
  open--;
  if (owner && ownerRun === state) ownerRun = undefined;
  const wall = env.now() - t0;
  if (wall <= budgetMs) return; // under budget: no line, and nothing to read from the sampler
  pending.push({ name, wall, state, budgetMs, env, limiter });
  armFlush();
}

function armFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    // while a measurement is still open the sampler belongs to it: retry after
    // another tick instead of attributing its delay to tasks already done.
    if (open > 0) { armFlush(); return; }
    const batch = pending.splice(0, pending.length);
    // The histogram lags one tick behind the block it measured, and a task's
    // result can settle before that tick arrives: this read completes what the
    // settle reads could not yet see. Only ONE owner per batch can be credited
    // — the sampler is global and cannot be split retroactively — so a batch
    // with several owners (or none) attributes nothing; their wall lines still
    // show, with blocked 0: measured time, never a guess.
    const owners = batch.filter((p) => p.state);
    const late = owners.length === 1 ? owners[0]!.env.loopMaxMs() : 0;
    for (const p of batch) {
      const blocked = p.state && owners.length === 1 ? Math.max(p.state.settleMax, late) : (p.state?.settleMax ?? 0);
      if (blocked >= ALWAYS_LOG_BLOCKED_MS || p.limiter.allow(p.name, Date.now())) {
        p.env.log(slowTaskLine(p.name, p.wall, blocked, p.budgetMs));
      }
      if (blocked > p.budgetMs) p.env.log(blockedTaskLine(p.name, blocked, p.budgetMs));
    }
  }, WINDOW_RELEASE_MS);
  flushTimer.unref?.();
}
