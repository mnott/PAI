/**
 * note-context.ts — graph_note_context endpoint handler
 *
 * Given a single vault note path, returns ALL notes linked to or from it
 * across the entire vault (1-hop neighbourhood), plus the edges.
 */

import type { StorageBackend } from "../storage/interface.js";
import type { Pool } from "pg";

// ---------------------------------------------------------------------------
// Public param / result types
// ---------------------------------------------------------------------------

export interface GraphNoteContextParams {
  vault_path: string;
  project_id: number;
  max_neighbors?: number;
  include_backlinks?: boolean;
  include_outlinks?: boolean;
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

export interface GraphNoteContextResult {
  focal: NoteNode;
  neighbors: NoteNode[];
  edges: NoteEdge[];
  cluster_membership: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function folderFromPath(vaultPath: string): string {
  const lastSlash = vaultPath.lastIndexOf("/");
  return lastSlash === -1 ? "" : vaultPath.slice(0, lastSlash);
}

function dominantType(counts: Record<string, number>): string {
  let best = "unknown";
  let maxCount = 0;
  for (const [type, n] of Object.entries(counts)) {
    if (n > maxCount) {
      maxCount = n;
      best = type;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Observation type enrichment
// ---------------------------------------------------------------------------

async function fetchObservationTypes(
  pool: Pool,
  filePaths: string[],
  projectId: number
): Promise<Map<string, Record<string, number>>> {
  if (filePaths.length === 0) return new Map();

  try {
    const result = await pool.query<{ path: string; type: string; cnt: string }>(
      `SELECT unnested_path AS path, type, COUNT(*) AS cnt
       FROM pai_observations,
            LATERAL unnest(files_modified || files_read) AS unnested_path
       WHERE unnested_path = ANY($1::text[])
         AND project_id = $2
       GROUP BY unnested_path, type`,
      [filePaths, projectId]
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

function buildNoteNode(
  vaultPath: string,
  fileIndex: Map<string, { title: string | null; indexedAt: number }>,
  obsByPath: Map<string, Record<string, number>>
): NoteNode {
  const fileRow = fileIndex.get(vaultPath);
  const fileName = vaultPath.split("/").pop() ?? vaultPath;
  const rawTitle = fileRow?.title ?? fileName.replace(/\.md$/i, "");
  const obsCounts = obsByPath.get(vaultPath) ?? {};

  return {
    vault_path: vaultPath,
    title: rawTitle,
    folder: folderFromPath(vaultPath),
    observation_types: obsCounts,
    dominant_type: dominantType(obsCounts),
    updated_at: fileRow?.indexedAt ?? 0,
    word_count: 0,
  };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleGraphNoteContext(
  pool: Pool | null,
  backend: StorageBackend,
  params: GraphNoteContextParams
): Promise<GraphNoteContextResult> {
  const focalPath = params.vault_path;
  if (!focalPath) {
    throw new Error("graph_note_context: vault_path is required");
  }

  const maxNeighbors = params.max_neighbors ?? 50;
  const includeBacklinks = params.include_backlinks !== false;
  const includeOutlinks = params.include_outlinks !== false;

  // -------------------------------------------------------------------------
  // 1. Collect 1-hop neighbor paths via vault_links
  // -------------------------------------------------------------------------

  const neighborPaths = new Set<string>();
  const rawEdges: Array<{ source: string; target: string }> = [];

  if (includeOutlinks) {
    const outLinks = await backend.getLinksFromSource(focalPath);
    for (const link of outLinks) {
      if (!link.targetPath) continue;
      neighborPaths.add(link.targetPath);
      rawEdges.push({ source: focalPath, target: link.targetPath });
    }
  }

  if (includeBacklinks) {
    const inLinks = await backend.getLinksToTarget(focalPath);
    for (const link of inLinks) {
      neighborPaths.add(link.sourcePath);
      rawEdges.push({ source: link.sourcePath, target: focalPath });
    }
  }

  // Cap neighbors at max_neighbors, keeping the most-linked ones
  let neighborPathList = Array.from(neighborPaths);
  if (neighborPathList.length > maxNeighbors) {
    const linkCount = new Map<string, number>();
    for (const e of rawEdges) {
      const neighbor = e.source === focalPath ? e.target : e.source;
      linkCount.set(neighbor, (linkCount.get(neighbor) ?? 0) + 1);
    }
    neighborPathList = neighborPathList
      .sort((a, b) => (linkCount.get(b) ?? 0) - (linkCount.get(a) ?? 0))
      .slice(0, maxNeighbors);
  }

  const retainedSet = new Set(neighborPathList);
  const retainedEdges = rawEdges.filter((e) => {
    const neighbor = e.source === focalPath ? e.target : e.source;
    return retainedSet.has(neighbor);
  });

  // -------------------------------------------------------------------------
  // 2. Fetch vault_files metadata for focal + all neighbors
  // -------------------------------------------------------------------------

  const allPaths = [focalPath, ...neighborPathList];
  const fileRows = await backend.getVaultFilesByPaths(allPaths);
  const fileIndex = new Map<string, { title: string | null; indexedAt: number }>(
    fileRows.map(f => [f.vaultPath, { title: f.title, indexedAt: f.indexedAt }])
  );

  // -------------------------------------------------------------------------
  // 3. Observation type enrichment (Postgres if available)
  // -------------------------------------------------------------------------

  const obsByPath =
    pool !== null
      ? await fetchObservationTypes(pool, allPaths, params.project_id)
      : new Map<string, Record<string, number>>();

  // -------------------------------------------------------------------------
  // 4. Build focal NoteNode
  // -------------------------------------------------------------------------

  const focal = buildNoteNode(focalPath, fileIndex, obsByPath);

  // -------------------------------------------------------------------------
  // 5. Build neighbor NoteNode array
  // -------------------------------------------------------------------------

  const neighbors: NoteNode[] = neighborPathList.map((vp) =>
    buildNoteNode(vp, fileIndex, obsByPath)
  );

  // -------------------------------------------------------------------------
  // 6. Deduplicate edges
  // -------------------------------------------------------------------------

  const edgeKeys = new Set<string>();
  const edges: NoteEdge[] = [];
  for (const e of retainedEdges) {
    const key = `${e.source}|||${e.target}`;
    if (!edgeKeys.has(key)) {
      edgeKeys.add(key);
      edges.push({
        source: e.source,
        target: e.target,
        type: "wikilink",
        weight: 1.0,
      });
    }
  }

  return {
    focal,
    neighbors,
    edges,
    cluster_membership: {},
  };
}
