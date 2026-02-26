/**
 * Search over the PAI federation memory index.
 *
 * Provides three search modes:
 *  - keyword  — BM25 full-text search (default, fast, no ML required)
 *  - semantic — Brute-force cosine similarity over pre-computed embeddings
 *  - hybrid   — Normalized combination of BM25 + cosine scores
 *
 * BM25 uses SQLite's FTS5 extension.  Semantic search requires embeddings to
 * have been generated first via `embedChunks()` in the indexer.
 */

import type { Database } from "better-sqlite3";
import { deserializeEmbedding, cosineSimilarity } from "./embeddings.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchResult {
  projectId: number;
  projectSlug?: string;   // populated from registry after search when available
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  score: number;          // raw BM25 score (lower = more relevant in FTS5)
  tier: string;
  source: string;
}

export interface SearchOptions {
  /** Restrict search to these project IDs. */
  projectIds?: number[];
  /** Restrict to 'memory' or 'notes' sources. */
  sources?: string[];
  /** Restrict to specific tier(s): 'evergreen' | 'daily' | 'topic' | 'session' */
  tiers?: string[];
  /** Maximum number of results to return. Default 10. */
  maxResults?: number;
  /** Minimum BM25 score threshold (FTS5 scores are negative; 0.0 means no filter). */
  minScore?: number;
}

// ---------------------------------------------------------------------------
// Stop words
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by",
  "do", "for", "from", "has", "have", "he", "her", "him", "his",
  "how", "i", "if", "in", "is", "it", "its", "me", "my", "not",
  "of", "on", "or", "our", "out", "she", "so", "that", "the",
  "their", "them", "they", "this", "to", "up", "us", "was", "we",
  "were", "what", "when", "who", "will", "with", "you", "your",
]);

// ---------------------------------------------------------------------------
// Query builder
// ---------------------------------------------------------------------------

/**
 * Convert a free-text query into an FTS5 query string.
 *
 * Strategy:
 *  1. Tokenise by whitespace and punctuation
 *  2. Remove stop words and tokens shorter than 2 characters
 *  3. Double-quote each remaining token (exact word form)
 *  4. Join with OR so that any matching token returns a result
 *
 * Using OR instead of AND is critical for multi-word queries: the words rarely
 * all appear in the same chunk, so AND would return zero results.  FTS5 BM25
 * scoring naturally ranks chunks where more terms match higher, so the most
 * relevant chunks still surface at the top.
 *
 * Example: "Synchrotech interview follow-up Gilles"
 *   → `"synchrotech" OR "interview" OR "follow" OR "gilles"`
 *   → chunks matching any term, ranked by how many terms match
 */
export function buildFtsQuery(query: string): string {
  const tokens = query
    .toLowerCase()
    .split(/[\s\p{P}]+/u)
    .filter(Boolean)
    .filter((t) => t.length >= 2)
    .filter((t) => !STOP_WORDS.has(t))
    // Escape any double-quotes inside the token (FTS5 uses them as delimiters)
    .map((t) => `"${t.replace(/"/g, '""')}"`)

  if (tokens.length === 0) {
    // Fallback: use original query as a raw string (may produce no results)
    return `"${query.replace(/"/g, '""')}"`;
  }

  return tokens.join(" OR ");
}

// ---------------------------------------------------------------------------
// Search
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

  // Build the SQL with optional filters
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

  // FTS5: join memory_fts with memory_chunks to get metadata
  // bm25(memory_fts) returns negative values (lower = better match)
  const sql = `
    SELECT
      c.project_id,
      c.path,
      c.start_line,
      c.end_line,
      c.text       AS snippet,
      c.tier,
      c.source,
      bm25(memory_fts) AS bm25_score
    FROM memory_fts
    JOIN memory_chunks c ON memory_fts.id = c.id
    WHERE memory_fts MATCH ?
      ${whereClause}
    ORDER BY bm25_score
    LIMIT ?
  `;

  let rows: Array<{
    project_id: number;
    path: string;
    start_line: number;
    end_line: number;
    snippet: string;
    tier: string;
    source: string;
    bm25_score: number;
  }>;

  try {
    rows = db.prepare(sql).all(...params) as typeof rows;
  } catch {
    // FTS5 MATCH throws when the query is invalid — return empty results
    return [];
  }

  const minScore = opts?.minScore ?? 0.0;

  return rows
    .map((row) => ({
      projectId: row.project_id,
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
      snippet: row.snippet,
      // Negate so higher = better match for callers
      score: -row.bm25_score,
      tier: row.tier,
      source: row.source,
    }))
    .filter((r) => r.score >= minScore);
}

// ---------------------------------------------------------------------------
// Semantic search
// ---------------------------------------------------------------------------

/**
 * Search chunks using brute-force cosine similarity over stored embeddings.
 *
 * Only chunks that have a non-null embedding BLOB are considered.  Chunks
 * without embeddings are silently skipped (they can be embedded later via
 * `embedChunks()`).
 *
 * @param queryEmbedding  Pre-computed Float32Array for the search query.
 */
export function searchMemorySemantic(
  db: Database,
  queryEmbedding: Float32Array,
  opts?: SearchOptions,
): SearchResult[] {
  const maxResults = opts?.maxResults ?? 10;

  // Build the SQL filter conditions
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

  const sql = `
    SELECT id, project_id, path, start_line, end_line, text, tier, source, embedding
    FROM memory_chunks
    ${where}
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
  }>;

  if (rows.length === 0) return [];

  // Compute cosine similarity for every chunk
  const scored = rows.map((row) => {
    const vec = deserializeEmbedding(row.embedding);
    const score = cosineSimilarity(queryEmbedding, vec);
    return {
      projectId: row.project_id,
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
      snippet: row.text,
      score,
      tier: row.tier,
      source: row.source,
    };
  });

  // Sort by descending similarity, apply optional min score filter, limit
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
 *
 * @param queryEmbedding  Pre-computed embedding for the query.
 * @param keywordWeight   Weight for BM25 score (default 0.5).
 * @param semanticWeight  Weight for cosine similarity score (default 0.5).
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

  // Fetch keyword results (no limit — we need all to normalize properly)
  const keywordResults = searchMemory(db, query, {
    ...opts,
    maxResults: 500,
  });

  // Fetch semantic results (no limit)
  const semanticResults = searchMemorySemantic(db, queryEmbedding, {
    ...opts,
    maxResults: 500,
  });

  if (keywordResults.length === 0 && semanticResults.length === 0) return [];

  // Build a map of chunk ID → combined result
  // Use "projectId:path:startLine:endLine" as a stable key (same as chunk IDs)
  const keyFor = (r: SearchResult) =>
    `${r.projectId}:${r.path}:${r.startLine}:${r.endLine}`;

  // Min-max normalize helper
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

  // Union of all chunk keys
  const allKeys = new Set<string>([
    ...keywordResults.map(keyFor),
    ...semanticResults.map(keyFor),
  ]);

  // Build a lookup from key → result metadata
  const metaMap = new Map<string, SearchResult>();
  for (const r of [...keywordResults, ...semanticResults]) {
    metaMap.set(keyFor(r), r);
  }

  // Combine scores
  const combined: Array<SearchResult & { combinedScore: number }> = [];
  for (const key of allKeys) {
    const meta = metaMap.get(key)!;
    const kwScore = kwNorm.get(key) ?? 0;
    const semScore = semNorm.get(key) ?? 0;
    const combinedScore = kw * kwScore + sw * semScore;
    combined.push({ ...meta, score: combinedScore, combinedScore });
  }

  // Sort by combined score descending
  return combined
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(({ combinedScore: _unused, ...r }) => r);
}

// ---------------------------------------------------------------------------
// Slug lookup helper
// ---------------------------------------------------------------------------

/**
 * Populate the projectSlug field on search results by looking up project IDs
 * in the registry database.
 */
export function populateSlugs(
  results: SearchResult[],
  registryDb: Database,
): SearchResult[] {
  if (results.length === 0) return results;

  const ids = [...new Set(results.map((r) => r.projectId))];
  const placeholders = ids.map(() => "?").join(", ");
  const rows = registryDb
    .prepare(`SELECT id, slug FROM projects WHERE id IN (${placeholders})`)
    .all(...ids) as Array<{ id: number; slug: string }>;

  const slugMap = new Map(rows.map((r) => [r.id, r.slug]));

  return results.map((r) => ({
    ...r,
    projectSlug: slugMap.get(r.projectId),
  }));
}
