/**
 * Type definitions for PAI daemon JSON-RPC communication.
 *
 * The daemon speaks a simple NDJSON protocol:
 *   Request:  { id: string, method: string, params: object }  (one JSON line)
 *   Response: { id: string, result: T } | { id: string, error: { code: number, message: string } }
 *
 * Phase 1: graph_clusters
 * Phase 2: graph_neighborhood
 * Phase 3: graph_note_context
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
// graph_note_context
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

/** Full response from graph_note_context */
export interface GraphNoteContextResult {
  /** The selected note — center of the graph */
  focal: NoteNode;
  /** All connected notes (1-hop neighbourhood across entire vault) */
  neighbors: NoteNode[];
  /** Wikilink edges connecting focal ↔ neighbors */
  edges: NoteEdge[];
  /**
   * vault_path → cluster_id mapping for each neighbor.
   * Empty in Phase 3; populated in Phase 5.
   */
  cluster_membership: Record<string, number>;
}

// ---------------------------------------------------------------------------
// graph_trace (Phase 4 — temporal navigation)
// ---------------------------------------------------------------------------

export interface GraphTraceParams {
  /** Topic/keyword to trace through time */
  query: string;
  /** Numeric PAI project ID */
  project_id: number;
  /** Cap on timeline entries (default: 30) */
  max_results?: number;
  /** How far back to search in days (default: 365) */
  lookback_days?: number;
}

/** A single note appearance on the idea timeline */
export interface TraceEntry {
  /** Vault-relative path, e.g. "Projects/PAI/idea-2024.md" */
  vault_path: string;
  /** Note title from frontmatter or H1 */
  title: string;
  /** Parent folder path derived from vault_path */
  folder: string;
  /** Unix timestamp (seconds) when this note was indexed — used for ordering */
  indexed_at: number;
  /** Text excerpt showing the topic in context (100-200 chars) */
  snippet: string;
  /** Most common observation type for this note */
  dominant_type: string;
}

/** An edge on the trace timeline */
export interface TraceConnection {
  /** Earlier note's vault path */
  from_path: string;
  /** Later note's vault path */
  to_path: string;
  /** "temporal" = time-sequence, "wikilink" = explicit vault link exists */
  type: "temporal" | "wikilink";
}

/** Full response from graph_trace */
export interface GraphTraceResult {
  /** The query that was traced */
  query: string;
  /** Timeline entries sorted oldest-first */
  entries: TraceEntry[];
  /** Edges connecting entries */
  connections: TraceConnection[];
  /** Unix timestamp range covered by the results */
  time_span: { from: number; to: number };
}

// ---------------------------------------------------------------------------
// graph_latent_ideas (Phase 5)
// ---------------------------------------------------------------------------

export interface GraphLatentIdeasParams {
  /** Numeric PAI project ID */
  project_id: number;
  /** Minimum notes in a cluster (default: 3) */
  min_cluster_size?: number;
  /** Cap on returned ideas (default: 15) */
  max_ideas?: number;
  /** How far back to look in days (default: 180) */
  lookback_days?: number;
  /** Cosine similarity clustering threshold (default: 0.65) */
  similarity_threshold?: number;
}

/** A source note contributing to a latent idea */
export interface LatentIdeaSourceNote {
  vault_path: string;
  title: string;
  /** How strongly this note relates to the theme (0-1) */
  relevance: number;
}

/** A latent idea: a recurring theme with no dedicated note yet */
export interface LatentIdea {
  id: number;
  /** Auto-generated cluster label */
  label: string;
  /** Number of notes touching this theme */
  size: number;
  /** 0-1, how likely this is a real coherent idea */
  confidence: number;
  /** Notes that contribute to this theme */
  source_notes: LatentIdeaSourceNote[];
  /** Cleaned-up version of label for a potential note title */
  suggested_title: string;
  /** Most common folder among source notes */
  suggested_folder: string;
  /** Number of distinct session date-folders touching this theme */
  sessions_count: number;
}

/** Full response from graph_latent_ideas */
export interface GraphLatentIdeasResult {
  ideas: LatentIdea[];
  total_clusters_analyzed: number;
  /** How many clusters already have a matching note (excluded from results) */
  materialized_count: number;
}

// ---------------------------------------------------------------------------
// idea_materialize (Phase 5)
// ---------------------------------------------------------------------------

export interface IdeaMaterializeParams {
  idea_label: string;
  /** User-chosen title for the new note */
  title: string;
  /** Vault-relative folder path where the note should be created */
  folder: string;
  /** Vault-relative paths of source notes to link from the new note */
  source_paths: string[];
  project_id: number;
}

/** Result from idea_materialize */
export interface IdeaMaterializeResult {
  /** Vault-relative path of the created note */
  vault_path: string;
  /** Generated markdown content */
  content: string;
  /** Number of wikilinks inserted */
  links_created: number;
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
  graph_note_context: {
    params: GraphNoteContextParams;
    result: GraphNoteContextResult;
  };
  graph_trace: {
    params: GraphTraceParams;
    result: GraphTraceResult;
  };
  graph_latent_ideas: {
    params: GraphLatentIdeasParams;
    result: GraphLatentIdeasResult;
  };
  idea_materialize: {
    params: IdeaMaterializeParams;
    result: IdeaMaterializeResult;
  };
};

export type DaemonMethod = keyof DaemonMethodMap;
