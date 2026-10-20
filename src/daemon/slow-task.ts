/**
 * slow-task.ts — a periodic daemon task has a time budget. A task that runs over it logs
 * SLOW-TASK <name> <ms> so a task that quietly starts parsing too much shows up in the log
 * (2026-10-20: the daemon sat at 100 % CPU and no log line said which task).
 */

/** The default budget of a 30 s task, in ms. */
export const TASK_BUDGET_MS = 50;

export function slowTaskLine(name: string, ms: number, budgetMs: number): string {
  return `[pai-daemon] SLOW-TASK ${name} ${Math.round(ms)}ms (budget ${budgetMs}ms)\n`;
}

/** Run `fn`, timing it to its settle (sync or async); over budget logs SLOW-TASK. Returns fn's result. */
export function timedTask<T>(name: string, fn: () => T, budgetMs = TASK_BUDGET_MS, log: (line: string) => void = (l) => void process.stderr.write(l), now: () => number = performance.now.bind(performance)): T {
  const t0 = now();
  const done = (): void => {
    const ms = now() - t0;
    if (ms > budgetMs) log(slowTaskLine(name, ms, budgetMs));
  };
  let r: T;
  try {
    r = fn();
  } catch (e) {
    done();
    throw e;
  }
  if (r instanceof Promise) return r.finally(done) as T;
  done();
  return r;
}
