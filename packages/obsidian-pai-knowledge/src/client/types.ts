/**
 * Type definitions for PAI daemon JSON-RPC communication.
 *
 * The daemon speaks a simple NDJSON protocol:
 *   Request:  { id: string, method: string, params: object }  (one JSON line)
 *   Response: { id: string, result: T } | { id: string, error: { code: number, message: string } }
 *
 * For Phase 1, only graph_clusters is implemented.
 * Future methods: memory_search, vault_explore, session_list, etc.
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
// Convenience union of all supported method → param/result pairs.
// Extend this as more daemon methods are implemented.
// ---------------------------------------------------------------------------

export type DaemonMethodMap = {
  graph_clusters: {
    params: GraphClustersParams;
    result: GraphClustersResult;
  };
};

export type DaemonMethod = keyof DaemonMethodMap;
