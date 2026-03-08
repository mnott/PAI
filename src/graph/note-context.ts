/**
 * note-context.ts — graph_note_context endpoint handler
 *
 * Given a single vault note path, returns ALL notes linked to or from it
 * across the entire vault (1-hop neighbourhood), plus the edges.
 *
 * This is the Level 3 backend: it crosses cluster boundaries so users can
 * discover connections to notes in completely different topic areas.
 *
 * Backend compatibility:
 *   - SQLite: full support (vault_files + vault_links).
 *   - Postgres: observation type enrichment only; graph data requires SQLite.
 */

import type { Database } from "better-sqlite3";
import type { Pool } from "pg";

// ---------------------------------------------------------------------------
// Public param / result types
// ---------------------------------------------------------------------------

export interface GraphNoteContextParams {
  /** Vault-relative path of the focal note, e.g. "Projects/PAI/idea-2024.md" */
  vault_path: string;
  /** Numeric PAI project ID (used for observation type enrichment) */
  project_id: number;
  /** Maximum number of neighbor notes to return (default: 50) */
  max_neighbors?: number;
  /** Include notes that link TO the focal note (default: true) */
  include_backlinks?: boolean;
  /** Include notes that the focal note links TO (default: true) */
  include_outlinks?: boolean;
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

export interface GraphNoteContextResult {
  /** The selected note — center of the graph */
  focal: NoteNode;
  /** All connected notes (1-hop neighbourhood across entire vault) */
  neighbors: NoteNode[];
  /** Wikilink edges connecting focal ↔ neighbors */
  edges: NoteEdge[];
  /**
   * vault_path → cluster_id mapping for each neighbor.
   * Empty object in Phase 3; populated in Phase 5 when cluster data is joined here.
   */
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
// Observation type enrichment (same pattern as neighborhood.ts)
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

// ---------------------------------------------------------------------------
// SQLite vault_files metadata fetch
// ---------------------------------------------------------------------------

type VaultFileRow = {
  vault_path: string;
  title: string | null;
  indexed_at: number;
};

function fetchVaultFiles(
  db: Database,
  paths: string[]
): Map<string, VaultFileRow> {
  if (paths.length === 0) return new Map();

  const placeholders = paths.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT vault_path, title, indexed_at
       FROM vault_files
       WHERE vault_path IN (${placeholders})`
    )
    .all(...paths) as VaultFileRow[];

  const index = new Map<string, VaultFileRow>();
  for (const row of rows) {
    index.set(row.vault_path, row);
  }
  return index;
}

function buildNoteNode(
  vaultPath: string,
  fileIndex: Map<string, VaultFileRow>,
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
    updated_at: fileRow?.indexed_at ?? 0,
    word_count: 0,
  };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleGraphNoteContext(
  pool: Pool | null,
  db: Database | null,
  params: GraphNoteContextParams
): Promise<GraphNoteContextResult> {
  if (!db) {
    throw new Error("graph_note_context requires SQLite backend (federation.db)");
  }

  const focalPath = params.vault_path;
  if (!focalPath) {
    throw new Error("graph_note_context: vault_path is required");
  }

  const maxNeighbors = params.max_neighbors ?? 50;
  const includeBacklinks = params.include_backlinks !== false; // default true
  const includeOutlinks = params.include_outlinks !== false; // default true

  type LinkRow = {
    source_path: string;
    target_path: string | null;
    link_type: string;
  };

  // -------------------------------------------------------------------------
  // 1. Collect 1-hop neighbor paths via vault_links
  // -------------------------------------------------------------------------

  const neighborPaths = new Set<string>();
  const rawEdges: Array<{ source: string; target: string }> = [];

  // Outgoing links: focal → other notes
  if (includeOutlinks) {
    const outRows = db
      .prepare(
        `SELECT source_path, target_path, link_type
         FROM vault_links
         WHERE source_path = ?
           AND target_path IS NOT NULL`
      )
      .all(focalPath) as LinkRow[];

    for (const row of outRows) {
      if (!row.target_path) continue;
      neighborPaths.add(row.target_path);
      rawEdges.push({ source: focalPath, target: row.target_path });
    }
  }

  // Incoming links: other notes → focal (backlinks)
  if (includeBacklinks) {
    const inRows = db
      .prepare(
        `SELECT source_path, target_path, link_type
         FROM vault_links
         WHERE target_path = ?`
      )
      .all(focalPath) as LinkRow[];

    for (const row of inRows) {
      neighborPaths.add(row.source_path);
      rawEdges.push({ source: row.source_path, target: focalPath });
    }
  }

  // Cap neighbors at max_neighbors, keeping the most-linked ones
  let neighborPathList = Array.from(neighborPaths);
  if (neighborPathList.length > maxNeighbors) {
    // Count link frequency per neighbor to keep the most connected ones
    const linkCount = new Map<string, number>();
    for (const e of rawEdges) {
      const neighbor = e.source === focalPath ? e.target : e.source;
      linkCount.set(neighbor, (linkCount.get(neighbor) ?? 0) + 1);
    }
    neighborPathList = neighborPathList
      .sort((a, b) => (linkCount.get(b) ?? 0) - (linkCount.get(a) ?? 0))
      .slice(0, maxNeighbors);
  }

  // Keep only edges where the neighbor is in the retained set
  const retainedSet = new Set(neighborPathList);
  const retainedEdges = rawEdges.filter((e) => {
    const neighbor = e.source === focalPath ? e.target : e.source;
    return retainedSet.has(neighbor);
  });

  // -------------------------------------------------------------------------
  // 2. Fetch vault_files metadata for focal + all neighbors
  // -------------------------------------------------------------------------

  const allPaths = [focalPath, ...neighborPathList];
  const fileIndex = fetchVaultFiles(db, allPaths);

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
  // 6. Deduplicate edges (a note may appear as both outlink and backlink)
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
