/**
 * clusters.ts — graph_clusters endpoint handler
 *
 * Reuses the zettelThemes() agglomerative clustering algorithm and enriches
 * each cluster with observation-type statistics, avg_recency from member
 * timestamps, and helper flags for the Obsidian knowledge plugin.
 *
 * Backend compatibility:
 *   - SQLite: full support (vault files + zettel themes).
 *   - Postgres: observation type enrichment only; clustering requires SQLite.
 */

import type { Database } from "better-sqlite3";
import type { Pool } from "pg";
import { zettelThemes } from "../zettelkasten/themes.js";

// ---------------------------------------------------------------------------
// Public param / result types
// ---------------------------------------------------------------------------

export interface GraphClustersParams {
  project_id?: number;
  min_size?: number;
  max_clusters?: number;
  lookback_days?: number;
  similarity_threshold?: number;
}

export interface ClusterNode {
  id: number;
  label: string;
  size: number;
  folder_diversity: number;
  avg_recency: number;
  linked_ratio: number;
  dominant_observation_type: string;
  observation_type_counts: Record<string, number>;
  suggest_index_note: boolean;
  has_idea_note: boolean;
  notes: Array<{ vault_path: string; title: string; indexed_at: number }>;
}

export interface GraphClustersResult {
  clusters: ClusterNode[];
  total_notes_analyzed: number;
  time_window: { from: number; to: number };
}

// ---------------------------------------------------------------------------
// Observation type enrichment
// ---------------------------------------------------------------------------

/**
 * Query pai_observations (Postgres) for observation types associated with
 * the given file paths. Returns a map from vault_path → type counts.
 *
 * Falls back to an empty map when the pool is not available or the query fails.
 */
async function fetchObservationTypes(
  pool: Pool,
  filePaths: string[],
  projectId?: number
): Promise<Map<string, Record<string, number>>> {
  if (filePaths.length === 0) return new Map();

  try {
    // Build unnest-based query to avoid a large IN clause
    const params: (string | number)[] = [...filePaths];
    let projectFilter = "";
    if (projectId !== undefined) {
      params.push(projectId);
      projectFilter = `AND project_id = $${params.length}`;
    }

    // pai_observations.files_modified and files_read are text[] columns
    // We look for any observation that references any of the cluster's paths.
    const result = await pool.query<{ path: string; type: string; cnt: string }>(
      `SELECT unnested_path AS path, type, COUNT(*) AS cnt
       FROM pai_observations,
            LATERAL unnest(files_modified || files_read) AS unnested_path
       WHERE unnested_path = ANY($1::text[])
         ${projectFilter}
       GROUP BY unnested_path, type`,
      [filePaths, ...params.slice(filePaths.length)]
    );

    const byPath = new Map<string, Record<string, number>>();
    for (const row of result.rows) {
      const existing = byPath.get(row.path) ?? {};
      existing[row.type] = (existing[row.type] ?? 0) + parseInt(row.cnt, 10);
      byPath.set(row.path, existing);
    }
    return byPath;
  } catch {
    // Observations table may not exist yet — degrade gracefully
    return new Map();
  }
}

/**
 * Aggregate per-path observation type counts into cluster-level counts,
 * then pick the dominant type.
 */
function aggregateObservationTypes(
  paths: string[],
  byPath: Map<string, Record<string, number>>
): { dominant: string; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  for (const path of paths) {
    const pathCounts = byPath.get(path);
    if (!pathCounts) continue;
    for (const [type, n] of Object.entries(pathCounts)) {
      counts[type] = (counts[type] ?? 0) + n;
    }
  }

  let dominant = "unknown";
  let maxCount = 0;
  for (const [type, n] of Object.entries(counts)) {
    if (n > maxCount) {
      maxCount = n;
      dominant = type;
    }
  }

  return { dominant, counts };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleGraphClusters(
  pool: Pool | null,
  db: Database | null,
  params: GraphClustersParams
): Promise<GraphClustersResult> {
  if (!db) {
    throw new Error("graph_clusters requires SQLite backend");
  }

  const minSize = params.min_size ?? 3;
  const maxClusters = params.max_clusters ?? 20;
  const lookbackDays = params.lookback_days ?? 90;
  const similarityThreshold = params.similarity_threshold ?? 0.65;

  // Resolve vault project ID: use the provided project_id, or fall back to
  // searching for a project with a vaultPath-style root (best effort).
  const vaultProjectId = params.project_id ?? 0;

  if (!vaultProjectId) {
    throw new Error(
      "graph_clusters: project_id is required (pass the vault project's numeric ID)"
    );
  }

  // Run the zettelThemes clustering algorithm
  const themeResult = await zettelThemes(db, {
    vaultProjectId,
    lookbackDays,
    minClusterSize: minSize,
    maxThemes: maxClusters,
    similarityThreshold,
  });

  // Collect all unique note paths for observation enrichment
  const allPaths = themeResult.themes.flatMap((t) => t.notes.map((n) => n.path));

  // Fetch observation type data from Postgres (if available)
  const observationsByPath =
    pool !== null
      ? await fetchObservationTypes(pool, allPaths, params.project_id)
      : new Map<string, Record<string, number>>();

  // Enrich each ThemeCluster into a ClusterNode
  const clusters: ClusterNode[] = themeResult.themes.map((theme) => {
    const notePaths = theme.notes.map((n) => n.path);

    // Fetch indexed_at timestamps for each note
    const notesWithTimestamps = theme.notes.map((n) => {
      const row = db
        .prepare(
          `SELECT indexed_at FROM vault_files WHERE vault_path = ? LIMIT 1`
        )
        .get(n.path) as { indexed_at: number } | undefined;

      return {
        vault_path: n.path,
        title: n.title ?? n.path.split("/").pop() ?? n.path,
        indexed_at: row?.indexed_at ?? 0,
      };
    });

    // avg_recency from member timestamps (theme.avgRecency is already the mean)
    const avgRecency = theme.avgRecency;

    // Observation type enrichment
    const { dominant, counts } = aggregateObservationTypes(
      notePaths,
      observationsByPath
    );

    return {
      id: theme.id,
      label: theme.label,
      size: theme.size,
      folder_diversity: theme.folderDiversity,
      avg_recency: avgRecency,
      linked_ratio: theme.linkedRatio,
      dominant_observation_type: dominant,
      observation_type_counts: counts,
      suggest_index_note: theme.suggestIndexNote,
      has_idea_note: false, // Phase 4 feature
      notes: notesWithTimestamps,
    };
  });

  // Already sorted by zettelThemes (size * folderDiversity * recency_ratio),
  // then trimmed to maxClusters. Re-sort by size descending as the primary
  // criterion for the graph plugin consumer.
  clusters.sort((a, b) => b.size - a.size);

  return {
    clusters: clusters.slice(0, maxClusters),
    total_notes_analyzed: themeResult.totalNotesAnalyzed,
    time_window: themeResult.timeWindow,
  };
}
