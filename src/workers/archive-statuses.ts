/**
 * archive-statuses.ts — keep the live logs/workers directory small.
 *
 * Every status read lists the directory, so thousands of finished workers' files
 * slow every reader. Terminal statuses older than a week move, with their sibling
 * files (`<id>.*`), into archive/YYYY-MM/. Anything still owed to the operator
 * stays: a worker whose worktree or branch still exists is what `pai worker
 * pending` would list (or is about to), so it is never moved.
 */

import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { git } from "./worktree.js";
import { isTerminal, loadStatuses, type WorkerStatus } from "./status.js";

export const ARCHIVE_AFTER_MS = 7 * 24 * 3_600_000;

function branchAlive(st: WorkerStatus): boolean {
  if (!st.branch || !st.cwd || !existsSync(st.cwd)) return false;
  try {
    git(st.cwd, ["rev-parse", "--verify", "-q", `refs/heads/${st.branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** Move old finished workers' files into archive/YYYY-MM/; returns the archived ids. `dryRun` only reports. */
export function archiveOldStatuses(
  logDir: string,
  now = Date.now(),
  opts: { dryRun?: boolean; olderThanMs?: number } = {}
): string[] {
  const cutoff = now - (opts.olderThanMs ?? ARCHIVE_AFTER_MS);
  const candidates: { st: WorkerStatus; mtime: number }[] = [];
  for (const st of loadStatuses(logDir)) {
    if (!isTerminal(st.state)) continue;
    let mtime: number;
    try {
      mtime = statSync(join(logDir, `${st.id}.status`)).mtimeMs;
    } catch {
      continue;
    }
    if (mtime >= cutoff) continue;
    candidates.push({ st, mtime });
  }
  if (!candidates.length) return [];
  const names = readdirSync(logDir);
  const moved: string[] = [];
  for (const { st, mtime } of candidates) {
    if (st.worktreeDir && existsSync(st.worktreeDir)) continue;
    if (branchAlive(st)) continue;
    moved.push(st.id);
    if (opts.dryRun) continue;
    const d = new Date(mtime);
    const dest = join(logDir, "archive", `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    mkdirSync(dest, { recursive: true });
    for (const name of names) {
      if (!name.startsWith(`${st.id}.`)) continue;
      try {
        if (statSync(join(logDir, name)).isFile()) renameSync(join(logDir, name), join(dest, name));
      } catch {
        // vanished or locked mid-move: the rest of the siblings still go
      }
    }
  }
  return moved;
}
