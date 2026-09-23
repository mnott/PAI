/**
 * SQLite search implementation — moved from memory/search.ts so the only
 * file running raw FTS5/vector queries against the federation database
 * lives under src/storage/. Query building, slug population, and recency
 * boosting are pure logic with no SQL and stay in memory/search.ts.
 *
 * BM25 uses SQLite's FTS5 extension. Semantic search requires embeddings to
 * have been generated first via the indexer's embed pass.
 */

import type { Database } from "better-sqlite3";
import { deserializeEmbedding, cosineSimilarity } from "../../memory/embeddings.js";
import {
  buildFtsQuery,
  isQuerySyntaxError,
  type SearchResult,
  type SearchOptions,
} from "../../memory/search.js";

// ---------------------------------------------------------------------------
// Keyword (BM25) search
// ---------------------------------------------------------------------------

/**
 * Search across all indexed memory using FTS5 BM25 ranking.
 *
 * Results are ordered by BM25 score (most relevant first).
 * FTS5 bm25() returns negative values; closer to 0 = more relevant.
 * We negate the score so callers get positive values where higher = better.
 */
export function searchMemory(
  db: Database,
  query: string,
  opts?: SearchOptions,
): SearchResult[] {
  const maxResults = opts?.maxResults ?? 10;
  const ftsQuery = buildFtsQuery(query);

  const conditions: string[] = [];
  const params: (string | number)[] = [ftsQuery];

  if (opts?.projectIds && opts.projectIds.length > 0) {
    const placeholders = opts.projectIds.map(() => "?").join(", ");
    conditions.push(`c.project_id IN (${placeholders})`);
    params.push(...opts.projectIds);
  }

  if (opts?.sources && opts.sources.length > 0) {
    const placeholders = opts.sources.map(() => "?").join(", ");
    conditions.push(`c.source IN (${placeholders})`);
    params.push(...opts.sources);
  }

  if (opts?.tiers && opts.tiers.length > 0) {
    const placeholders = opts.tiers.map(() => "?").join(", ");
    conditions.push(`c.tier IN (${placeholders})`);
    params.push(...opts.tiers);
  }

  const whereClause = conditions.length > 0
    ? "AND " + conditions.join(" AND ")
    : "";

  params.push(maxResults);

  const sql = `
    SELECT
      c.id,
      c.project_id,
      c.path,
      c.start_line,
      c.end_line,
      c.text             AS snippet,
      c.tier,
      c.source,
      c.updated_at,
      c.last_accessed_at,
      c.relevance_score,
      bm25(memory_fts) AS bm25_score
    FROM memory_fts
    JOIN memory_chunks c ON memory_fts.id = c.id
    WHERE memory_fts MATCH ?
      ${whereClause}
    ORDER BY bm25_score
    LIMIT ?
  `;

  let rows: Array<{
    id: string;
    project_id: number;
    path: string;
    start_line: number;
    end_line: number;
    snippet: string;
    tier: string;
    source: string;
    updated_at: number;
    last_accessed_at: number | null;
    relevance_score: number | null;
    bm25_score: number;
  }>;

  try {
    rows = db.prepare(sql).all(...params) as typeof rows;
  } catch (e) {
    // FTS5 MATCH throws on a malformed query, and for THAT an empty result is the
    // honest answer — nothing matches a query that cannot be parsed.
    //
    // Everything else is a failure of the store: a missing table, a corrupt
    // index, a locked database. Those used to return [] as well, which made an
    // unusable index byte-identical to a genuine miss. The Postgres path had the
    // same defect and it cost a real wrong answer on 2026-08-04 — the backend was
    // down for two hours, every search reported "No results found", and a sibling
    // session told the owner a DMARC note did not exist. See
    // storage/postgres/search.ts.
    if (!isQuerySyntaxError(e)) {
      throw new Error(
        `Memory keyword search failed — the index is unusable, so this is NOT an ` +
          `empty result set. Cause: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    return [];
  }

  const minScore = opts?.minScore ?? 0.0;

  return rows
    .map((row) => {
      const baseScore = -row.bm25_score;
      const relevanceScore = row.relevance_score ?? 0.5;
      const score = baseScore * (0.5 + relevanceScore);
      return {
        chunkId: row.id,
        projectId: row.project_id,
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line,
        snippet: row.snippet,
        score,
        tier: row.tier,
        source: row.source,
        updatedAt: row.updated_at,
        lastAccessedAt: row.last_accessed_at ?? undefined,
      };
    })
    .filter((r) => r.score >= minScore);
}

// ---------------------------------------------------------------------------
// Semantic search
// ---------------------------------------------------------------------------

/**
 * Search chunks using brute-force cosine similarity over stored embeddings.
 *
 * Only chunks that have a non-null embedding BLOB are considered.
 *
 * @param queryEmbedding  Pre-computed Float32Array for the search query.
 */
export function searchMemorySemantic(
  db: Database,
  queryEmbedding: Float32Array,
  opts?: SearchOptions,
): SearchResult[] {
  const maxResults = opts?.maxResults ?? 10;

  const conditions: string[] = ["embedding IS NOT NULL"];
  const params: (string | number)[] = [];

  if (opts?.projectIds && opts.projectIds.length > 0) {
    const placeholders = opts.projectIds.map(() => "?").join(", ");
    conditions.push(`project_id IN (${placeholders})`);
    params.push(...opts.projectIds);
  }

  if (opts?.sources && opts.sources.length > 0) {
    const placeholders = opts.sources.map(() => "?").join(", ");
    conditions.push(`source IN (${placeholders})`);
    params.push(...opts.sources);
  }

  if (opts?.tiers && opts.tiers.length > 0) {
    const placeholders = opts.tiers.map(() => "?").join(", ");
    conditions.push(`tier IN (${placeholders})`);
    params.push(...opts.tiers);
  }

  const where = "WHERE " + conditions.join(" AND ");

  // Hard cap for SQLite semantic path — prevents OOM on large corpora.
  // Use Postgres for production semantic search.
  const sql = `
    SELECT id, project_id, path, start_line, end_line, text, tier, source, embedding, updated_at, last_accessed_at, relevance_score
    FROM memory_chunks
    ${where}
    LIMIT 5000
  `;

  const rows = db.prepare(sql).all(...params) as Array<{
    id: string;
    project_id: number;
    path: string;
    start_line: number;
    end_line: number;
    text: string;
    tier: string;
    source: string;
    embedding: Buffer;
    updated_at: number;
    last_accessed_at: number | null;
    relevance_score: number | null;
  }>;

  if (rows.length === 0) return [];

  const scored = rows.map((row) => {
    const vec = deserializeEmbedding(row.embedding);
    const baseScore = cosineSimilarity(queryEmbedding, vec);
    const relevanceScore = row.relevance_score ?? 0.5;
    const score = baseScore * (0.5 + relevanceScore);
    return {
      chunkId: row.id,
      projectId: row.project_id,
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
      snippet: row.text,
      score,
      tier: row.tier,
      source: row.source,
      updatedAt: row.updated_at,
      lastAccessedAt: row.last_accessed_at ?? undefined,
    };
  });

  const minScore = opts?.minScore ?? -Infinity;

  return scored
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

// ---------------------------------------------------------------------------
// Hybrid search
// ---------------------------------------------------------------------------

/**
 * Combine BM25 keyword search and semantic search using normalized scores.
 *
 * Both score sets are min-max normalized to [0,1] before combining, so neither
 * dominates the other regardless of their raw scales.
 */
export function searchMemoryHybrid(
  db: Database,
  query: string,
  queryEmbedding: Float32Array,
  opts?: SearchOptions & { keywordWeight?: number; semanticWeight?: number },
): SearchResult[] {
  const maxResults = opts?.maxResults ?? 10;
  const kw = opts?.keywordWeight ?? 0.5;
  const sw = opts?.semanticWeight ?? 0.5;

  const keywordResults = searchMemory(db, query, { ...opts, maxResults: 50 });
  const semanticResults = searchMemorySemantic(db, queryEmbedding, { ...opts, maxResults: 50 });

  if (keywordResults.length === 0 && semanticResults.length === 0) return [];

  const keyFor = (r: SearchResult) =>
    `${r.projectId}:${r.path}:${r.startLine}:${r.endLine}`;

  function minMaxNormalize(items: SearchResult[]): Map<string, number> {
    if (items.length === 0) return new Map();
    const min = Math.min(...items.map((r) => r.score));
    const max = Math.max(...items.map((r) => r.score));
    const range = max - min;
    const m = new Map<string, number>();
    for (const r of items) {
      m.set(keyFor(r), range === 0 ? 1 : (r.score - min) / range);
    }
    return m;
  }

  const kwNorm = minMaxNormalize(keywordResults);
  const semNorm = minMaxNormalize(semanticResults);

  const allKeys = new Set<string>([
    ...keywordResults.map(keyFor),
    ...semanticResults.map(keyFor),
  ]);

  const metaMap = new Map<string, SearchResult>();
  for (const r of [...keywordResults, ...semanticResults]) {
    metaMap.set(keyFor(r), r);
  }

  const combined: Array<SearchResult & { combinedScore: number }> = [];
  for (const key of allKeys) {
    const meta = metaMap.get(key)!;
    const kwScore = kwNorm.get(key) ?? 0;
    const semScore = semNorm.get(key) ?? 0;
    const combinedScore = kw * kwScore + sw * semScore;
    combined.push({ ...meta, score: combinedScore, combinedScore });
  }

  return combined
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(({ combinedScore: _unused, ...r }) => r);
}

// ---------------------------------------------------------------------------
// Access timestamp tracking (QW2)
// ---------------------------------------------------------------------------

/**
 * Update last_accessed_at for a set of chunk IDs to the current timestamp.
 *
 * Best-effort: errors are silently ignored so search is never blocked.
 */
export function touchChunksLastAccessed(db: Database, chunkIds: string[]): void {
  if (chunkIds.length === 0) return;
  try {
    const now = Date.now();
    const placeholders = chunkIds.map(() => "?").join(", ");
    db.prepare(
      `UPDATE memory_chunks SET last_accessed_at = ? WHERE id IN (${placeholders})`
    ).run(now, ...chunkIds);
  } catch {
    // non-critical — do not block search results
  }
}
