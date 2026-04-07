/**
 * tunnels.ts — cross-project concept detection ("palace graph / tunnel detection")
 *
 * A "tunnel" is a concept (word or short phrase) that appears in chunks from
 * at least two distinct projects.  These serendipitous cross-project connections
 * are surfaced so the user can discover unexpected relationships between their
 * work streams.
 *
 * Algorithm:
 *  1. Pull the top-N most frequent significant terms from memory_chunks via BM25 FTS.
 *     We use the FTS5 vocab table (if available) or fall back to term frequency
 *     aggregation over the raw text via a trigram approach.
 *  2. For each candidate term, count how many distinct projects have at least one
 *     chunk containing it and aggregate occurrence stats.
 *  3. Filter by min_projects and min_occurrences, sort by project breadth then
 *     frequency, return top limit results.
 *
 * Backend support:
 *  - SQLite  — uses `memory_fts` MATCH to count per-project occurrences.
 *  - Postgres — uses `memory_chunks` tsvector + ts_stat for term extraction and
 *               per-project term frequency counting via plainto_tsquery.
 */

import { STOP_WORDS } from "../utils/stop-words.js";
import type { StorageBackend } from "../storage/interface.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface Tunnel {
  /** The shared term or phrase. */
  concept: string;
  /** Project slugs where this concept appears. */
  projects: string[];
  /** Total chunk occurrences across all projects. */
  occurrences: number;
  /** First time the concept appeared (Unix ms). */
  first_seen: number;
  /** Most recent time the concept appeared (Unix ms). */
  last_seen: number;
}

export interface FindTunnelsOptions {
  /** Minimum distinct projects a concept must appear in. Default 2. */
  min_projects?: number;
  /** Minimum total chunk occurrences across all projects. Default 3. */
  min_occurrences?: number;
  /** Maximum number of tunnels to return. Default 20. */
  limit?: number;
}

export interface FindTunnelsResult {
  tunnels: Tunnel[];
  projects_analyzed: number;
  total_concepts_evaluated: number;
}

// ---------------------------------------------------------------------------
// Internal row types
// ---------------------------------------------------------------------------

interface ProjectSlugMap {
  [id: number]: string;
}

// ---------------------------------------------------------------------------
// SQLite implementation
// ---------------------------------------------------------------------------

/**
 * Extract candidate terms from the SQLite FTS5 index using the vocabulary
 * approach: iterate the fts5vocab table (if it exists) for the most common
 * terms, then per-term count distinct projects.
 */
async function findTunnelsSqlite(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  slugMap: ProjectSlugMap,
  opts: Required<FindTunnelsOptions>
): Promise<FindTunnelsResult> {
  const projectIds = Object.keys(slugMap).map(Number);
  if (projectIds.length < 2) {
    return { tunnels: [], projects_analyzed: projectIds.length, total_concepts_evaluated: 0 };
  }

  // Step 1 — collect candidate terms via FTS5 vocabulary shadow table.
  // memory_fts uses the standard fts5 content table; the vocab view is
  // "memory_fts_v" if it was created, otherwise we fall back to sampling.
  let candidateTerms: string[] = [];

  try {
    // fts5vocab "col" mode: (term, col, doc, cnt) — aggregate all cols.
    const vocabRows = db
      .prepare(
        `SELECT term, SUM(doc) AS doc_count, SUM(cnt) AS total_cnt
         FROM memory_fts_v
         GROUP BY term
         HAVING SUM(cnt) >= ?
         ORDER BY SUM(doc) DESC
         LIMIT 500`
      )
      .all(opts.min_occurrences) as Array<{ term: string; doc_count: number; total_cnt: number }>;

    candidateTerms = vocabRows
      .map((r) => r.term)
      .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
  } catch {
    // Vocab table not available — fall back to sampling common words from chunks.
    // We aggregate word tokens from a sample of chunks using SQLite string ops.
    // This is slower but works on any SQLite federation.db.
    const sampleRows = db
      .prepare(
        `SELECT LOWER(text) AS text FROM memory_chunks
         WHERE LENGTH(text) > 20
         ORDER BY RANDOM()
         LIMIT 2000`
      )
      .all() as Array<{ text: string }>;

    const freq = new Map<string, number>();
    for (const { text } of sampleRows) {
      const tokens = text
        .split(/[\s\p{P}]+/u)
        .filter(Boolean)
        .filter((t: string) => t.length >= 3 && !STOP_WORDS.has(t));
      for (const t of tokens) {
        freq.set(t, (freq.get(t) ?? 0) + 1);
      }
    }
    candidateTerms = [...freq.entries()]
      .filter(([, n]) => n >= opts.min_occurrences)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 200)
      .map(([t]) => t);
  }

  if (candidateTerms.length === 0) {
    return { tunnels: [], projects_analyzed: projectIds.length, total_concepts_evaluated: 0 };
  }

  // Step 2 — for each candidate, count distinct projects and occurrences.
  const tunnels: Tunnel[] = [];

  for (const term of candidateTerms) {
    try {
      const rows = db
        .prepare(
          `SELECT c.project_id, COUNT(*) AS cnt,
                  MIN(c.updated_at) AS first_seen,
                  MAX(c.updated_at) AS last_seen
           FROM memory_fts f
           JOIN memory_chunks c ON c.id = f.id
           WHERE memory_fts MATCH ?
             AND c.project_id IN (${projectIds.map(() => "?").join(", ")})
           GROUP BY c.project_id`
        )
        .all(`"${term.replace(/"/g, '""')}"`, ...projectIds) as Array<{
          project_id: number;
          cnt: number;
          first_seen: number;
          last_seen: number;
        }>;

      if (rows.length < opts.min_projects) continue;

      const totalOccurrences = rows.reduce((s, r) => s + Number(r.cnt), 0);
      if (totalOccurrences < opts.min_occurrences) continue;

      const projects = rows
        .map((r) => slugMap[r.project_id] ?? String(r.project_id))
        .filter(Boolean);
      const firstSeen = Math.min(...rows.map((r) => r.first_seen));
      const lastSeen = Math.max(...rows.map((r) => r.last_seen));

      tunnels.push({
        concept: term,
        projects,
        occurrences: totalOccurrences,
        first_seen: firstSeen,
        last_seen: lastSeen,
      });
    } catch {
      // Skip problematic terms
      continue;
    }
  }

  // Sort: most cross-project spread first, then by raw frequency.
  tunnels.sort((a, b) => {
    const byProjects = b.projects.length - a.projects.length;
    if (byProjects !== 0) return byProjects;
    return b.occurrences - a.occurrences;
  });

  return {
    tunnels: tunnels.slice(0, opts.limit),
    projects_analyzed: projectIds.length,
    total_concepts_evaluated: candidateTerms.length,
  };
}

// ---------------------------------------------------------------------------
// Postgres implementation
// ---------------------------------------------------------------------------

/**
 * Use Postgres ts_stat() + plainto_tsquery to efficiently find terms that
 * appear across multiple projects.
 */
async function findTunnelsPostgres(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pool: any,
  slugMap: ProjectSlugMap,
  opts: Required<FindTunnelsOptions>
): Promise<FindTunnelsResult> {
  const projectIds = Object.keys(slugMap).map(Number);
  if (projectIds.length < 2) {
    return { tunnels: [], projects_analyzed: projectIds.length, total_concepts_evaluated: 0 };
  }

  // Step 1 — extract top terms from the corpus using ts_stat over all chunks.
  // ts_stat(query) returns (word, ndoc, nentry) for each lexeme in the tsvector.
  const termResult = await pool.query<{ word: string; ndoc: string; nentry: string }>(
    `SELECT word, ndoc, nentry
     FROM ts_stat(
       'SELECT to_tsvector(''simple'', text) FROM memory_chunks WHERE project_id = ANY($1)'
     )
     WHERE length(word) >= 3
       AND nentry >= $2
     ORDER BY ndoc DESC
     LIMIT 500`,
    [projectIds, opts.min_occurrences]
  );

  let candidateTerms = termResult.rows
    .map((r) => r.word)
    .filter((t) => !STOP_WORDS.has(t));

  if (candidateTerms.length === 0) {
    return { tunnels: [], projects_analyzed: projectIds.length, total_concepts_evaluated: 0 };
  }

  // Cap at 200 candidates for performance.
  candidateTerms = candidateTerms.slice(0, 200);

  // Step 2 — for each candidate, count distinct projects via a single batched query.
  // We use a VALUES list + JOIN to avoid N+1 round-trips.
  const valuesClause = candidateTerms
    .map((t, i) => `($${i + 2}::text)`)
    .join(", ");

  const batchResult = await pool.query<{
    concept: string;
    project_id: string;
    cnt: string;
    first_seen: string;
    last_seen: string;
  }>(
    `SELECT v.concept, c.project_id::text, COUNT(*) AS cnt,
            MIN(c.updated_at) AS first_seen,
            MAX(c.updated_at) AS last_seen
     FROM (VALUES ${valuesClause}) AS v(concept)
     JOIN memory_chunks c
       ON to_tsvector('simple', c.text) @@ plainto_tsquery('simple', v.concept)
      AND c.project_id = ANY($1)
     GROUP BY v.concept, c.project_id`,
    [projectIds, ...candidateTerms]
  );

  // Aggregate by concept.
  const byConceptMap = new Map<
    string,
    { projects: Set<number>; occurrences: number; firstSeen: number; lastSeen: number }
  >();

  for (const row of batchResult.rows) {
    const existing = byConceptMap.get(row.concept) ?? {
      projects: new Set<number>(),
      occurrences: 0,
      firstSeen: Infinity,
      lastSeen: -Infinity,
    };
    existing.projects.add(parseInt(row.project_id, 10));
    existing.occurrences += parseInt(row.cnt, 10);
    const fs = parseInt(row.first_seen, 10);
    const ls = parseInt(row.last_seen, 10);
    if (fs < existing.firstSeen) existing.firstSeen = fs;
    if (ls > existing.lastSeen) existing.lastSeen = ls;
    byConceptMap.set(row.concept, existing);
  }

  const tunnels: Tunnel[] = [];
  for (const [concept, data] of byConceptMap) {
    if (data.projects.size < opts.min_projects) continue;
    if (data.occurrences < opts.min_occurrences) continue;

    const projects = [...data.projects]
      .map((id) => slugMap[id] ?? String(id))
      .filter(Boolean);

    tunnels.push({
      concept,
      projects,
      occurrences: data.occurrences,
      first_seen: data.firstSeen === Infinity ? 0 : data.firstSeen,
      last_seen: data.lastSeen === -Infinity ? 0 : data.lastSeen,
    });
  }

  tunnels.sort((a, b) => {
    const byProjects = b.projects.length - a.projects.length;
    if (byProjects !== 0) return byProjects;
    return b.occurrences - a.occurrences;
  });

  return {
    tunnels: tunnels.slice(0, opts.limit),
    projects_analyzed: projectIds.length,
    total_concepts_evaluated: candidateTerms.length,
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Find cross-project concept tunnels.
 *
 * Works with both SQLite and Postgres storage backends.
 * Requires the `registryDb` (better-sqlite3) for project slug resolution.
 *
 * @param backend        Active PAI storage backend.
 * @param registryDb     Registry database for project slug resolution.
 * @param options        Filter and limit options.
 */
export async function findTunnels(
  backend: StorageBackend,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registryDb: any,
  options?: FindTunnelsOptions
): Promise<FindTunnelsResult> {
  const opts: Required<FindTunnelsOptions> = {
    min_projects: options?.min_projects ?? 2,
    min_occurrences: options?.min_occurrences ?? 3,
    limit: options?.limit ?? 20,
  };

  // Build project slug map from registry.
  const projectRows = registryDb
    .prepare("SELECT id, slug FROM projects WHERE status != 'archived'")
    .all() as Array<{ id: number; slug: string }>;

  const slugMap: ProjectSlugMap = {};
  for (const { id, slug } of projectRows) {
    slugMap[id] = slug;
  }

  if (backend.backendType === "postgres") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pool = (backend as any).getPool?.();
    if (!pool) {
      throw new Error("findTunnels: Postgres backend does not expose getPool()");
    }
    return findTunnelsPostgres(pool, slugMap, opts);
  }

  // SQLite path — access raw db through the backend adapter.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawDb = (backend as any).getRawDb?.();
  if (!rawDb) {
    throw new Error("findTunnels: SQLite backend does not expose getRawDb()");
  }
  return findTunnelsSqlite(rawDb, slugMap, opts);
}
