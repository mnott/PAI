/**
 * logs-migrate.ts — moving ~/.claude/logs/workers (status files, event
 * mirrors, pane registry, routing state — everything under one run's logDir)
 * into PAI_HOME. Directory-level counterpart to pai-home.ts's per-file
 * migratePaiFile, but simpler: an atomic renameSync of the whole directory
 * followed by a symlink left at the old path, so any process still holding an
 * fd open into the old directory (or writing to the old path by name) keeps
 * landing in the new one — every held fd follows the inode across a rename,
 * and the symlink covers new opens by path. Only falls back to copy + verify
 * + rename-aside (and only there does it need to refuse while a worker is
 * RUNNING against the old directory) when old and new are on different
 * volumes and the rename itself fails with EXDEV.
 */

import { existsSync, mkdirSync, cpSync, renameSync, symlinkSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadStatuses, isChatPane, alive } from "./status.js";

export class WorkerLogsMigrationError extends Error {}

/** RUNNING-and-alive statuses in logDir, excluding the terminal's own interactive pane. */
export function activeSpawnedWorkerCount(logDir: string): number {
  return loadStatuses(logDir).filter((s) => s.state === "running" && alive(s.pid) && !isChatPane(s)).length;
}

function totalFileCount(dir: string): number {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    count += entry.isDirectory() ? totalFileCount(full) : 1;
  }
  return count;
}

export interface MigrateLogsResult {
  fromPath: string | null;
  toPath: string;
  dryRun: boolean;
  filesMoved?: number;
  note?: string;
}

/**
 * Move the whole logDir tree into PAI_HOME. Normal case: renameSync the
 * directory (atomic, and every fd already open into it — including run.ts's
 * append-mode events file — follows the inode), then leave a symlink at the
 * old path so writes still addressed there land in the new directory too.
 * Falls back to recursive copy + verified file count + rename-aside (never
 * deleted) only on EXDEV, when old and new are on different volumes — that
 * path refuses while any spawned worker is RUNNING against the old
 * directory (check `pai worker ps` and retry once idle), since a copy can't
 * see writes still landing in the old tree.
 */
export function migrateWorkerLogs(
  oldPath: string,
  newPath: string,
  opts: { dryRun?: boolean } = {}
): MigrateLogsResult {
  if (!existsSync(oldPath)) {
    return {
      fromPath: null,
      toPath: newPath,
      dryRun: !!opts.dryRun,
      note: "nothing to migrate — old logDir does not exist",
    };
  }
  if (existsSync(newPath)) {
    return {
      fromPath: oldPath,
      toPath: newPath,
      dryRun: !!opts.dryRun,
      note: "already at new location — resolve manually, nothing changed",
    };
  }

  if (opts.dryRun) return { fromPath: oldPath, toPath: newPath, dryRun: true };

  mkdirSync(dirname(newPath), { recursive: true });

  try {
    renameSync(oldPath, newPath);
    symlinkSync(newPath, oldPath);
    return { fromPath: oldPath, toPath: newPath, dryRun: false, filesMoved: totalFileCount(newPath) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
  }

  const active = activeSpawnedWorkerCount(oldPath);
  if (active > 0) {
    throw new WorkerLogsMigrationError(
      `${active} worker(s) other than the interactive session are RUNNING and writing into ` +
        `${oldPath} — wait for them to finish (see \`pai worker ps\`), then retry`
    );
  }

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  cpSync(oldPath, newPath, { recursive: true });

  const fromCount = totalFileCount(oldPath);
  const toCount = totalFileCount(newPath);
  if (fromCount !== toCount) {
    throw new WorkerLogsMigrationError(
      `${newPath}: copy produced ${toCount} files, expected ${fromCount} from ${oldPath} — ` +
        `aborting, old directory left in place`
    );
  }

  renameSync(oldPath, `${oldPath}.migrated-${stamp}`);
  return { fromPath: oldPath, toPath: newPath, dryRun: false, filesMoved: toCount };
}
