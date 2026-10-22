/**
 * storage/backup.ts — the only place `pai backup`/`pai restore` touch the
 * *.db filenames. SQLite backend: snapshot registry.db (VACUUM INTO) (+ federation.db,
 * if present) into/from the backup dir. Postgres backend: the file-copy
 * step is a no-op — pg_dump/pg_restore (still in cli/commands/backup.ts and
 * restore.ts, via docker exec) is the real backup for that backend.
 */

import { existsSync, chmodSync, copyFileSync, mkdirSync, openSync, readSync, closeSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import BetterSqlite3 from "better-sqlite3";
import type { PaiDaemonConfig } from "../daemon/config.js";
import { federationDbPath, registryDbPath } from "./paths.js";

export interface DbFileResult {
  label: string;
  path: string;
  status: "ok" | "skipped" | "failed";
  error?: string;
}

const SQLITE_MAGIC = "SQLite format 3\0";

function isSqliteFile(path: string): boolean {
  if (statSync(path).size < 16) return false;
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(16);
    readSync(fd, buf, 0, 16, 0);
    return buf.toString("latin1") === SQLITE_MAGIC;
  } finally {
    closeSync(fd);
  }
}

/**
 * Consistent copy of a possibly live WAL-mode database: VACUUM INTO goes
 * through SQLite, so committed rows still sitting in the -wal are included
 * and no sidecars are needed. Non-SQLite files fall back to a byte copy.
 */
function copyDb(src: string, dest: string): void {
  if (!isSqliteFile(src)) {
    copyFileSync(src, dest);
    return;
  }
  rmSync(dest, { force: true });
  const db = new BetterSqlite3(src, { readonly: true });
  try {
    db.prepare("VACUUM INTO ?").run(dest);
  } finally {
    db.close();
  }
}

/** True when another process holds the file open (the daemon). Undetectable (no lsof) counts as not held. */
function heldOpen(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    execFileSync("lsof", ["-t", path], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/** Restores one db file: refuses while held open, drops stale -wal/-shm, then copies. */
function restoreDb(src: string, dest: string): void {
  if (heldOpen(dest)) {
    throw new Error(`${dest} is held open by another process (the daemon?) — stop it first (pai daemon stop), then restore`);
  }
  mkdirSync(dirname(dest), { recursive: true });
  if (existsSync(dest)) {
    // Safety copy of the current db (WAL pages included) so the restore can be undone.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let safety = `${dest}.pre-restore-${stamp}`;
    for (let i = 1; existsSync(safety); i++) safety = `${dest}.pre-restore-${stamp}-${i}`;
    copyDb(dest, safety);
    chmodSync(safety, 0o600);
  }
  for (const suffix of ["-wal", "-shm"]) rmSync(`${dest}${suffix}`, { force: true });
  copyFileSync(src, dest);
}

/** Copies registry.db (and federation.db, if present) into destDir. No-op on the postgres backend. */
export function backupStorageFiles(config: PaiDaemonConfig, destDir: string): DbFileResult[] {
  if (config.storageBackend === "postgres") return [];

  const results: DbFileResult[] = [];

  const registrySrc = registryDbPath();
  if (existsSync(registrySrc)) {
    const dest = join(destDir, "registry.db");
    try {
      copyDb(registrySrc, dest);
      results.push({ label: "Registry DB", path: dest, status: "ok" });
    } catch (e) {
      results.push({ label: "Registry DB", path: dest, status: "failed", error: String(e) });
    }
  } else {
    results.push({ label: "Registry DB", path: registrySrc, status: "skipped", error: "not found" });
  }

  const fedSrc = federationDbPath();
  if (existsSync(fedSrc)) {
    const dest = join(destDir, "federation.db");
    try {
      copyDb(fedSrc, dest);
      results.push({ label: "Federation DB (legacy)", path: dest, status: "ok" });
    } catch (e) {
      results.push({ label: "Federation DB (legacy)", path: dest, status: "failed", error: String(e) });
    }
  }

  return results;
}

export interface StorageBackupInventory {
  hasRegistry: boolean;
  hasFederation: boolean;
}

/** What a backup dir holds, independent of which backend is configured now. */
export function inspectStorageBackup(srcDir: string): StorageBackupInventory {
  return {
    hasRegistry: existsSync(join(srcDir, "registry.db")),
    hasFederation: existsSync(join(srcDir, "federation.db")),
  };
}

/** Restores registry.db (and federation.db, if present) from srcDir. No-op on the postgres backend. */
export function restoreStorageFiles(config: PaiDaemonConfig, srcDir: string): DbFileResult[] {
  if (config.storageBackend === "postgres") return [];

  const results: DbFileResult[] = [];
  const inv = inspectStorageBackup(srcDir);

  if (inv.hasRegistry) {
    const dest = registryDbPath();
    try {
      restoreDb(join(srcDir, "registry.db"), dest);
      results.push({ label: "Registry DB", path: dest, status: "ok" });
    } catch (e) {
      results.push({ label: "Registry DB", path: dest, status: "failed", error: String(e) });
    }
  } else {
    results.push({ label: "Registry DB", path: registryDbPath(), status: "skipped", error: "missing in backup" });
  }

  if (inv.hasFederation) {
    const dest = federationDbPath();
    try {
      restoreDb(join(srcDir, "federation.db"), dest);
      results.push({ label: "Federation DB (legacy)", path: dest, status: "ok" });
    } catch (e) {
      results.push({ label: "Federation DB (legacy)", path: dest, status: "failed", error: String(e) });
    }
  }

  return results;
}
