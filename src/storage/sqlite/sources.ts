/**
 * SQLite implementation of the `pai memory sources` aggregate report — moved
 * from cli/commands/memory/sources.ts so the only file running ad-hoc
 * aggregate SQL against the federation database lives under src/storage/.
 */

import type { Database } from "better-sqlite3";
import type { MemorySourcesReport } from "../interface.js";

export function getMemorySourcesReportSqlite(db: Database): MemorySourcesReport {
  const composition = db
    .prepare(
      `SELECT source, tier, COUNT(*) AS chunks,
              SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) AS embedded
         FROM memory_chunks GROUP BY source, tier ORDER BY COUNT(*) DESC`
    )
    .all() as Array<{ source: string; tier: string; chunks: number; embedded: number }>;

  const paths = db
    .prepare(`SELECT path, COUNT(*) AS chunks FROM memory_chunks GROUP BY path`)
    .all() as Array<{ path: string; chunks: number }>;

  const churn = db
    .prepare(
      `SELECT date(updated_at/1000,'unixepoch') AS day, COUNT(*) AS chunks,
              SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) AS embedded
         FROM memory_chunks GROUP BY day ORDER BY day DESC LIMIT 10`
    )
    .all() as Array<{ day: string; chunks: number; embedded: number }>;

  return { composition, paths, churn };
}
