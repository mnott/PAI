/**
 * logs-migrate.ts — moving ~/.claude/logs/workers (status files, event
 * mirrors, pane registry, routing state — everything under one run's logDir)
 * into PAI_HOME. Directory-level counterpart to pai-home.ts's per-file
 * migratePaiFile: refuses while any worker other than the interactive pane
 * is RUNNING, since that worker is writing into the old directory right now.
 */

import { existsSync, mkdirSync, cpSync, renameSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadStatuses, isChatPane } from "./status.js";

export class WorkerLogsMigrationError extends Error {}

/** RUNNING statuses in logDir excluding the terminal's own interactive pane. */
export function activeSpawnedWorkerCount(logDir: string): number {
  return loadStatuses(logDir).filter((s) => s.state === "running" && !isChatPane(s)).length;
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
 * Move the whole logDir tree into PAI_HOME: recursive copy, verify the file
 * count matches, then rename the old directory aside to
 * `<name>.migrated-<YYYYMMDD>` (never deleted). Refuses while any spawned
 * worker is RUNNING against the old directory — check `pai worker ps` and
 * retry once idle.
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

  const active = activeSpawnedWorkerCount(oldPath);
  if (active > 0) {
    throw new WorkerLogsMigrationError(
      `${active} worker(s) other than the interactive session are RUNNING and writing into ` +
        `${oldPath} — wait for them to finish (see \`pai worker ps\`), then retry`
    );
  }

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  mkdirSync(dirname(newPath), { recursive: true });
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
