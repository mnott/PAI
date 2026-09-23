/**
 * SQLite implementation of cross-project concept "tunnel" detection — moved
 * from memory/tunnels.ts so the only file that runs raw FTS5/vocab SQL
 * against the federation database lives under src/storage/.
 *
 * Algorithm: pull candidate terms from the FTS5 vocabulary shadow table (or
 * sample chunk text when the vocab view is unavailable), then for each
 * candidate count distinct projects and total occurrences.
 */

import type { Database } from "better-sqlite3";
import { STOP_WORDS } from "../../utils/stop-words.js";
import type { RegistryBackend } from "../registry-interface.js";
import type { Tunnel, FindTunnelsOptions, FindTunnelsResult } from "../../memory/tunnels.js";

interface ProjectSlugMap {
  [id: number]: string;
}

async function findTunnelsForSlugMap(
  db: Database,
  slugMap: ProjectSlugMap,
  opts: Required<FindTunnelsOptions>,
): Promise<FindTunnelsResult> {
  const projectIds = Object.keys(slugMap).map(Number);
  if (projectIds.length < 2) {
    return { tunnels: [], projects_analyzed: projectIds.length, total_concepts_evaluated: 0 };
  }

  // Step 1 — collect candidate terms via FTS5 vocabulary shadow table.
  let candidateTerms: string[] = [];

  try {
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

/** Find cross-project concept tunnels against a SQLite federation database. */
export async function findTunnelsSqlite(
  db: Database,
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

  return findTunnelsForSlugMap(db, slugMap, opts);
}
