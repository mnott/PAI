/**
 * slow-task.ts — a periodic daemon task has a time budget. Wall time alone
 * cannot tell a task that blocks the event loop (the daemon goes unresponsive:
 * IPC calls time out, the cockpit says "daemon down") from one that merely
 * awaits a slow subprocess (local-idle ran 34 s of wall while the daemon kept
 * answering). Each run is measured on two axes: wall time to settle, and the
 * time it actually held the loop:
 *   - the first synchronous slice is exact (start until fn() returns, i.e. the
 *     first await);
 *   - later slices are seen by a timer chain that runs while a task is open: a
 *     tick that fires late means something held the loop. That lag is credited
 *     to the task only when it is the sole open one (two overlapping tasks
 *     cannot split one delay, so an overlap credits neither).
 * Over budget logs "SLOW-TASK <name> wall <ms> (blocked <ms>)", at most once
 * per task per 10 min unless blocked >= 1 s; blocked over budget always logs
 * "BLOCKED <name> <ms>".
 */

/** The default budget of a 30 s task, in ms. */
export const TASK_BUDGET_MS = 50;

/** A blocked run this long always logs, rate limit notwithstanding. */
export const ALWAYS_LOG_BLOCKED_MS = 1_000;

/** One wall-time line per task name per window, unless blocked past ALWAYS_LOG_BLOCKED_MS. */
export const SLOW_TASK_LOG_WINDOW_MS = 10 * 60_000;

/** Tick period of the continuation sampler. */
const TICK_MS = 10;

export function slowTaskLine(name: string, wallMs: number, blockedMs: number, budgetMs: number): string {
  return `[pai-daemon] SLOW-TASK ${name} wall ${Math.round(wallMs)}ms (blocked ${Math.round(blockedMs)}ms) (budget ${budgetMs}ms)\n`;
}

export function blockedTaskLine(name: string, blockedMs: number, budgetMs: number): string {
  return `[pai-daemon] BLOCKED ${name} ${Math.round(blockedMs)}ms (budget ${budgetMs}ms)\n`;
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

interface Run {
  name: string;
  /** longest stretch this run is credited with holding the loop */
  blocked: number;
}

const openRuns = new Set<Run>();
let tickTimer: ReturnType<typeof setTimeout> | undefined;
let expectedAt = 0;

/** Names of the tasks running right now (the event-loop watchdog reports them when the loop stalls). */
export function openTaskNames(): string[] {
  return [...openRuns].map((r) => r.name);
}

/** Called whenever a task opens (the watchdog sends a fresh heartbeat naming it before the task can block). */
let onOpen: (() => void) | undefined;
export function setTaskOpenListener(fn: (() => void) | undefined): void {
  onOpen = fn;
}

/** Credit the loop's overshoot since the last expected tick to the sole open run. */
function creditLag(nowMs: number): void {
  if (openRuns.size !== 1 || !tickTimer) return;
  const lag = nowMs - expectedAt;
  const run = openRuns.values().next().value as Run;
  if (lag > run.blocked) run.blocked = lag;
}

function armTick(): void {
  if (tickTimer) return;
  expectedAt = performance.now() + TICK_MS;
  tickTimer = setTimeout(() => {
    creditLag(performance.now());
    tickTimer = undefined;
    if (openRuns.size > 0) armTick();
  }, TICK_MS);
  tickTimer.unref?.();
}

/**
 * Run `fn`, timing it to its settle (sync or async). Returns fn's result; a
 * throw measures and logs like a settle.
 */
export function timedTask<T>(
  name: string,
  fn: () => T,
  budgetMs = TASK_BUDGET_MS,
  log: (line: string) => void = (l) => void process.stderr.write(l),
  now: () => number = performance.now.bind(performance),
  limiter: SlowTaskLimiter = defaultLimiter
): T {
  const t0 = now();
  const run: Run = { name, blocked: 0 };
  // a tick armed by an earlier run may already be overdue: its lag is not ours
  if (tickTimer) { clearTimeout(tickTimer); tickTimer = undefined; }
  openRuns.add(run);
  onOpen?.();
  armTick();
  const done = (): void => {
    creditLag(performance.now()); // a block just before settle: the next tick has not fired yet
    openRuns.delete(run);
    const wall = now() - t0;
    if (wall <= budgetMs) return;
    if (run.blocked >= ALWAYS_LOG_BLOCKED_MS || limiter.allow(name, Date.now())) {
      log(slowTaskLine(name, wall, run.blocked, budgetMs));
    }
    if (run.blocked > budgetMs) log(blockedTaskLine(name, run.blocked, budgetMs));
  };
  let r: T;
  try {
    r = fn();
  } catch (e) {
    run.blocked = Math.max(run.blocked, now() - t0);
    done();
    throw e;
  }
  // the first synchronous slice ran from t0 to here, exactly
  run.blocked = Math.max(run.blocked, now() - t0);
  if (r instanceof Promise) return r.finally(done) as T;
  done();
  return r;
}
