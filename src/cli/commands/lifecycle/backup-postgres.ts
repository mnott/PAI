/**
 * Postgres part of `pai backup`: pick the database the running storage uses,
 * dump it, and check the dump against the live row counts.
 */

import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertPgName, postgresFullTarget, type PgTarget, type PostgresConfig } from "../../../storage/postgres/config.js";

export const BACKUP_TABLES = ["pai_files", "pai_chunks", "pai_observations", "sessions"] as const;

export interface PgRunner {
  /**
   * pg_dump of the target into `destPath`; throws on failure. Returns the live row count of each
   * BACKUP_TABLES table (null when it does not exist), read in the same REPEATABLE READ snapshot
   * the dump uses (pg_dump --snapshot), so the counts and the dump describe the same instant.
   */
  dump(target: PgTarget, destPath: string): Promise<Record<string, number | null>>;
}

/** The server, database and role to dump: resolved by the same function the storage backend connects with. */
export function resolveBackupTarget(pg: PostgresConfig | undefined): PgTarget {
  return postgresFullTarget(pg ?? {});
}

/** A plain pg_dump ends with this marker; a truncated dump does not. */
export function validatePgDump(dump: string): string | null {
  if (dump.trim().length === 0) return "dump is empty";
  if (!dump.slice(-2048).includes("PostgreSQL database dump complete")) {
    return "dump is truncated (no pg_dump completion marker)";
  }
  return null;
}

/** Row counts per table found in COPY blocks of a plain-format pg_dump. */
export function countDumpRows(sql: string): Map<string, number> {
  const counts = new Map<string, number>();
  let current: string | null = null;
  for (const line of sql.split("\n")) {
    if (current === null) {
      const m = /^COPY (?:\S+\.)?"?(\w+)"? .* FROM stdin;/.exec(line);
      if (m) {
        current = m[1]!;
        counts.set(current, 0);
      }
    } else if (line === "\\.") {
      current = null;
    } else {
      counts.set(current, counts.get(current)! + 1);
    }
  }
  return counts;
}

/**
 * Dump the target and verify it against the counts taken in the dump's own snapshot.
 * A table with no COPY block counts as 0 rows (pg_dump emits none for empty tables), so a fresh
 * install verifies. On any failure the dump file is removed so it cannot be mistaken for a backup.
 */
export async function backupPostgres(
  target: PgTarget,
  destPath: string,
  runner: PgRunner,
): Promise<{ database: string; counts: Record<string, number> }> {
  try {
    const live = await runner.dump(target, destPath);
    const sql = readFileSync(destPath, "utf8");
    const invalid = validatePgDump(sql);
    if (invalid) throw new Error(`database "${target.database}" backup failed verification (${invalid})`);
    const dumped = countDumpRows(sql);
    const counts: Record<string, number> = {};
    const problems: string[] = [];
    for (const table of BACKUP_TABLES) {
      const liveCount = live[table];
      if (liveCount === null || liveCount === undefined) continue;
      const got = dumped.get(table) ?? 0;
      counts[table] = got;
      if (got !== liveCount) problems.push(`${table}: dump ${got}, live ${liveCount}`);
    }
    if (problems.length > 0) {
      throw new Error(`database "${target.database}" backup failed verification (${problems.join("; ")})`);
    }
    if (Object.keys(counts).length === 0) {
      throw new Error(`database "${target.database}" has none of the main tables (${BACKUP_TABLES.join(", ")})`);
    }
    return { database: target.database, counts };
  } catch (e) {
    try { unlinkSync(destPath); } catch { /* never written */ }
    throw e;
  }
}

export const BACKUP_META_FILE = "postgres-meta.json";

export interface BackupMeta { database: string; counts: Record<string, number> }

/** Records the source database and dumped row counts next to the dump. */
export function writeBackupMeta(backupDir: string, meta: BackupMeta): void {
  writeFileSync(join(backupDir, BACKUP_META_FILE), JSON.stringify(meta, null, 2) + "\n", { mode: 0o600 });
}

/** Reads the metadata of a backup; null when absent or unreadable (backups made before it existed). */
export function readBackupMeta(backupDir: string): BackupMeta | null {
  try {
    const m = JSON.parse(readFileSync(join(backupDir, BACKUP_META_FILE), "utf8")) as Partial<BackupMeta>;
    if (typeof m.database !== "string" || m.database === "") return null;
    return { database: m.database, counts: m.counts ?? {} };
  } catch {
    return null;
  }
}

export interface RestorePlan {
  target: PgTarget;
  source: string | null;
  /** Set when the restore must not run. */
  refusal?: string;
}

/** Target = the daemon's database unless `into` overrides it; refuses when the dump came from another database (or an unknown one) and `into` is not given. */
export function planPostgresRestore(
  pg: PostgresConfig | undefined,
  meta: BackupMeta | null,
  into?: string,
): RestorePlan {
  const daemon = resolveBackupTarget(pg);
  const source = meta?.database ?? null;
  const target: PgTarget = { ...daemon, database: into ?? daemon.database };
  try {
    assertPgName(target.database, "database", RESTORE_DB_MAX_BYTES);
  } catch (e) {
    return { target, source, refusal: e instanceof Error ? e.message : String(e) };
  }
  if (into !== undefined) return { target, source };
  if (source === null) {
    return { target, source, refusal: `backup does not record its source database (made before 1.0.2); pass --into <db> to restore into a database explicitly, usually --into ${daemon.database} (daemon database)` };
  }
  if (source !== target.database) {
    return { target, source, refusal: `backup was taken from database "${source}" but the daemon uses "${target.database}"; pass --into <db> to restore anyway` };
  }
  return { target, source };
}

/** Restore derives `<db>_prerestore_<19-char stamp>` names; keep them inside Postgres' 63 bytes so they are never truncated onto another name. */
export const RESTORE_DB_MAX_BYTES = 63 - "_prerestore_".length - 19;

/** Warning when the config.json inside the backup names a different database than the restore target; null when equal or unreadable. */
export function configDatabaseMismatch(backupConfigPath: string, target: { database: string }): string | null {
  try {
    const cfg = JSON.parse(readFileSync(backupConfigPath, "utf8")) as { postgres?: PostgresConfig };
    const db = resolveBackupTarget(cfg.postgres).database;
    return db === target.database
      ? null
      : `config.json from the backup names database "${db}" but the dump was restored into "${target.database}"; the daemon will use "${db}"`;
  } catch {
    return null;
  }
}
