/**
 * Index ensures for the postgres backend, safe to run at every backend init.
 *
 * `CREATE INDEX IF NOT EXISTS` still requests a SHARE lock on the table before
 * noticing the index exists, so it queues behind a long writer (an UPDATE on
 * pai_chunks) and every later writer then queues behind it. This helper reads
 * pg_indexes first (no table lock), creates only what is missing, does so with
 * CREATE INDEX CONCURRENTLY (never blocks writers) and under a short
 * lock_timeout, and logs and continues when it cannot get the lock.
 */

import type { Pool } from "pg";

export const ENSURE_INDEX_LOCK_TIMEOUT = "3s";

export interface IndexSpec {
  name: string;
  table: string;
  /** Column list / expressions, e.g. "tenant_id, name" or "created_at DESC". */
  columns: string;
  /** Optional partial-index predicate, without the WHERE keyword. */
  where?: string;
}

function log(message: string): void {
  process.stderr.write(`[pai-postgres] ${message}\n`);
}

async function ensureOne(pool: Pool, spec: IndexSpec): Promise<void> {
  const existing = await pool.query(
    "SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1",
    [spec.name]
  );
  if (existing.rowCount && existing.rowCount > 0) return;

  const client = await pool.connect();
  try {
    await client.query(`SET lock_timeout = '${ENSURE_INDEX_LOCK_TIMEOUT}'`);
    const where = spec.where ? ` WHERE ${spec.where}` : "";
    try {
      await client.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${spec.name} ON ${spec.table}(${spec.columns})${where}`
      );
    } catch (err) {
      // A failed CONCURRENTLY build leaves an INVALID index behind; drop it so
      // the next init retries instead of seeing it in pg_indexes and skipping.
      try {
        await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${spec.name}`);
      } catch { /* best effort */ }
      throw err;
    }
    log(`Migration: created index ${spec.name}`);
  } finally {
    try {
      await client.query("RESET lock_timeout");
    } catch { /* connection is being released anyway */ }
    client.release();
  }
}

/** Ensure each index exists. Never throws: failures are logged and init continues. */
export async function ensureIndexes(pool: Pool, specs: IndexSpec[]): Promise<void> {
  for (const spec of specs) {
    try {
      await ensureOne(pool, spec);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Index ${spec.name} not ensured (continuing): ${msg}`);
    }
  }
}
