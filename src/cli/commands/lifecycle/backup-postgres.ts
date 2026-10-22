/**
 * Postgres part of `pai backup`: pick the database the running storage uses,
 * dump it, and check the dump against the live row counts.
 */

import { readFileSync } from "node:fs";
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
