/**
 * run/lifecycle.ts — the one teardown of a run's process tree, shared by the claude and codex engines' signal and
 * failure paths (the normal path reaps in finaliseRun).
 */

import { reapWorkerProcesses } from "../reap.js";

/** End everything this run process spawned (and anything cwd'd in the worktree). Never throws. */
export async function reapRunTree(worktreeDir?: string): Promise<void> {
  await reapWorkerProcesses({ rootPid: process.pid, dir: worktreeDir });
}
