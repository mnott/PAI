/**
 * Type definitions for PAI daemon JSON-RPC communication.
 *
 * The daemon speaks a simple NDJSON protocol:
 *   Request:  { id: string, method: string, params: object }  (one JSON line)
 *   Response: { id: string, result: T } | { id: string, error: { code: number, message: string } }
 *
 * Phase 1: graph_clusters
 * Phase 2: graph_neighborhood
 */

// ---------------------------------------------------------------------------
// JSON-RPC envelope types
// ---------------------------------------------------------------------------

export interface RpcRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface RpcResponse<T = unknown> {
  id: string;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

// ---------------------------------------------------------------------------
// graph_clusters
// ---------------------------------------------------------------------------

export interface GraphClustersParams {
  /** Filter to a specific PAI project by numeric ID */
  project_id?: number;
  /** Minimum number of notes for a cluster to be included (default: 3) */
  min_size?: number;
  /** Maximum number of clusters to return (default: 20) */
  max_clusters?: number;
  /** Only include notes indexed within this many days (default: 90) */
  lookback_days?: number;
  /** Cosine similarity threshold for grouping notes (0–1, default: 0.6) */
  similarity_threshold?: number;
}

/** A single cluster returned by the daemon */
export interface ClusterNode {
  /** Internal cluster identifier */
  id: number;
  /** Human-readable cluster label derived from centroid observations */
  label: string;
  /** Number of notes in this cluster */
  size: number;
  /** Fraction of distinct vault folders represented (0–1). High = broad topic. */
  folder_diversity: number;
  /** Average recency score of notes (0–1, 1 = very recent) */
  avg_recency: number;
  /** Fraction of notes that have at least one vault wikilink (0–1) */
  linked_ratio: number;
  /** The most common observation type among notes in this cluster */
  dominant_observation_type: string;
  /** Per-type count breakdown: { "decision": 3, "feature": 7, ... } */
  observation_type_counts: Record<string, number>;
  /**
   * True when the cluster has high folder_diversity + size but no index note.
   * The daemon suggests creating one.
   */
  suggest_index_note: boolean;
  /** True when at least one note in the cluster is tagged as an idea note */
  has_idea_note: boolean;
  /** Representative notes for this cluster (up to ~10) */
  notes: ClusterNoteRef[];
}

/** A note reference inside a cluster */
export interface ClusterNoteRef {
  /** Vault-relative path, e.g. "Projects/PAI/idea-2024.md" */
  vault_path: string;
  /** Note title (from frontmatter `title` or first H1 heading) */
  title: string;
  /** Unix timestamp (seconds) when this note was indexed */
  indexed_at: number;
}

/** Full response from graph_clusters */
export interface GraphClustersResult {
  clusters: ClusterNode[];
  /** Total notes examined before clustering */
  total_notes_analyzed: number;
  /** The actual lookback window used (Unix seconds) */
  time_window: {
    from: number;
    to: number;
  };
}

// ---------------------------------------------------------------------------
// graph_neighborhood
// ---------------------------------------------------------------------------

export interface GraphNeighborhoodParams {
  /** Vault-relative paths of notes in the cluster to expand */
  vault_paths: string[];
  /** Numeric PAI project ID */
  project_id: number;
  /** Whether to compute semantic similarity edges (default: false) */
  include_semantic_edges?: boolean;
  /** Cosine similarity threshold for semantic edges (0–1, default: 0.7) */
  semantic_threshold?: number;
}

/** A single note node inside the neighbourhood */
export interface NoteNode {
  /** Vault-relative path, e.g. "Projects/PAI/idea-2024.md" */
  vault_path: string;
  /** Note title from frontmatter or H1; falls back to filename */
  title: string;
  /** Parent folder path derived from vault_path */
  folder: string;
  /** Per-type observation count breakdown: { "decision": 2, "feature": 5, ... } */
  observation_types: Record<string, number>;
  /** The most common observation type, or "unknown" */
  dominant_type: string;
  /** Unix timestamp (seconds) when the note was last indexed */
  updated_at: number;
  /** Word count (0 when not stored) */
  word_count: number;
}

/** A directed edge between two notes */
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

/** Full response from graph_neighborhood */
export interface GraphNeighborhoodResult {
  nodes: NoteNode[];
  edges: NoteEdge[];
}

// ---------------------------------------------------------------------------
// Convenience union of all supported method → param/result pairs.
// Extend this as more daemon methods are implemented.
// ---------------------------------------------------------------------------

export type DaemonMethodMap = {
  graph_clusters: {
    params: GraphClustersParams;
    result: GraphClustersResult;
  };
  graph_neighborhood: {
    params: GraphNeighborhoodParams;
    result: GraphNeighborhoodResult;
  };
};

export type DaemonMethod = keyof DaemonMethodMap;
