/**
 * Postgres implementation of the `pai memory sources` aggregate report —
 * moved from cli/commands/memory/sources.ts alongside its SQLite
 * counterpart (storage/sqlite/sources.ts).
 */

import type { Pool } from "pg";
import type { MemorySourcesReport } from "../interface.js";

const num = (v: unknown): number => Number(v ?? 0);

export async function getMemorySourcesReportPostgres(pool: Pool): Promise<MemorySourcesReport> {
  const compRes = await pool.query(
    `SELECT source, tier, COUNT(*) AS chunks, COUNT(embedding) AS embedded
       FROM pai_chunks GROUP BY source, tier ORDER BY COUNT(*) DESC`
  );
  const composition = (compRes.rows as Array<{ source: string; tier: string; chunks: unknown; embedded: unknown }>)
    .map((r) => ({ source: r.source, tier: r.tier, chunks: num(r.chunks), embedded: num(r.embedded) }));

  const pathsRes = await pool.query(
    `SELECT path, COUNT(*) AS chunks FROM pai_chunks GROUP BY path`
  );
  const paths = (pathsRes.rows as Array<{ path: string; chunks: unknown }>)
    .map((r) => ({ path: r.path, chunks: num(r.chunks) }));

  const churnRes = await pool.query(
    `SELECT to_char(to_timestamp(updated_at/1000),'YYYY-MM-DD') AS day,
            COUNT(*) AS chunks, COUNT(embedding) AS embedded
       FROM pai_chunks GROUP BY day ORDER BY day DESC LIMIT 10`
  );
  const churn = (churnRes.rows as Array<{ day: string; chunks: unknown; embedded: unknown }>)
    .map((r) => ({ day: r.day, chunks: num(r.chunks), embedded: num(r.embedded) }));

  return { composition, paths, churn };
}
