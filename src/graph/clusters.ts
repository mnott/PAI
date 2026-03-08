/**
 * clusters.ts — graph_clusters endpoint handler
 *
 * Reuses the zettelThemes() agglomerative clustering algorithm and enriches
 * each cluster with observation-type statistics, avg_recency from member
 * timestamps, and helper flags for the Obsidian knowledge plugin.
 */

import type { StorageBackend } from "../storage/interface.js";
import type { Pool } from "pg";

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
    const params: (string | number)[] = [...filePaths];
    let projectFilter = "";
    if (projectId !== undefined) {
      params.push(projectId);
      projectFilter = `AND project_id = $${params.length}`;
    }

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
// Link-based fallback clustering (wikilink connected components)
// ---------------------------------------------------------------------------

const SKIP_PREFIXES = [
  "Attachments/", "🗓️ Daily Notes/", "Copilot/copilot-conversations/",
  "Z - Zettelkasten/Tweets/",
];

/**
 * Cluster vault notes by wikilink connectivity when embeddings aren't available.
 * Uses BFS to find connected components in the link graph, then picks the
 * largest components as clusters. Labels are derived from the most common
 * title words in each component.
 */
async function clusterByLinks(
  backend: StorageBackend,
  lookbackDays: number,
  minSize: number,
  maxClusters: number,
): Promise<{ themes: Array<{ id: number; label: string; notes: Array<{ path: string; title: string | null }>; size: number; folderDiversity: number; avgRecency: number; linkedRatio: number; suggestIndexNote: boolean }>; totalNotesAnalyzed: number; timeWindow: { from: number; to: number } }> {
  const now = Date.now();
  const from = now - lookbackDays * 86400000;

  // Get recent notes
  const recentFiles = await backend.getRecentVaultFiles(from);
  const recentNotes = recentFiles.filter(f => f.vaultPath.endsWith(".md"));

  const noteMap = new Map<string, { title: string | null; indexed_at: number }>();
  for (const n of recentNotes) {
    noteMap.set(n.vaultPath, { title: n.title, indexed_at: n.indexedAt });
  }

  // Build adjacency list from vault_links (only for recent notes)
  const adj = new Map<string, Set<string>>();
  for (const path of noteMap.keys()) {
    if (!adj.has(path)) adj.set(path, new Set());
  }

  const linkGraph = await backend.getVaultLinkGraph();

  for (const { source_path, target_path } of linkGraph) {
    if (noteMap.has(source_path) && noteMap.has(target_path)) {
      adj.get(source_path)!.add(target_path);
      adj.get(target_path)!.add(source_path);
    }
  }

  // Remove hub nodes before BFS
  const degrees = [...adj.entries()].map(([p, s]) => ({ path: p, degree: s.size }));
  degrees.sort((a, b) => b.degree - a.degree);
  const hubThreshold = Math.max(10, degrees[Math.floor(degrees.length * 0.05)]?.degree ?? 10);
  const hubNodes = new Set<string>();
  for (const { path, degree } of degrees) {
    if (degree >= hubThreshold) hubNodes.add(path);
    else break;
  }

  for (const hub of hubNodes) {
    adj.delete(hub);
  }
  for (const [, neighbors] of adj) {
    for (const hub of hubNodes) {
      neighbors.delete(hub);
    }
  }

  // BFS connected components
  const visited = new Set<string>();
  const components: string[][] = [];

  for (const path of noteMap.keys()) {
    if (visited.has(path) || hubNodes.has(path)) continue;
    if (SKIP_PREFIXES.some(p => path.startsWith(p))) { visited.add(path); continue; }
    const component: string[] = [];
    const queue = [path];
    visited.add(path);

    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);
      const neighbors = adj.get(current);
      if (!neighbors) continue;
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor) && !SKIP_PREFIXES.some(p => neighbor.startsWith(p))) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    if (component.length >= minSize) {
      components.push(component);
    }
  }

  components.sort((a, b) => b.length - a.length);
  const topComponents = components.slice(0, maxClusters);

  const STOP_WORDS = new Set([
    "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "is", "it", "as", "be", "was", "are",
    "has", "had", "have", "not", "this", "that", "i", "my", "we", "our",
    "new", "note", "untitled", "page", "file", "doc", "session", "notes",
    "moc", "template", "content", "attachment",
    "les", "des", "une", "est", "que", "qui", "dans", "pour", "sur",
    "par", "pas", "son", "ses", "aux", "avec", "tout", "mais",
    "und", "der", "die", "das", "ein", "eine", "ist", "den", "dem",
    "von", "mit", "auf", "nicht", "sich", "auch", "noch", "wie",
  ]);

  function generateLinkLabel(paths: string[]): string {
    const wordCounts = new Map<string, number>();
    for (const p of paths) {
      const title = noteMap.get(p)?.title;
      if (!title) continue;
      const words = title.toLowerCase().replace(/[^a-z0-9äöüàéèêëçñß\s]/g, " ").split(/\s+/)
        .filter(w => w.length > 2 && !STOP_WORDS.has(w));
      for (const word of words) {
        wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
      }
    }
    const sorted = [...wordCounts.entries()].sort((a, b) => b[1] - a[1]);
    return sorted.slice(0, 3).map(([w]) => w).join(" / ") || "Linked Notes";
  }

  const themes = topComponents.map((component, idx) => {
    const notes = component.map(p => ({
      path: p,
      title: noteMap.get(p)?.title ?? null,
    }));
    const avgRecency = component.reduce((sum, p) => sum + (noteMap.get(p)?.indexed_at ?? 0), 0) / component.length;
    const uniqueFolders = new Set(component.map(p => p.split("/")[0]));

    return {
      id: idx,
      label: generateLinkLabel(component),
      notes,
      size: component.length,
      folderDiversity: uniqueFolders.size / component.length,
      avgRecency,
      linkedRatio: 1.0,
      suggestIndexNote: component.length >= 10,
    };
  });

  return {
    themes,
    totalNotesAnalyzed: recentNotes.length,
    timeWindow: { from, to: now },
  };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleGraphClusters(
  pool: Pool | null,
  backend: StorageBackend,
  params: GraphClustersParams
): Promise<GraphClustersResult> {
  const minSize = params.min_size ?? 3;
  const maxClusters = params.max_clusters ?? 20;
  const lookbackDays = params.lookback_days ?? 90;

  const vaultProjectId = params.project_id ?? 0;

  if (!vaultProjectId) {
    throw new Error(
      "graph_clusters: project_id is required (pass the vault project's numeric ID)"
    );
  }

  const themeResult = await clusterByLinks(backend, lookbackDays, minSize, maxClusters);

  const allPaths = themeResult.themes.flatMap((t) => t.notes.map((n) => n.path));

  const observationsByPath =
    pool !== null
      ? await fetchObservationTypes(pool, allPaths, params.project_id)
      : new Map<string, Record<string, number>>();

  // Fetch indexed_at timestamps for all notes in bulk
  const fileRows = await backend.getVaultFilesByPaths(allPaths);
  const indexedAtMap = new Map<string, number>(fileRows.map(f => [f.vaultPath, f.indexedAt]));

  const clusters: ClusterNode[] = themeResult.themes.map((theme) => {
    const notePaths = theme.notes.map((n) => n.path);

    const notesWithTimestamps = theme.notes.map((n) => ({
      vault_path: n.path,
      title: n.title ?? n.path.split("/").pop() ?? n.path,
      indexed_at: indexedAtMap.get(n.path) ?? 0,
    }));

    const avgRecency = theme.avgRecency;

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
      has_idea_note: false,
      notes: notesWithTimestamps,
    };
  });

  clusters.sort((a, b) => b.size - a.size);

  return {
    clusters: clusters.slice(0, maxClusters),
    total_notes_analyzed: themeResult.totalNotesAnalyzed,
    time_window: themeResult.timeWindow,
  };
}
