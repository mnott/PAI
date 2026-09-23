/**
 * Postgres implementation of cross-project concept "tunnel" detection —
 * moved from memory/tunnels.ts alongside its SQLite counterpart
 * (storage/sqlite/tunnels.ts) so raw SQL against the federation database
 * lives entirely under src/storage/.
 *
 * Uses ts_stat() + plainto_tsquery to efficiently find terms that appear
 * across multiple projects.
 */

import { STOP_WORDS } from "../../utils/stop-words.js";
import type { PgPoolLike } from "../pg-types.js";
import type { RegistryBackend } from "../registry-interface.js";
import type { Tunnel, FindTunnelsOptions, FindTunnelsResult } from "../../memory/tunnels.js";

interface ProjectSlugMap {
  [id: number]: string;
}

async function findTunnelsForSlugMap(
  pool: PgPoolLike,
  slugMap: ProjectSlugMap,
  opts: Required<FindTunnelsOptions>,
): Promise<FindTunnelsResult> {
  const projectIds = Object.keys(slugMap).map(Number);
  if (projectIds.length < 2) {
    return { tunnels: [], projects_analyzed: projectIds.length, total_concepts_evaluated: 0 };
  }

  // Step 1 — extract top terms from the corpus using ts_stat over all chunks.
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

  candidateTerms = candidateTerms.slice(0, 200);

  // Step 2 — for each candidate, count distinct projects via a single batched query.
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

/** Find cross-project concept tunnels against a Postgres federation database. */
export async function findTunnelsPostgres(
  pool: PgPoolLike,
  registry: RegistryBackend,
  options?: FindTunnelsOptions,
): Promise<FindTunnelsResult> {
  const opts: Required<FindTunnelsOptions> = {
    min_projects: options?.min_projects ?? 2,
    min_occurrences: options?.min_occurrences ?? 3,
    limit: options?.limit ?? 20,
  };

  const projectRows = await registry.listProjects({ excludeArchived: true });
  const slugMap: ProjectSlugMap = {};
  for (const { id, slug } of projectRows) {
    slugMap[id] = slug;
  }

  return findTunnelsForSlugMap(pool, slugMap, opts);
}
