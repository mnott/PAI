/**
 * One-time repair for chunks written while the `pai_chunks_fts_update`
 * trigger used the 'english' text-search config instead of 'simple'.
 *
 * The trigger stemmed and stripped stop-words from every stored fts_vector,
 * but every query (searchKeyword, findTunnels) and the direct-insert path
 * (insertChunks) always used 'simple' — so a BEFORE trigger silently
 * overwrote each insert with a vector that keyword search could never match.
 * Measured on a real database: 0 rows for `fts_vector @@ to_tsquery('simple',
 * 'running')` against 142,559 chunks containing "running".
 *
 * Completion is marked by a comment on pai_chunks.fts_vector so this can run
 * on every daemon boot for free once migrated, and resume if a batch run
 * was interrupted: every 20 batches the last completed id is stored in the
 * comment as `fts:simple:inprogress:<id>` and the next start continues after it.
 *
 * The rebuild runs in the background while the indexer writes pai_chunks, so
 * each batch UPDATE locks its rows in id order (consistent with other writers)
 * and is retried up to 5 times on deadlock (40P01) or serialization failure
 * (40001) with a 200ms * attempt backoff. Rows whose fts_vector is already
 * correct are skipped, so a retry or restart is cheap.
 */

import type { StorageBackend } from "../interface.js";
import type { PostgresBackend } from "../postgres.js";

const DONE_MARKER = "fts:simple";
const PROGRESS_PREFIX = "fts:simple:inprogress:";
const BATCH_SIZE = 1000;
const MAX_ATTEMPTS = 5;
const RETRYABLE_CODES = new Set(["40P01", "40001"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function migrateFtsConfig(backend: StorageBackend): Promise<void> {
  // Obtained inside the async function body, not by the caller: a throw here
  // (e.g. a bad cast) becomes a rejection of this function's own promise,
  // caught by the caller's `.catch`, instead of a synchronous throw inside
  // the daemon's storage-backend `.then()` that would abort loadQueue()/
  // startWorker() and hit the outer fatal-exit `.catch`.
  const pool = (backend as unknown as PostgresBackend).getPool();
  const tableCheck = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = 'pai_chunks'`
  );
  if (tableCheck.rowCount === 0) return;

  const commentCheck = await pool.query<{ comment: string | null }>(
    `SELECT col_description('pai_chunks'::regclass, ordinal_position) AS comment
     FROM information_schema.columns
     WHERE table_name = 'pai_chunks' AND column_name = 'fts_vector'`
  );
  const comment = commentCheck.rows[0]?.comment ?? null;
  if (comment === DONE_MARKER) return;
  const resumeId = comment?.startsWith(PROGRESS_PREFIX)
    ? comment.slice(PROGRESS_PREFIX.length)
    : "";

  process.stderr.write(
    "[pai-postgres] FTS config migration: starting (english -> simple)\n"
  );

  const fnCheck = await pool.query(
    `SELECT 1 FROM pg_proc WHERE proname = 'pai_chunks_fts_update'`
  );
  if (fnCheck.rowCount !== 0) {
    await pool.query(`
      CREATE OR REPLACE FUNCTION pai_chunks_fts_update()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.fts_vector := to_tsvector('simple', COALESCE(NEW.text, ''));
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    process.stderr.write(
      "[pai-postgres] FTS config migration: trigger function now uses 'simple'\n"
    );
  }

  let lastId: string | null = resumeId || null;
  if (lastId !== null) {
    process.stderr.write(`[pai-postgres] FTS config migration: resuming from ${lastId}\n`);
  }
  let totalUpdated = 0;
  let batchN = 0;
  while (true) {
    const sql = lastId === null
      ? `SELECT id FROM pai_chunks ORDER BY id LIMIT $1`
      : `SELECT id FROM pai_chunks WHERE id > $2 ORDER BY id LIMIT $1`;
    const params: Array<number | string> = lastId === null ? [BATCH_SIZE] : [BATCH_SIZE, lastId];
    const idRows = await pool.query<{ id: string }>(sql, params);
    if (idRows.rows.length === 0) break;

    const ids: string[] = idRows.rows.map((r) => r.id);
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await pool.query(
          `UPDATE pai_chunks c SET fts_vector = to_tsvector('simple', COALESCE(c.text, ''))
           FROM (SELECT id FROM pai_chunks WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE) s
           WHERE c.id = s.id
             AND c.fts_vector IS DISTINCT FROM to_tsvector('simple', COALESCE(c.text, ''))`,
          [ids]
        );
        totalUpdated += result.rowCount ?? 0;
        break;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (attempt >= MAX_ATTEMPTS || !code || !RETRYABLE_CODES.has(code)) throw err;
        await sleep(200 * attempt);
      }
    }
    lastId = ids[ids.length - 1];
    batchN++;
    if (batchN % 20 === 0) {
      // COMMENT takes no bind params; double quotes to escape the literal.
      await pool.query(
        `COMMENT ON COLUMN pai_chunks.fts_vector IS '${PROGRESS_PREFIX}${lastId.replace(/'/g, "''")}'`
      );
      process.stderr.write(
        `[pai-postgres] FTS config migration: ${totalUpdated} chunks rebuilt so far...\n`
      );
    }
    if (idRows.rows.length < BATCH_SIZE) break;
  }

  await pool.query(
    `COMMENT ON COLUMN pai_chunks.fts_vector IS '${DONE_MARKER}'`
  );

  process.stderr.write(
    `[pai-postgres] FTS config migration: done, ${totalUpdated} chunks rebuilt\n`
  );
}
