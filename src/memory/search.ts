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
import { STOP_WORDS } from "../utils/stop-words.js";

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
  updatedAt?: number;     // Unix ms from memory_chunks.updated_at
  lastAccessedAt?: number; // Unix ms from memory_chunks.last_accessed_at (QW2)
  chunkId?: string;        // chunk ID for last_accessed_at update (QW2)
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

// STOP_WORDS imported from utils/stop-words.ts

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
 *
 * Multilingual note: SQLite FTS5 uses the `unicode61` tokenizer by default,
 * which handles Unicode correctly (German umlauts, French accents, etc.) without
 * language-specific stemming. No changes needed here — it is already
 * multilingual-safe.
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
  } catch {
    // FTS5 MATCH throws when the query is invalid — return empty results
    return [];
  }

  const minScore = opts?.minScore ?? 0.0;

  return rows
    .map((row) => {
      // Negate so higher = better match for callers
      const baseScore = -row.bm25_score;
      // MR2: scale by feedback relevance_score: multiplier in [0.5, 1.5]
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

  // Compute cosine similarity for every chunk
  const scored = rows.map((row) => {
    const vec = deserializeEmbedding(row.embedding);
    const baseScore = cosineSimilarity(queryEmbedding, vec);
    // MR2: scale by feedback relevance_score: multiplier in [0.5, 1.5]
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

  // Fetch keyword results — 50 candidates is sufficient for min-max normalization
  const keywordResults = searchMemory(db, query, {
    ...opts,
    maxResults: 50,
  });

  // Fetch semantic results — 50 candidates is sufficient for min-max normalization
  const semanticResults = searchMemorySemantic(db, queryEmbedding, {
    ...opts,
    maxResults: 50,
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
// Access timestamp tracking (QW2)
// ---------------------------------------------------------------------------

/**
 * Update last_accessed_at for a set of chunk IDs to the current timestamp.
 *
 * Called after a successful search to record that these chunks were retrieved.
 * This enables the recency boost to account for access patterns, not just
 * modification time.
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

// ---------------------------------------------------------------------------
// Recency boost
// ---------------------------------------------------------------------------

/**
 * Apply exponential recency boost to search scores.
 *
 * Scores are first min-max normalized to [0,1], then multiplied by an
 * exponential decay factor based on chunk age.  Normalization is required
 * because the cross-encoder reranker produces negative logit scores — naive
 * multiplication of a negative score by a decay factor (0 < d ≤ 1) would
 * make the score *less* negative, effectively boosting old results instead
 * of penalizing them.
 *
 * Formula: score_final = normalized * exp(-lambda * age_days)
 * where lambda = ln(2) / halfLifeDays, normalized ∈ [0,1]
 *
 * With default halfLifeDays=90, a 3-month-old chunk retains 50% of its
 * normalized score, a 6-month-old retains 25%, and a 1-year-old ~6%.
 *
 * Results without an updatedAt timestamp receive no decay penalty.
 * Results are re-sorted by the boosted score after application.
 *
 * @param results      Search results with optional updatedAt timestamps.
 * @param halfLifeDays Score halves every N days. Default 90 (~3 months).
 * @returns New array sorted by decayed normalized score (descending).
 */
export function applyRecencyBoost(
  results: SearchResult[],
  halfLifeDays = 90,
): SearchResult[] {
  if (halfLifeDays <= 0 || results.length === 0) return results;

  const lambda = Math.LN2 / halfLifeDays;
  const now = Date.now();

  // Min-max normalize scores to [0,1] so multiplicative decay works
  // correctly regardless of the raw score sign/scale.
  const scores = results.map((r) => r.score);
  const minScore = Math.min(...scores);
  const maxScore = Math.max(...scores);
  const range = maxScore - minScore;

  return results
    .map((r) => {
      const normalized = range === 0 ? 1 : (r.score - minScore) / range;
      // QW2: use the more recent of updated_at and last_accessed_at for recency decay
      const effectiveTs = r.updatedAt != null && r.lastAccessedAt != null
        ? Math.max(r.updatedAt, r.lastAccessedAt)
        : (r.lastAccessedAt ?? r.updatedAt);
      const decay = effectiveTs
        ? Math.exp(-lambda * Math.max(0, (now - effectiveTs) / 86_400_000))
        : 1; // no timestamp → no penalty
      return { ...r, score: normalized * decay };
    })
    .sort((a, b) => b.score - a.score);
}
