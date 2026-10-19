/**
 * Hourly worker-worktree gc in the daemon: archives finished workers' worktrees
 * older than workers.gcOlderThanHours (default 6) and, over workers.worktreesMaxGb,
 * the oldest finished ones beyond that, salvaging ignored knowledge files first.
 * Cheap and safe, so quiet mode does not defer it.
 */

import { readWorkersSection } from "../workers/config.js";
import { workersLogDir } from "../workers/paths.js";
import { gcWorktreesThrottled } from "../workers/worktree.js";

export const WORKTREE_GC_TICK_MS = 60 * 60_000;
/** The throttle stamp is a little shorter than the tick so a tick is never skipped by jitter. */
const THROTTLE_MIN = 55;

export function runWorktreeGcHourly(): void {
  try {
    const { workers } = readWorkersSection();
    const res = gcWorktreesThrottled(workersLogDir(workers), THROTTLE_MIN, Date.now(), {
      olderThanHours: workers.gcOlderThanHours,
      maxGb: workers.worktreesMaxGb,
    });
    if (!res) return;
    const kept = res.filter((r) => r.skipped);
    process.stderr.write(
      `[pai-daemon] worktree gc: archived ${res.filter((r) => r.archive).length}, kept ${kept.length}` +
        (kept.length ? ` (${kept.map((r) => `${r.id}: ${r.skipped}`).join("; ")})` : "") +
        "\n"
    );
  } catch (e) {
    process.stderr.write(`[pai-daemon] worktree gc failed: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

/** Run the gc now and then every hour; returns the timer. */
export function startWorktreeGc(): ReturnType<typeof setInterval> {
  const first = setTimeout(runWorktreeGcHourly, 30_000);
  if (first.unref) first.unref();
  const timer = setInterval(runWorktreeGcHourly, WORKTREE_GC_TICK_MS);
  if (timer.unref) timer.unref();
  return timer;
}
