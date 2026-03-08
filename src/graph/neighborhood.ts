/**
 * neighborhood.ts — graph_neighborhood endpoint handler
 *
 * Given a set of vault note paths (typically the notes inside a cluster),
 * returns the individual note nodes and the wikilink edges between them.
 *
 * Optionally enriches with semantic edges computed from cosine similarity
 * between chunk embeddings stored in the federation database.
 */

import type { StorageBackend } from "../storage/interface.js";
import type { Pool } from "pg";
import { deserializeEmbedding } from "../memory/embeddings.js";

// ---------------------------------------------------------------------------
// Public param / result types
// ---------------------------------------------------------------------------

export interface GraphNeighborhoodParams {
  /** Vault-relative paths of notes in the cluster */
  vault_paths: string[];
  /** Numeric PAI project ID */
  project_id: number;
  /** Whether to compute semantic similarity edges (default: false) */
  include_semantic_edges?: boolean;
  /** Cosine similarity threshold for semantic edges (default: 0.7) */
  semantic_threshold?: number;
}

export interface NoteNode {
  vault_path: string;
  title: string;
  folder: string;
  observation_types: Record<string, number>;
  dominant_type: string;
  updated_at: number;
  word_count: number;
}

export interface NoteEdge {
  source: string;
  target: string;
  type: "wikilink" | "semantic";
  weight: number;
}

export interface GraphNeighborhoodResult {
  nodes: NoteNode[];
  edges: NoteEdge[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function folderFromPath(vaultPath: string): string {
  const lastSlash = vaultPath.lastIndexOf("/");
  return lastSlash === -1 ? "" : vaultPath.slice(0, lastSlash);
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function dominantType(counts: Record<string, number>): string {
  let dominant = "unknown";
  let maxCount = 0;
  for (const [type, n] of Object.entries(counts)) {
    if (n > maxCount) {
      maxCount = n;
      dominant = type;
    }
  }
  return dominant;
}

// ---------------------------------------------------------------------------
// Observation type enrichment (same pattern as clusters.ts)
// ---------------------------------------------------------------------------

async function fetchObservationTypes(
  pool: Pool,
  filePaths: string[],
  projectId: number
): Promise<Map<string, Record<string, number>>> {
  if (filePaths.length === 0) return new Map();

  try {
    const params: (string[] | number)[] = [filePaths, projectId];

    const result = await pool.query<{ path: string; type: string; cnt: string }>(
      `SELECT unnested_path AS path, type, COUNT(*) AS cnt
       FROM pai_observations,
            LATERAL unnest(files_modified || files_read) AS unnested_path
       WHERE unnested_path = ANY($1::text[])
         AND project_id = $2
       GROUP BY unnested_path, type`,
      params
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

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleGraphNeighborhood(
  pool: Pool | null,
  backend: StorageBackend,
  params: GraphNeighborhoodParams
): Promise<GraphNeighborhoodResult> {
  const vaultPaths = params.vault_paths ?? [];
  if (vaultPaths.length === 0) {
    return { nodes: [], edges: [] };
  }

  const includeSemanticEdges = params.include_semantic_edges ?? false;
  const semanticThreshold = params.semantic_threshold ?? 0.7;

  // -------------------------------------------------------------------------
  // 1. Fetch node metadata from vault_files
  // -------------------------------------------------------------------------

  const fileRows = await backend.getVaultFilesByPaths(vaultPaths);

  const fileIndex = new Map<string, { vaultPath: string; title: string | null; indexedAt: number }>();
  for (const row of fileRows) {
    fileIndex.set(row.vaultPath, row);
  }

  // -------------------------------------------------------------------------
  // 2. Fetch observation types (Postgres if available)
  // -------------------------------------------------------------------------

  const observationsByPath =
    pool !== null
      ? await fetchObservationTypes(pool, vaultPaths, params.project_id)
      : new Map<string, Record<string, number>>();

  // -------------------------------------------------------------------------
  // 3. Build NoteNode array
  // -------------------------------------------------------------------------

  const nodes: NoteNode[] = vaultPaths.map((vp) => {
    const fileRow = fileIndex.get(vp);
    const fileName = vp.split("/").pop() ?? vp;
    const rawTitle = fileRow?.title ?? fileName.replace(/\.md$/i, "");

    const obsCounts = observationsByPath.get(vp) ?? {};

    return {
      vault_path: vp,
      title: rawTitle,
      folder: folderFromPath(vp),
      observation_types: obsCounts,
      dominant_type: dominantType(obsCounts),
      updated_at: fileRow?.indexedAt ?? 0,
      word_count: 0,
    };
  });

  // -------------------------------------------------------------------------
  // 4. Fetch wikilink edges between the provided paths
  // -------------------------------------------------------------------------

  const pathSet = new Set(vaultPaths);
  const linkRows = await backend.getVaultLinksFromPaths(vaultPaths);

  const edges: NoteEdge[] = [];

  for (const row of linkRows) {
    if (!row.targetPath || !pathSet.has(row.targetPath)) continue;

    edges.push({
      source: row.sourcePath,
      target: row.targetPath,
      type: "wikilink",
      weight: 1.0,
    });
  }

  // -------------------------------------------------------------------------
  // 5. Optional: semantic edges
  // -------------------------------------------------------------------------

  if (includeSemanticEdges && vaultPaths.length > 1) {
    // Fetch mean embeddings for all paths
    const embeddings = new Map<string, number[]>();
    for (const vp of vaultPaths) {
      const chunkRows = await backend.getChunksForPath(params.project_id, vp);
      const embRows = chunkRows.filter(r => r.embedding !== null) as Array<{ text: string; embedding: Buffer }>;
      if (embRows.length === 0) continue;

      let vecLen = 0;
      const vectors: Float32Array[] = [];

      for (const row of embRows) {
        const arr = deserializeEmbedding(row.embedding);
        if (vecLen === 0) vecLen = arr.length;
        if (arr.length === vecLen) vectors.push(arr);
      }

      if (vectors.length === 0 || vecLen === 0) continue;

      const mean = new Array<number>(vecLen).fill(0);
      for (const vec of vectors) {
        for (let i = 0; i < vecLen; i++) {
          mean[i] += vec[i];
        }
      }
      for (let i = 0; i < vecLen; i++) {
        mean[i] /= vectors.length;
      }
      embeddings.set(vp, mean);
    }

    const existingEdgeKeys = new Set<string>(
      edges.map((e) => `${e.source}|||${e.target}`)
    );

    const pathsWithEmbeddings = Array.from(embeddings.keys());
    for (let i = 0; i < pathsWithEmbeddings.length; i++) {
      for (let j = i + 1; j < pathsWithEmbeddings.length; j++) {
        const pathA = pathsWithEmbeddings[i];
        const pathB = pathsWithEmbeddings[j];

        const vecA = embeddings.get(pathA)!;
        const vecB = embeddings.get(pathB)!;

        const sim = cosineSimilarity(vecA, vecB);
        if (sim < semanticThreshold) continue;

        const keyAB = `${pathA}|||${pathB}`;
        const keyBA = `${pathB}|||${pathA}`;
        if (existingEdgeKeys.has(keyAB) || existingEdgeKeys.has(keyBA)) continue;

        edges.push({
          source: pathA,
          target: pathB,
          type: "semantic",
          weight: sim,
        });
        existingEdgeKeys.add(keyAB);
      }
    }
  }

  return { nodes, edges };
}
