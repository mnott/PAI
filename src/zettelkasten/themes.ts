import type { Database } from "better-sqlite3";
import { deserializeEmbedding, cosineSimilarity } from "../memory/embeddings.js";

export interface ThemeOptions {
  vaultProjectId: number;
  lookbackDays?: number;
  minClusterSize?: number;
  maxThemes?: number;
  similarityThreshold?: number;
}

export interface ThemeCluster {
  id: number;
  label: string;
  notes: Array<{
    path: string;
    title: string | null;
  }>;
  size: number;
  folderDiversity: number;
  avgRecency: number;
  linkedRatio: number;
  suggestIndexNote: boolean;
}

export interface ThemeResult {
  themes: ThemeCluster[];
  totalNotesAnalyzed: number;
  timeWindow: { from: number; to: number };
}

const MAX_CHUNKS = 5000;

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "it", "as", "be", "was", "are",
  "has", "had", "have", "not", "this", "that", "i", "my", "we", "our",
  "new", "note", "untitled", "page", "file", "doc",
]);

function getTopFolder(vaultPath: string): string {
  const parts = vaultPath.split("/");
  return parts.length > 1 ? parts[0] : "";
}

function generateLabel(titles: Array<string | null>): string {
  const wordCounts = new Map<string, number>();
  for (const title of titles) {
    if (!title) continue;
    const words = title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
    for (const word of words) {
      wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
    }
  }
  const sorted = [...wordCounts.entries()].sort((a, b) => b[1] - a[1]);
  return sorted
    .slice(0, 3)
    .map(([w]) => w)
    .join(" / ");
}

function computeLinkedRatio(db: Database, paths: string[]): number {
  if (paths.length < 2) return 0;
  const totalPairs = (paths.length * (paths.length - 1)) / 2;
  const pathSet = new Set(paths);
  let linkedPairs = 0;

  for (const path of paths) {
    const rows = db
      .prepare(
        `SELECT target_path FROM vault_links
         WHERE source_path = ? AND target_path IS NOT NULL`,
      )
      .all(path) as Array<{ target_path: string }>;
    for (const { target_path } of rows) {
      if (pathSet.has(target_path)) {
        linkedPairs++;
      }
    }
  }

  // Each bidirectional pair might be counted once per direction; divide by 2 to normalize
  const uniquePairs = linkedPairs / 2;
  return Math.min(1, uniquePairs / totalPairs);
}

type ClusterNode = {
  paths: string[];
  titles: Array<string | null>;
  indexedAts: number[];
  centroid: Float32Array;
};

function averageEmbeddings(embeddings: Float32Array[]): Float32Array {
  if (embeddings.length === 0) return new Float32Array(0);
  const dim = embeddings[0].length;
  const sum = new Float32Array(dim);
  for (const vec of embeddings) {
    for (let i = 0; i < dim; i++) {
      sum[i] += vec[i];
    }
  }
  const avg = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    avg[i] = sum[i] / embeddings.length;
  }
  return avg;
}

/**
 * Detect emerging themes in recently-modified notes using agglomerative single-linkage
 * clustering of note-level embeddings.
 */
export async function zettelThemes(
  db: Database,
  opts: ThemeOptions,
): Promise<ThemeResult> {
  const lookbackDays = opts.lookbackDays ?? 30;
  const minClusterSize = opts.minClusterSize ?? 3;
  const maxThemes = opts.maxThemes ?? 10;
  const similarityThreshold = opts.similarityThreshold ?? 0.65;

  const now = Date.now();
  const from = now - lookbackDays * 86400000;

  // Step 1: get recent notes
  const recentNotes = db
    .prepare(
      `SELECT vault_path, title, indexed_at FROM vault_files WHERE indexed_at > ?`,
    )
    .all(from) as Array<{ vault_path: string; title: string | null; indexed_at: number }>;

  // Step 2: get file-level embeddings from memory_chunks
  const chunkRows = db
    .prepare(
      `SELECT path, embedding FROM memory_chunks
       WHERE project_id = ? AND embedding IS NOT NULL
       ORDER BY path, start_line
       LIMIT ?`,
    )
    .all(opts.vaultProjectId, MAX_CHUNKS) as Array<{ path: string; embedding: Buffer }>;

  const embeddingsByPath = new Map<string, Float32Array[]>();
  for (const row of chunkRows) {
    const vec = deserializeEmbedding(row.embedding);
    const arr = embeddingsByPath.get(row.path);
    if (!arr) {
      embeddingsByPath.set(row.path, [vec]);
    } else {
      arr.push(vec);
    }
  }

  const fileEmbeddings = new Map<string, Float32Array>();
  for (const [path, vecs] of embeddingsByPath) {
    fileEmbeddings.set(path, averageEmbeddings(vecs));
  }

  // Step 3: build initial clusters — only include notes that have embeddings
  const clusters: ClusterNode[] = [];
  for (const note of recentNotes) {
    const embedding = fileEmbeddings.get(note.vault_path);
    if (!embedding) continue;
    clusters.push({
      paths: [note.vault_path],
      titles: [note.title],
      indexedAts: [note.indexed_at],
      centroid: embedding,
    });
  }

  const totalNotesAnalyzed = clusters.length;

  // Step 4: agglomerative single-linkage clustering
  // Stop when no two clusters have similarity >= threshold
  // Using centroid similarity as a proxy for single-linkage max similarity
  let merged = true;
  while (merged && clusters.length > 1) {
    merged = false;
    let bestSim = similarityThreshold;
    let bestI = -1;
    let bestJ = -1;

    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const sim = cosineSimilarity(clusters[i].centroid, clusters[j].centroid);
        if (sim > bestSim) {
          bestSim = sim;
          bestI = i;
          bestJ = j;
        }
      }
    }

    if (bestI === -1) break;

    // Merge cluster j into cluster i
    const ci = clusters[bestI];
    const cj = clusters[bestJ];
    const mergedPaths = [...ci.paths, ...cj.paths];
    const mergedTitles = [...ci.titles, ...cj.titles];
    const mergedIndexedAts = [...ci.indexedAts, ...cj.indexedAts];

    // Recompute centroid from averaged embeddings of all member paths
    const memberEmbeddings: Float32Array[] = [];
    for (const p of mergedPaths) {
      const emb = fileEmbeddings.get(p);
      if (emb) memberEmbeddings.push(emb);
    }

    clusters[bestI] = {
      paths: mergedPaths,
      titles: mergedTitles,
      indexedAts: mergedIndexedAts,
      centroid: averageEmbeddings(memberEmbeddings),
    };

    clusters.splice(bestJ, 1);
    merged = true;
  }

  // Step 5: filter and annotate clusters
  const themes: ThemeCluster[] = [];
  let clusterIndex = 0;

  for (const cluster of clusters) {
    if (cluster.paths.length < minClusterSize) continue;

    const label = generateLabel(cluster.titles) || `Theme ${clusterIndex + 1}`;
    const avgRecency =
      cluster.indexedAts.reduce((sum, t) => sum + t, 0) / cluster.indexedAts.length;

    const uniqueFolders = new Set(cluster.paths.map(getTopFolder));
    const folderDiversity = uniqueFolders.size / cluster.paths.length;

    const linkedRatio = computeLinkedRatio(db, cluster.paths);
    const suggestIndexNote = linkedRatio < 0.3 && cluster.paths.length >= 5;

    themes.push({
      id: clusterIndex++,
      label,
      notes: cluster.paths.map((path, idx) => ({
        path,
        title: cluster.titles[idx],
      })),
      size: cluster.paths.length,
      folderDiversity,
      avgRecency,
      linkedRatio,
      suggestIndexNote,
    });
  }

  // Step 6: rank by size * folderDiversity * recency_ratio
  themes.sort(
    (a, b) =>
      b.size * b.folderDiversity * (b.avgRecency / now) -
      a.size * a.folderDiversity * (a.avgRecency / now),
  );

  return {
    themes: themes.slice(0, maxThemes),
    totalNotesAnalyzed,
    timeWindow: { from, to: now },
  };
}
