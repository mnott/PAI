/**
 * Query building and result post-processing for the PAI federation memory
 * index — everything here is pure logic (no SQL). The raw FTS5/vector
 * queries live under src/storage/{sqlite,postgres}/search.ts, which call
 * back into buildFtsQuery()/isQuerySyntaxError() from this module.
 */

import { STOP_WORDS } from "../utils/stop-words.js";
import type { RegistryBackend } from "../storage/registry-interface.js";

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
/**
 * Did SQLite reject the QUERY, or fail at the STORE?
 *
 * Only the first justifies an empty result. FTS5 reports a bad MATCH expression
 * with a recognisable message; a missing table, a corrupt index or a locked
 * database do not, and must not be reported as "nothing found".
 *
 * Matching on message text is unlovely, and the alternative — treating every
 * failure as empty — is what produced a confidently wrong answer to a human.
 */
export function isQuerySyntaxError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /fts5|malformed MATCH|syntax error|unterminated string|no such column/i.test(msg);
}

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

// The raw searchMemory()/searchMemorySemantic()/searchMemoryHybrid()/
// touchChunksLastAccessed() implementations live in storage/sqlite/search.ts
// (SQLite) and storage/postgres/search.ts + backend.ts (Postgres).

// ---------------------------------------------------------------------------
// Slug lookup helper
// ---------------------------------------------------------------------------

/**
 * Populate the projectSlug field on search results by looking up project IDs
 * in the registry database.
 */
export async function populateSlugs(
  results: SearchResult[],
  registry: RegistryBackend,
): Promise<SearchResult[]> {
  if (results.length === 0) return results;

  const ids = [...new Set(results.map((r) => r.projectId))];
  // No batch "projects by ids" method on RegistryBackend yet (flagged in the
  // report) — loops getProjectById, bounded by the distinct project count in
  // an already-capped result set.
  const slugMap = new Map<number, string>();
  for (const id of ids) {
    const project = await registry.getProjectById(id);
    if (project) slugMap.set(id, project.slug);
  }

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
