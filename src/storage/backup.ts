/**
 * storage/backup.ts — the only place `pai backup`/`pai restore` touch the
 * *.db filenames. SQLite backend: byte-copy registry.db (+ federation.db,
 * if present) into/from the backup dir. Postgres backend: the file-copy
 * step is a no-op — pg_dump/pg_restore (still in cli/commands/backup.ts and
 * restore.ts, via docker exec) is the real backup for that backend.
 */

import { existsSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PaiDaemonConfig } from "../daemon/config.js";
import { federationDbPath, registryDbPath } from "./paths.js";

export interface DbFileResult {
  label: string;
  path: string;
  status: "ok" | "skipped" | "failed";
  error?: string;
}

/** Copies registry.db (and federation.db, if present) into destDir. No-op on the postgres backend. */
export function backupStorageFiles(config: PaiDaemonConfig, destDir: string): DbFileResult[] {
  if (config.storageBackend === "postgres") return [];

  const results: DbFileResult[] = [];

  const registrySrc = registryDbPath();
  if (existsSync(registrySrc)) {
    const dest = join(destDir, "registry.db");
    try {
      copyFileSync(registrySrc, dest);
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
      copyFileSync(fedSrc, dest);
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
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(srcDir, "registry.db"), dest);
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
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(srcDir, "federation.db"), dest);
      results.push({ label: "Federation DB (legacy)", path: dest, status: "ok" });
    } catch (e) {
      results.push({ label: "Federation DB (legacy)", path: dest, status: "failed", error: String(e) });
    }
  }

  return results;
}
