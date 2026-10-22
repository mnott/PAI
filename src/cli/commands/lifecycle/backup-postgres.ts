/**
 * Postgres part of `pai backup`: pick the database the running storage uses,
 * dump it, and check the dump against the live row counts.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { postgresTarget, type PostgresConfig } from "../../../storage/postgres/config.js";

export const BACKUP_TABLES = ["pai_files", "pai_chunks", "pai_observations", "sessions"] as const;

export interface PgRunner {
  /** pg_dump of `database` as `user` into `destPath`; throws on failure. */
  dump(database: string, user: string, destPath: string): void;
  /** Live row count of `table`, or null when the table does not exist. */
  count(database: string, user: string, table: string): number | null;
}

/** The database/role to dump: resolved by the same function the storage backend connects with. */
export function resolveBackupTarget(pg: PostgresConfig | undefined): { database: string; user: string } {
  return postgresTarget(pg ?? {});
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

/** Dump the target and verify it. Throws, naming the database, when the dump is empty or counts differ. */
export function backupPostgres(
  target: { database: string; user: string },
  destPath: string,
  runner: PgRunner,
): { database: string; counts: Record<string, number> } {
  runner.dump(target.database, target.user, destPath);
  const dumped = countDumpRows(readFileSync(destPath, "utf8"));
  const counts: Record<string, number> = {};
  const problems: string[] = [];
  let live = 0;
  for (const table of BACKUP_TABLES) {
    const liveCount = runner.count(target.database, target.user, table);
    if (liveCount === null) continue;
    live += liveCount;
    const got = dumped.get(table) ?? 0;
    counts[table] = got;
    if (got !== liveCount) problems.push(`${table}: dump ${got}, live ${liveCount}`);
  }
  if (dumped.size === 0) problems.unshift("dump contains no table data");
  if (problems.length > 0) {
    throw new Error(`database "${target.database}" backup failed verification (${problems.join("; ")})`);
  }
  if (live === 0 && Object.keys(counts).length === 0) {
    throw new Error(`database "${target.database}" has none of the main tables (${BACKUP_TABLES.join(", ")})`);
  }
  return { database: target.database, counts };
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
  target: { database: string; user: string };
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
  const target = { database: into ?? daemon.database, user: daemon.user };
  if (into !== undefined) return { target, source };
  if (source === null) {
    return { target, source, refusal: `backup does not record its source database; pass --into <db> to restore into a database explicitly (daemon database is "${daemon.database}")` };
  }
  if (source !== target.database) {
    return { target, source, refusal: `backup was taken from database "${source}" but the daemon uses "${target.database}"; pass --into <db> to restore anyway` };
  }
  return { target, source };
}
