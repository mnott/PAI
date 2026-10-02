/**
 * Pure helpers of scripts/embed-ollama-job.mjs (bulk re-embed without HNSW
 * write amplification): batching, index-definition round trip, ETA text.
 */

export function toBatches<T>(rows: T[], size: number, limit = Infinity): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length && i < limit; i += size) out.push(rows.slice(i, Math.min(i + size, limit)));
  return out;
}

/**
 * The saved pg_indexes.indexdef is replayed as-is; only IF NOT EXISTS is
 * added so a resumed phase 4 is idempotent. Throws when the text is not a
 * CREATE INDEX of the expected index (a corrupt saved definition must not run).
 */
export function recreateIndexSql(indexName: string, def: string): string {
  const m = /^CREATE (UNIQUE )?INDEX (\S+) ON /.exec(def);
  if (!m || m[2] !== indexName) throw new Error(`saved definition is not CREATE INDEX ${indexName}: ${def.slice(0, 80)}`);
  return def.replace(/^CREATE (UNIQUE )?INDEX /, "CREATE $1INDEX IF NOT EXISTS ");
}

export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds)) return "?";
  const s = Math.round(seconds);
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

/** pgvector text literal for one embedding. */
export const vectorLiteral = (v: ArrayLike<number>): string => `[${Array.prototype.join.call(v, ",")}]`;
