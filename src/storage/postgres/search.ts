/**
 * Keyword and semantic search implementations for the Postgres backend.
 * Functions take a `pool` parameter so they can be called from PostgresBackend methods.
 */

import type { Pool } from "pg";
import type { SearchResult, SearchOptions } from "../../memory/search.js";
import { buildPgTsQuery } from "./helpers.js";

/**
 * A failed search must not look like a search that found nothing.
 *
 * Both functions below used to catch, log to stderr, and `return []`. The log goes
 * to the daemon's own stderr, which no caller ever sees, so an unreachable backend
 * and a genuine miss were BYTE-IDENTICAL at the call site — `memory_search`
 * reported "No results found for query: …" either way.
 *
 * That cost a real wrong answer on 2026-08-04. `pai-pgvector` exited at 13:39Z and
 * the index lived inside it; for the next two hours every memory_search returned
 * cleanly empty. A sibling session searched for an open DMARC point, got nothing,
 * and told Matthias nothing was recorded. The search had run against a dead
 * backend and was worthless — and nothing in the reply could have revealed that.
 *
 * So: throw. The MCP shim already turns a thrown error into a visible message, and
 * an error the user can act on beats an empty result they cannot distinguish from
 * the truth. This deliberately makes transient failures noisier — that is the
 * trade, and it is the right way round.
 */
function searchFailure(kind: "keyword" | "semantic", cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `Postgres ${kind} search failed — the memory index is unreachable, ` +
      `so this is NOT an empty result set. Check the backend is up ` +
      `(docker start pai-pgvector) and see pai daemon status. Cause: ${detail}`
  );
}

/**
 * Full-text keyword search using Postgres tsvector/tsquery with 'simple' dictionary.
 */
export async function searchKeyword(
  pool: Pool,
  query: string,
  opts?: SearchOptions
): Promise<SearchResult[]> {
  const maxResults = opts?.maxResults ?? 10;

  const tsQuery = buildPgTsQuery(query);
  if (!tsQuery) return [];

  const conditions: string[] = ["fts_vector @@ to_tsquery('simple', $1)"];
  const params: (string | number)[] = [tsQuery];
  let paramIdx = 2;

  if (opts?.projectIds && opts.projectIds.length > 0) {
    const placeholders = opts.projectIds.map(() => `$${paramIdx++}`).join(", ");
    conditions.push(`project_id IN (${placeholders})`);
    params.push(...opts.projectIds);
  }

  if (opts?.sources && opts.sources.length > 0) {
    const placeholders = opts.sources.map(() => `$${paramIdx++}`).join(", ");
    conditions.push(`source IN (${placeholders})`);
    params.push(...opts.sources);
  }

  if (opts?.tiers && opts.tiers.length > 0) {
    const placeholders = opts.tiers.map(() => `$${paramIdx++}`).join(", ");
    conditions.push(`tier IN (${placeholders})`);
    params.push(...opts.tiers);
  }

  params.push(maxResults);
  const limitParam = `$${paramIdx}`;

  const sql = `
    SELECT
      project_id,
      path,
      start_line,
      end_line,
      text AS snippet,
      tier,
      source,
      ts_rank(fts_vector, to_tsquery('simple', $1)) AS rank_score
    FROM pai_chunks
    WHERE ${conditions.join(" AND ")}
    ORDER BY rank_score DESC
    LIMIT ${limitParam}
  `;

  try {
    const result = await pool.query<{
      project_id: number;
      path: string;
      start_line: number;
      end_line: number;
      snippet: string;
      tier: string;
      source: string;
      rank_score: number;
    }>(sql, params);

    return result.rows.map((row) => ({
      projectId: row.project_id,
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
      snippet: row.snippet,
      score: row.rank_score,
      tier: row.tier,
      source: row.source,
    }));
  } catch (e) {
    process.stderr.write(`[pai-postgres] searchKeyword error: ${e}\n`);
    throw searchFailure("keyword", e);
  }
}

/**
 * Semantic vector similarity search using pgvector cosine distance (<=>).
 */
export async function searchSemantic(
  pool: Pool,
  queryEmbedding: Float32Array,
  opts?: SearchOptions
): Promise<SearchResult[]> {
  const maxResults = opts?.maxResults ?? 10;

  const conditions: string[] = ["embedding IS NOT NULL"];
  const params: (string | number)[] = [];
  let paramIdx = 1;

  const vecStr = "[" + Array.from(queryEmbedding).join(",") + "]";
  params.push(vecStr);
  const vecParam = `$${paramIdx++}`;

  if (opts?.projectIds && opts.projectIds.length > 0) {
    const placeholders = opts.projectIds.map(() => `$${paramIdx++}`).join(", ");
    conditions.push(`project_id IN (${placeholders})`);
    params.push(...opts.projectIds);
  }

  if (opts?.sources && opts.sources.length > 0) {
    const placeholders = opts.sources.map(() => `$${paramIdx++}`).join(", ");
    conditions.push(`source IN (${placeholders})`);
    params.push(...opts.sources);
  }

  if (opts?.tiers && opts.tiers.length > 0) {
    const placeholders = opts.tiers.map(() => `$${paramIdx++}`).join(", ");
    conditions.push(`tier IN (${placeholders})`);
    params.push(...opts.tiers);
  }

  params.push(maxResults);
  const limitParam = `$${paramIdx}`;

  // <=> is cosine distance; 1 - distance = cosine similarity
  const sql = `
    SELECT
      project_id,
      path,
      start_line,
      end_line,
      text AS snippet,
      tier,
      source,
      1 - (embedding <=> ${vecParam}::vector) AS cosine_similarity
    FROM pai_chunks
    WHERE ${conditions.join(" AND ")}
    ORDER BY embedding <=> ${vecParam}::vector
    LIMIT ${limitParam}
  `;

  try {
    const result = await pool.query<{
      project_id: number;
      path: string;
      start_line: number;
      end_line: number;
      snippet: string;
      tier: string;
      source: string;
      cosine_similarity: number;
    }>(sql, params);

    const minScore = opts?.minScore ?? -Infinity;

    return result.rows
      .map((row) => ({
        projectId: row.project_id,
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line,
        snippet: row.snippet,
        score: row.cosine_similarity,
        tier: row.tier,
        source: row.source,
      }))
      .filter((r) => r.score >= minScore);
  } catch (e) {
    process.stderr.write(`[pai-postgres] searchSemantic error: ${e}\n`);
    throw searchFailure("semantic", e);
  }
}
