/**
 * neighborhood.ts — graph_neighborhood endpoint handler
 *
 * Given a set of vault note paths (typically the notes inside a cluster),
 * returns the individual note nodes and the wikilink edges between them.
 *
 * Optionally enriches with semantic edges computed from cosine similarity
 * between chunk embeddings stored in the SQLite federation database.
 *
 * Backend compatibility:
 *   - SQLite: full support (vault_files + vault_links + chunk embeddings).
 *   - Postgres: observation type enrichment only; graph data requires SQLite.
 */

import type { Database } from "better-sqlite3";
import type { Pool } from "pg";

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
  /** Vault-relative path, e.g. "Projects/PAI/idea-2024.md" */
  vault_path: string;
  /** Note title from frontmatter or H1; falls back to filename */
  title: string;
  /** Parent folder path derived from vault_path */
  folder: string;
  /** Per-type observation count breakdown */
  observation_types: Record<string, number>;
  /** The most common observation type, or "unknown" */
  dominant_type: string;
  /** Unix timestamp (seconds) of last indexing */
  updated_at: number;
  /** Word count (0 when not stored in schema) */
  word_count: number;
}

export interface NoteEdge {
  /** Source vault_path */
  source: string;
  /** Target vault_path */
  target: string;
  /** "wikilink" for explicit Obsidian links, "semantic" for embedding similarity */
  type: "wikilink" | "semantic";
  /** 1.0 for wikilinks; cosine similarity score for semantic edges */
  weight: number;
}

export interface GraphNeighborhoodResult {
  nodes: NoteNode[];
  edges: NoteEdge[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive the folder portion of a vault path.
 * "Projects/PAI/ideas.md" → "Projects/PAI"
 * "top-level.md" → ""
 */
function folderFromPath(vaultPath: string): string {
  const lastSlash = vaultPath.lastIndexOf("/");
  return lastSlash === -1 ? "" : vaultPath.slice(0, lastSlash);
}

/**
 * Compute cosine similarity between two Float32/Float64 arrays.
 * Returns 0 when either vector is all-zeros.
 */
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
// Semantic edge computation (optional)
// ---------------------------------------------------------------------------

/**
 * Fetch the mean embedding vector for a vault path by averaging all chunk
 * embeddings stored in the `memory_chunks` table for that file.
 *
 * Returns null when no chunks are found.
 */
function fetchMeanEmbedding(db: Database, vaultPath: string): number[] | null {
  type ChunkRow = { embedding: Buffer | null };

  // memory_chunks has a direct `path` column (vault-relative path); no join needed
  const rows = db
    .prepare(
      `SELECT embedding
       FROM memory_chunks
       WHERE path = ?
         AND embedding IS NOT NULL`
    )
    .all(vaultPath) as ChunkRow[];

  if (rows.length === 0) return null;

  // Deserialise Float32 binary buffers and accumulate
  let vecLen = 0;
  const vectors: Float32Array[] = [];

  for (const row of rows) {
    if (!row.embedding) continue;
    const arr = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
    if (vecLen === 0) vecLen = arr.length;
    if (arr.length === vecLen) {
      vectors.push(arr);
    }
  }

  if (vectors.length === 0 || vecLen === 0) return null;

  // Mean of all chunk embeddings
  const mean = new Array<number>(vecLen).fill(0);
  for (const vec of vectors) {
    for (let i = 0; i < vecLen; i++) {
      mean[i] += vec[i];
    }
  }
  for (let i = 0; i < vecLen; i++) {
    mean[i] /= vectors.length;
  }

  return mean;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleGraphNeighborhood(
  pool: Pool | null,
  db: Database | null,
  params: GraphNeighborhoodParams
): Promise<GraphNeighborhoodResult> {
  if (!db) {
    throw new Error("graph_neighborhood requires SQLite backend");
  }

  const vaultPaths = params.vault_paths ?? [];
  if (vaultPaths.length === 0) {
    return { nodes: [], edges: [] };
  }

  const includeSemanticEdges = params.include_semantic_edges ?? false;
  const semanticThreshold = params.semantic_threshold ?? 0.7;

  // -------------------------------------------------------------------------
  // 1. Fetch node metadata from vault_files
  // -------------------------------------------------------------------------

  type VaultFileRow = {
    vault_path: string;
    title: string | null;
    indexed_at: number;
  };

  // Build a placeholder list for SQLite IN clause
  const placeholders = vaultPaths.map(() => "?").join(", ");
  const fileRows = db
    .prepare(
      `SELECT vault_path, title, indexed_at
       FROM vault_files
       WHERE vault_path IN (${placeholders})`
    )
    .all(...vaultPaths) as VaultFileRow[];

  // Index by vault_path for quick lookup
  const fileIndex = new Map<string, VaultFileRow>();
  for (const row of fileRows) {
    fileIndex.set(row.vault_path, row);
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
      updated_at: fileRow?.indexed_at ?? 0,
      word_count: 0, // not stored in current schema
    };
  });

  // -------------------------------------------------------------------------
  // 4. Fetch wikilink edges between the provided paths
  // -------------------------------------------------------------------------

  // Build a Set for O(1) membership checks
  const pathSet = new Set(vaultPaths);

  type LinkRow = {
    source_path: string;
    target_path: string | null;
    link_type: string;
  };

  const linkRows = db
    .prepare(
      `SELECT source_path, target_path, link_type
       FROM vault_links
       WHERE source_path IN (${placeholders})
         AND target_path IS NOT NULL`
    )
    .all(...vaultPaths) as LinkRow[];

  const edges: NoteEdge[] = [];

  for (const row of linkRows) {
    // Only include edges where both endpoints are in the cluster
    if (!row.target_path || !pathSet.has(row.target_path)) continue;

    edges.push({
      source: row.source_path,
      target: row.target_path,
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
      const vec = fetchMeanEmbedding(db, vp);
      if (vec) embeddings.set(vp, vec);
    }

    // Build a deduplicated edge key set to avoid duplicates
    const existingEdgeKeys = new Set<string>(
      edges.map((e) => `${e.source}|||${e.target}`)
    );

    // Compare all pairs
    const pathsWithEmbeddings = Array.from(embeddings.keys());
    for (let i = 0; i < pathsWithEmbeddings.length; i++) {
      for (let j = i + 1; j < pathsWithEmbeddings.length; j++) {
        const pathA = pathsWithEmbeddings[i];
        const pathB = pathsWithEmbeddings[j];

        const vecA = embeddings.get(pathA)!;
        const vecB = embeddings.get(pathB)!;

        const sim = cosineSimilarity(vecA, vecB);
        if (sim < semanticThreshold) continue;

        // Skip if a wikilink edge already exists in either direction
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
