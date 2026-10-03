/**
 * Postgres statements behind the status dashboard; table names are the
 * existing pai_* ones.
 */

import type { Pool } from "pg";
import type { StorageCounts, EmbeddingJobRow } from "../interface.js";

const EXACT_TIMEOUT_MS = 20_000;

export async function estimateCountsPostgres(pool: Pool): Promise<StorageCounts> {
  const rel = await pool.query<{ relname: string; n: string }>(
    "SELECT relname, reltuples::bigint::text AS n FROM pg_class WHERE relname IN ('pai_files', 'pai_chunks')",
  );
  const n = (name: string) => Math.max(0, Number(rel.rows.find((r) => r.relname === name)?.n ?? 0));
  const nf = await pool.query<{ null_frac: number }>(
    "SELECT null_frac FROM pg_stats WHERE tablename = 'pai_chunks' AND attname = 'embedding' LIMIT 1",
  );
  const frac = nf.rows[0]?.null_frac;
  const chunks = n("pai_chunks");
  return { files: n("pai_files"), chunks, embedded: frac === undefined ? null : Math.round(chunks * (1 - frac)) };
}

export async function exactCountsPostgres(pool: Pool): Promise<StorageCounts> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${EXACT_TIMEOUT_MS}`);
    const f = await client.query<{ n: string }>("SELECT count(*)::text AS n FROM pai_files");
    const c = await client.query<{ n: string; e: string }>(
      "SELECT count(*)::text AS n, count(embedding)::text AS e FROM pai_chunks",
    );
    return { files: Number(f.rows[0].n), chunks: Number(c.rows[0].n), embedded: Number(c.rows[0].e) };
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

export async function embeddingJobsPostgres(pool: Pool): Promise<EmbeddingJobRow[]> {
  const exists = await pool.query<{ t: string | null }>("SELECT to_regclass('pai_embedding_jobs')::text AS t");
  if (!exists.rows[0]?.t) return [];
  const r = await pool.query<{ column_name: string; state: Record<string, unknown> | null }>(
    "SELECT column_name, state FROM pai_embedding_jobs",
  );
  return r.rows.map((x) => ({ name: x.column_name, state: x.state ?? {} }));
}
