/**
 * Daily worker-worktree gc in the daemon's maintenance pass: archives finished
 * workers' worktrees older than 24 h, salvaging ignored knowledge files first.
 */

import { readWorkersSection } from "../workers/config.js";
import { workersLogDir } from "../workers/paths.js";
import { gcWorktreesThrottled } from "../workers/worktree.js";

const DAY_MIN = 24 * 60;

export function runWorktreeGcDaily(): void {
  try {
    const res = gcWorktreesThrottled(workersLogDir(readWorkersSection().workers), DAY_MIN - 60);
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
