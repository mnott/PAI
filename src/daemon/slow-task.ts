/**
 * slow-task.ts — a periodic daemon task has a time budget on its synchronous part (the part that
 * blocks the event loop). Over budget logs `<iso> SLOW-TASK <name> sync=<ms> total=<ms>`; a task
 * that is slow only because it awaited is logged only past TASK_TOTAL_MS. Running task names are
 * kept so the stall monitor can name them (2026-10-25: 48k SLOW-TASK lines timed to the settle
 * could not tell a blocked loop from a task that waited).
 */

/** The default budget of a 30 s task's synchronous part, in ms. */
export const TASK_BUDGET_MS = 50;
/** A task whose total (sync + awaited) time exceeds this is logged even when its sync part is fast. */
export const TASK_TOTAL_MS = 60_000;

const running = new Map<string, number>();

/** Names of the daemon tasks running right now (sync part executing or awaiting). */
export function runningTasks(): string[] {
  return [...running.keys()];
}

export function slowTaskLine(name: string, syncMs: number, totalMs: number, at: Date = new Date()): string {
  return `${at.toISOString()} [pai-daemon] SLOW-TASK ${name} sync=${Math.round(syncMs)} total=${Math.round(totalMs)}\n`;
}

/** Run `fn`, timing its synchronous part and its total to settle. Returns fn's result. */
export function timedTask<T>(name: string, fn: () => T, budgetMs = TASK_BUDGET_MS, log: (line: string) => void = (l) => void process.stderr.write(l), now: () => number = performance.now.bind(performance)): T {
  const t0 = now();
  let sync = 0;
  running.set(name, (running.get(name) ?? 0) + 1);
  const done = (): void => {
    const n = (running.get(name) ?? 1) - 1;
    if (n <= 0) running.delete(name);
    else running.set(name, n);
    const total = now() - t0;
    if (sync > budgetMs || total > TASK_TOTAL_MS) log(slowTaskLine(name, sync, total));
  };
  let r: T;
  try {
    r = fn();
  } catch (e) {
    sync = now() - t0;
    done();
    throw e;
  }
  sync = now() - t0;
  if (r instanceof Promise) return r.finally(done) as T;
  done();
  return r;
}
