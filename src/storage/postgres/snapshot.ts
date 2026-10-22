/**
 * One REPEATABLE READ transaction that exports its snapshot and counts rows in it, so a
 * pg_dump --snapshot run while it is open sees exactly the counted state.
 */

import pg from "pg";

/**
 * Opens the transaction, counts `tables` (null when a table does not exist), calls `dump(snapshotId)`
 * while the transaction is still open, and returns the counts.
 */
export async function countInExportedSnapshot(
  connectionString: string,
  tables: readonly string[],
  dump: (snapshotId: string) => void | Promise<void>,
): Promise<Record<string, number | null>> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const snap = (await client.query("SELECT pg_export_snapshot() AS s")).rows[0].s as string;
    const counts: Record<string, number | null> = {};
    for (const table of tables) {
      const exists = (await client.query("SELECT to_regclass($1) IS NOT NULL AS e", [table])).rows[0].e as boolean;
      counts[table] = exists ? Number((await client.query(`SELECT count(*) AS n FROM "${table.replace(/"/g, '""')}"`)).rows[0].n) : null;
    }
    await dump(snap);
    await client.query("COMMIT");
    return counts;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** The statement `psql -tAc` runs to count a table's rows. */
export function countSql(table: string): string {
  return `SELECT count(*) FROM "${table.replace(/"/g, '""')}"`;
}
