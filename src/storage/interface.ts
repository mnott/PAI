/**
 * StorageBackend interface for PAI federation memory.
 *
 * Abstracts all database operations so the daemon, tools, and indexer
 * can work with either SQLite or PostgreSQL/pgvector without knowing
 * which backend is active.
 *
 * Design notes:
 * - Registry operations (projects, sessions) remain in SQLite. Only the
 *   federation layer (chunks, FTS, vectors) uses this abstraction.
 * - All search methods return SearchResult[] so callers are backend-agnostic.
 * - Indexing operations (file tracking, chunk upserting) are part of this
 *   interface so the indexer can write through it.
 */

import type { SearchResult, SearchOptions } from "../memory/search.js";
import type { KgEntity, KgEntityUpsertParams } from "../memory/kg-entity.js";
import type { KgTriple, KgAddParams, KgQueryParams, KgContradiction } from "../memory/kg.js";
import type { IndexResult } from "../memory/indexer/types.js";
import type { RegistryBackend } from "./registry-interface.js";
import type { Tunnel, FindTunnelsOptions, FindTunnelsResult } from "../memory/tunnels.js";
import type { ClassifiedObservation } from "../observations/classifier.js";

export type { Tunnel, FindTunnelsOptions, FindTunnelsResult };
export type { KgTriple, KgAddParams, KgQueryParams, KgContradiction };

// ---------------------------------------------------------------------------
// Chunk types (mirrored from indexer but backend-independent)
// ---------------------------------------------------------------------------

export interface ChunkRow {
  id: string;
  projectId: number;
  source: string;
  tier: string;
  path: string;
  startLine: number;
  endLine: number;
  hash: string;
  text: string;
  updatedAt: number;
  embedding?: Buffer | Float32Array | null;
}

export interface FileRow {
  projectId: number;
  path: string;
  source: string;
  tier: string;
  hash: string;
  mtime: number;
  size: number;
}

// ---------------------------------------------------------------------------
// Vault types (Obsidian vault file inventory + wikilink graph)
// ---------------------------------------------------------------------------

export interface VaultFileRow {
  vaultPath: string;
  inode: number;
  device: number;
  hash: string;
  title: string | null;
  indexedAt: number;
}

export interface VaultAliasRow {
  vaultPath: string;
  canonicalPath: string;
  inode: number;
  device: number;
}

export interface VaultLinkRow {
  sourcePath: string;
  targetRaw: string;
  targetPath: string | null;
  linkType: string;
  lineNumber: number;
  /** Confidence level: EXTRACTED (parsed from source), INFERRED (semantic), AMBIGUOUS (weak). */
  confidence?: "EXTRACTED" | "INFERRED" | "AMBIGUOUS";
}

export interface VaultHealthRow {
  vaultPath: string;
  inboundCount: number;
  outboundCount: number;
  deadLinkCount: number;
  isOrphan: boolean;
  computedAt: number;
}

export interface VaultNameEntry {
  name: string;
  vaultPath: string;
}

// ---------------------------------------------------------------------------
// Database statistics
// ---------------------------------------------------------------------------

export interface FederationStats {
  files: number;
  chunks: number;
}

// ---------------------------------------------------------------------------
// Observations (pai_observations / pai_session_summaries / pai_skill_telemetry)
// ---------------------------------------------------------------------------

export interface ObservationRow {
  id: number;
  session_id: string;
  project_id: number | null;
  project_slug: string | null;
  type: string;
  title: string;
  narrative: string | null;
  tool_name: string | null;
  tool_input_summary: string | null;
  files_read: string[];
  files_modified: string[];
  concepts: string[];
  content_hash: string | null;
  created_at: Date;
}

export interface SessionSummaryRow {
  id: number;
  session_id: string;
  project_id: number | null;
  project_slug: string | null;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  observation_count: number;
  created_at: Date;
}

export interface StoreObservationInput extends Omit<ClassifiedObservation, "narrative"> {
  session_id: string;
  project_id?: number | null;
  project_slug?: string | null;
  narrative?: string | null;
}

/** StoreObservationInput plus the cwd used to attribute it to a registered project. */
export interface ObservationWithCwd extends StoreObservationInput {
  cwd?: string;
}

export interface StoreSessionSummaryInput {
  session_id: string;
  project_id?: number | null;
  project_slug?: string | null;
  request?: string | null;
  investigated?: string | null;
  learned?: string | null;
  completed?: string | null;
  next_steps?: string | null;
  observation_count?: number;
}

export interface QueryObservationsOptions {
  projectId?: number;
  sessionId?: string;
  type?: string;
  limit?: number;
  offset?: number;
}

export interface ObservationStats {
  total: number;
  by_type: Array<{ type: string; count: number }>;
  by_project: Array<{ project_slug: string | null; count: number }>;
  most_recent: string | null;
}

export interface SkillTelemetryRow {
  id: number;
  scope: string;
  skill_name: string;
  source: string;
  status: string;
  trigger_count: number;
  accept_count: number;
  first_triggered: Date;
  last_triggered: Date;
  context_projects: string[];
  hash: string | null;
  audit_status: string | null;
  last_audited: Date | null;
}

export interface RecordSkillInvocationInput {
  skill_name: string;
  /** 'local' | 'skills.sh' | repo slug */
  source?: string;
  /** governance seam — defaults to 'default' */
  scope?: string;
  /** project slug for context_projects rollup */
  project_slug?: string | null;
}

export interface QuerySkillTelemetryOptions {
  scope?: string;
  status?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Knowledge-graph triples stats (for `pai kg stats`)
// ---------------------------------------------------------------------------

export interface KgStats {
  total: number;
  valid: number;
  invalidated: number;
  subjects: number;
  predicates: number;
  contradictions: number;
}

// ---------------------------------------------------------------------------
// Memory sources report (for `pai memory sources`)
// ---------------------------------------------------------------------------

export interface MemorySourcesComposition {
  source: string;
  tier: string;
  chunks: number;
  embedded: number;
}

export interface MemorySourcesPath {
  path: string;
  chunks: number;
}

export interface MemorySourcesChurnDay {
  day: string;
  chunks: number;
  embedded: number;
}

export interface MemorySourcesReport {
  composition: MemorySourcesComposition[];
  paths: MemorySourcesPath[];
  churn: MemorySourcesChurnDay[];
}

// ---------------------------------------------------------------------------
// StorageBackend interface
// ---------------------------------------------------------------------------

export interface StorageBackend {
  /** Backend identifier — useful for logging */
  readonly backendType: "sqlite" | "postgres";

  /**
   * True when Postgres-only tables (kg_triples, pai_observations,
   * pai_session_summaries, pai_skill_telemetry, vault_*) are available.
   * Callers use this instead of comparing backendType directly, so the
   * decision of which backend supports what stays behind this interface.
   */
  readonly supportsPostgresFeatures: boolean;

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Close underlying connections.  After close() the backend should not be used.
   */
  close(): Promise<void>;

  /**
   * Return aggregate statistics for health/status reporting.
   */
  getStats(): Promise<FederationStats>;

  /**
   * Return file/chunk counts scoped to a single project (memory_files/memory_chunks
   * row counts for that project_id). Used for per-project taxonomy breakdowns.
   */
  getProjectStats(projectId: number): Promise<FederationStats>;

  // -------------------------------------------------------------------------
  // File tracking (change detection)
  // -------------------------------------------------------------------------

  /**
   * Get the stored hash for a file, or undefined if not indexed yet.
   */
  getFileHash(projectId: number, path: string): Promise<string | undefined>;

  /**
   * Upsert a file record (insert or update on conflict).
   */
  upsertFile(file: FileRow): Promise<void>;

  // -------------------------------------------------------------------------
  // Chunk management
  // -------------------------------------------------------------------------

  /**
   * Return the IDs of all chunks for a given (projectId, path) pair.
   * Used to delete FTS entries before re-indexing.
   */
  getChunkIds(projectId: number, path: string): Promise<string[]>;

  /**
   * Delete all chunks (and associated FTS/vector entries) for a file.
   */
  deleteChunksForFile(projectId: number, path: string): Promise<void>;

  /**
   * Insert a batch of new chunks. The backend is responsible for also
   * updating any full-text or vector index entries.
   */
  insertChunks(chunks: ChunkRow[]): Promise<void>;

  /**
   * Return all distinct paths stored in memory_chunks for a given project.
   * Used by the indexer to detect stale paths after renames/moves/deletions.
   */
  getDistinctChunkPaths(projectId: number): Promise<string[]>;

  /**
   * Delete all chunks, FTS entries, and file records for the given paths.
   * Used by the stale-path pruner to clean up entries for renamed/moved/deleted files.
   */
  deletePaths(projectId: number, paths: string[]): Promise<void>;

  /**
   * Return chunk IDs that have no embedding stored yet.
   * Used by embedChunks() to find work to do.
   *
   * `limit` bounds how many rows come back. It matters: the rows carry the full
   * chunk text, and an unbounded fetch against a six-figure backlog pulls the
   * whole thing into memory before a single embedding is generated. The embed
   * pass is resumable — every embedding is written as it is produced — so a
   * bounded fetch loses nothing and simply resumes on the next pass.
   *
   * Rows are ordered by project so that per-project progress logging reflects
   * real runs of work rather than flapping once per chunk.
   *
   * `after` opts into keyset pagination on (project_id, id): pass `null` to
   * start a paginated scan (ordered by project_id, id instead of the default
   * priority ordering) and the last row's {project_id, id} from each page to
   * fetch the next one. Omit it entirely (undefined) to keep the original
   * single-page behaviour used by the daemon's bounded pass.
   */
  getUnembeddedChunkIds(
    projectId?: number,
    limit?: number,
    after?: { projectId: number; id: string } | null,
  ): Promise<Array<{ id: string; text: string; project_id: number; path: string }>>;

  /**
   * Store an embedding for a single chunk.
   */
  updateEmbedding(chunkId: string, embedding: Buffer): Promise<void>;

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  /**
   * BM25 / full-text keyword search.
   */
  searchKeyword(query: string, opts?: SearchOptions): Promise<SearchResult[]>;

  /**
   * Cosine similarity vector search.
   * Only chunks with stored embeddings are considered.
   */
  searchSemantic(queryEmbedding: Float32Array, opts?: SearchOptions): Promise<SearchResult[]>;

  // -------------------------------------------------------------------------
  // Vault operations (Obsidian vault file inventory + wikilink graph)
  // -------------------------------------------------------------------------

  /** Upsert a vault file record. */
  upsertVaultFile(file: VaultFileRow): Promise<void>;
  /** Delete a vault file and its associated links/health. */
  deleteVaultFile(vaultPath: string): Promise<void>;
  /** Get a vault file by path. */
  getVaultFile(vaultPath: string): Promise<VaultFileRow | null>;
  /** Get a vault file by inode+device (dedup). */
  getVaultFileByInode(inode: number, device: number): Promise<VaultFileRow | null>;
  /** Get all vault files. */
  getAllVaultFiles(): Promise<VaultFileRow[]>;
  /** Get vault files indexed after a timestamp. */
  getRecentVaultFiles(sinceMs: number): Promise<VaultFileRow[]>;
  /** Count vault files. */
  countVaultFiles(): Promise<number>;

  /** Upsert vault aliases (bulk). */
  upsertVaultAliases(aliases: VaultAliasRow[]): Promise<void>;
  /** Delete aliases for a canonical path. */
  deleteVaultAliases(canonicalPath: string): Promise<void>;

  /** Insert links in bulk (replaces all links for given sources). */
  replaceLinksForSources(sourcePaths: string[], links: VaultLinkRow[]): Promise<void>;
  /** Get outgoing links from a source path. */
  getLinksFromSource(sourcePath: string): Promise<VaultLinkRow[]>;
  /** Get incoming links to a target path. */
  getLinksToTarget(targetPath: string): Promise<VaultLinkRow[]>;
  /** Get full link graph (for BFS clustering). Returns source→targets adjacency. */
  getVaultLinkGraph(): Promise<Array<{ source_path: string; target_path: string }>>;

  /** Upsert vault health records (bulk). */
  upsertVaultHealth(rows: VaultHealthRow[]): Promise<void>;
  /** Get health for a single file. */
  getVaultHealth(vaultPath: string): Promise<VaultHealthRow | null>;
  /** Get all orphan files. */
  getOrphans(): Promise<VaultHealthRow[]>;
  /** Get dead links. */
  getDeadLinks(): Promise<Array<{ sourcePath: string; targetRaw: string }>>;

  /** Upsert name index entries (bulk). */
  upsertNameIndex(entries: VaultNameEntry[]): Promise<void>;
  /** Clear and rebuild name index. */
  replaceNameIndex(entries: VaultNameEntry[]): Promise<void>;
  /** Resolve a wikilink name to vault paths. */
  resolveVaultName(name: string): Promise<string[]>;
  /** Search vault_name_index by partial name match. */
  searchVaultNameIndex(query: string, limit?: number): Promise<string[]>;

  /** Get vault files for a specific set of paths. */
  getVaultFilesByPaths(paths: string[]): Promise<VaultFileRow[]>;

  /** Get vault files for a specific set of paths filtered by minimum indexed_at. */
  getVaultFilesByPathsAfter(paths: string[], sinceMs: number): Promise<VaultFileRow[]>;

  /** Get all vault links where source_path is in the given list. */
  getVaultLinksFromPaths(sourcePaths: string[]): Promise<VaultLinkRow[]>;

  // -------------------------------------------------------------------------
  // Memory chunk reading (for zettelkasten embedding-based tools)
  // -------------------------------------------------------------------------

  /** Get raw chunk rows (id, path, text, embedding) for a project, with embeddings only. */
  getChunksWithEmbeddings(projectId: number, limit: number): Promise<Array<{ path: string; text: string; embedding: Buffer }>>;

  /** Get chunk rows for a specific path in a project. */
  getChunksForPath(projectId: number, path: string, limit?: number): Promise<Array<{ text: string; embedding: Buffer | null }>>;

  /** Search memory_chunks text content by keyword (LIKE match). */
  searchChunksByText(projectId: number, query: string, limit: number): Promise<Array<{ path: string; text: string }>>;

  // -------------------------------------------------------------------------
  // Vault health scoped queries (for zettelHealth() with scope filters)
  // -------------------------------------------------------------------------

  /** Count vault files matching a path prefix (project scope). */
  countVaultFilesWithPrefix(prefix: string): Promise<number>;
  /** Count vault files indexed after a timestamp (recent scope). */
  countVaultFilesAfter(sinceMs: number): Promise<number>;

  /** Count vault links where source_path matches a prefix. */
  countVaultLinksWithPrefix(prefix: string): Promise<number>;
  /** Count vault links where source_path is in the recent vault files. */
  countVaultLinksAfter(sinceMs: number): Promise<number>;

  /** Get dead links scoped to a path prefix. */
  getDeadLinksWithPrefix(prefix: string): Promise<Array<{ sourcePath: string; targetRaw: string; lineNumber: number }>>;
  /** Get dead links for vault files indexed after a timestamp. */
  getDeadLinksAfter(sinceMs: number): Promise<Array<{ sourcePath: string; targetRaw: string; lineNumber: number }>>;
  /** Get all dead links with line number. */
  getDeadLinksWithLineNumbers(): Promise<Array<{ sourcePath: string; targetRaw: string; lineNumber: number }>>;

  /** Get orphan vault_paths scoped to a prefix. */
  getOrphansWithPrefix(prefix: string): Promise<string[]>;
  /** Get orphan vault_paths for recently indexed files. */
  getOrphansAfter(sinceMs: number): Promise<string[]>;

  /** Get vault_paths with low connectivity (inbound + outbound <= 1). */
  getLowConnectivity(): Promise<string[]>;
  /** Get vault_paths with low connectivity scoped to a prefix. */
  getLowConnectivityWithPrefix(prefix: string): Promise<string[]>;
  /** Get vault_paths with low connectivity for recently indexed files. */
  getLowConnectivityAfter(sinceMs: number): Promise<string[]>;

  /** Get all vault file paths (for disconnected component analysis). */
  getAllVaultFilePaths(): Promise<string[]>;
  /** Get vault file paths with a prefix. */
  getVaultFilePathsWithPrefix(prefix: string): Promise<string[]>;
  /** Get vault file paths indexed after a timestamp. */
  getVaultFilePathsAfter(sinceMs: number): Promise<string[]>;

  /** Get distinct source/target pairs for connected component analysis. */
  getVaultLinkEdges(): Promise<Array<{ source: string; target: string }>>;
  /** Get vault link edges where source_path matches prefix. */
  getVaultLinkEdgesWithPrefix(prefix: string): Promise<Array<{ source: string; target: string }>>;
  /** Get vault link edges for recently indexed sources. */
  getVaultLinkEdgesAfter(sinceMs: number): Promise<Array<{ source: string; target: string }>>;

  /** Alias resolution: look up canonical path for a vault alias path. */
  getVaultAlias(vaultPath: string): Promise<{ canonicalPath: string } | null>;

  // -------------------------------------------------------------------------
  // Knowledge-graph entities (kg_entities)
  // -------------------------------------------------------------------------

  /**
   * Upsert a KG entity by (tenant, name). On conflict: bumps mention_count,
   * refreshes last_seen, fills in description/type when previously unset.
   * Returns the deterministic entity_id (see entityContentId()).
   */
  upsertKgEntity(params: KgEntityUpsertParams): Promise<string>;

  /** Look up a KG entity by name within a tenant. Null if not found. */
  findKgEntity(name: string, tenantId?: string): Promise<KgEntity | null>;

  /** List KG entities for a tenant, optionally filtered by type, ordered by mention_count desc. */
  listKgEntities(tenantId?: string, type?: string, limit?: number): Promise<KgEntity[]>;

  /** Apply an EMA feedback-weight update to an entity. No-op if the entity does not exist. */
  updateEntityFeedbackWeight(entityId: string, normalizedRating: number, alpha?: number): Promise<void>;

  // -------------------------------------------------------------------------
  // Chunk feedback / access tracking (memory_chunks.relevance_score, last_accessed_at)
  // -------------------------------------------------------------------------

  /** Fetch text + current relevance_score for a set of chunk ids (for the EMA feedback update). */
  getChunksForFeedback(chunkIds: string[]): Promise<Array<{ id: string; text: string; relevanceScore: number | null }>>;

  /** Overwrite relevance_score for a single chunk. */
  updateChunkRelevanceScore(chunkId: string, score: number): Promise<void>;

  /** Set last_accessed_at to now for a set of chunk ids. Best-effort: never throws. */
  touchChunksLastAccessed(chunkIds: string[]): Promise<void>;

  // -------------------------------------------------------------------------
  // Global indexing (daemon scheduler entry point — one call regardless of backend)
  // -------------------------------------------------------------------------

  /** Index every active registered project (memory/Notes/content scan + chunk + FTS). */
  indexAll(registry: RegistryBackend): Promise<{ projects: number; result: IndexResult }>;

  // -------------------------------------------------------------------------
  // Cross-project concept tunnels
  // -------------------------------------------------------------------------

  /** Find concepts shared across two or more registered projects. */
  findTunnels(registry: RegistryBackend, options?: FindTunnelsOptions): Promise<FindTunnelsResult>;

  // -------------------------------------------------------------------------
  // Memory sources report (`pai memory sources`)
  // -------------------------------------------------------------------------

  /** Aggregate composition/root-path/churn breakdown of what the indexer has taken in. */
  getMemorySourcesReport(): Promise<MemorySourcesReport>;

  // -------------------------------------------------------------------------
  // Temporal knowledge graph (kg_triples). Postgres only — SQLiteBackend
  // throws "not supported on the sqlite backend" for all of these.
  // -------------------------------------------------------------------------

  /** Insert a new (subject, predicate, object) triple. Returns the inserted row. */
  addKgTriple(params: KgAddParams): Promise<KgTriple>;

  /** Query triples by subject/predicate/object/project, with optional as-of point-in-time filter. */
  queryKgTriples(params: KgQueryParams): Promise<KgTriple[]>;

  /** Invalidate a triple by setting valid_to = NOW(). Does not delete the row. */
  invalidateKgTriple(tripleId: number): Promise<void>;

  /** Find (subject, predicate) pairs with more than one currently-valid object. */
  getKgContradictions(subject: string): Promise<KgContradiction[]>;

  /** Aggregate triple/contradiction counts for `pai kg stats`. */
  getKgStats(): Promise<KgStats>;

  // -------------------------------------------------------------------------
  // Observations (pai_observations / pai_session_summaries / pai_skill_telemetry).
  // Postgres only — SQLiteBackend throws "not supported on the sqlite backend".
  // -------------------------------------------------------------------------

  /** Insert an observation, skipping duplicates within a 30-second window. Returns the row id, or null if suppressed. */
  storeObservation(obs: StoreObservationInput): Promise<number | null>;

  /** storeObservation(), attributing project_id/project_slug from obs.cwd via the registry when set. */
  storeObservationWithProject(registry: RegistryBackend, obs: ObservationWithCwd): Promise<number | null>;

  /** Filtered query for observations, ordered by created_at DESC. */
  queryObservations(opts?: QueryObservationsOptions): Promise<ObservationRow[]>;

  /** Most recent observations for a project, ordered by created_at DESC. */
  queryRecentObservations(projectId: number, limit: number): Promise<ObservationRow[]>;

  /** All observations for a session, ordered chronologically. */
  querySessionObservations(sessionId: string): Promise<ObservationRow[]>;

  /** Aggregate observation totals/by-type/by-project/most-recent. */
  getObservationStats(): Promise<ObservationStats>;

  /**
   * Observation-type counts per vault path, for a set of file paths (and
   * optional project scope). Used by the graph_* handlers to enrich note
   * nodes with how often each note was touched by which observation type.
   */
  getObservationTypesForPaths(filePaths: string[], projectId?: number): Promise<Map<string, Record<string, number>>>;

  /** Upsert a session summary (ON CONFLICT session_id DO UPDATE). */
  storeSessionSummary(summary: StoreSessionSummaryInput): Promise<void>;

  /** Most recent session summaries for a project, ordered by created_at DESC. */
  queryRecentSummaries(projectId: number, limit: number): Promise<SessionSummaryRow[]>;

  /** Record a single skill invocation (upserts on scope/skill_name/source). */
  recordSkillInvocation(input: RecordSkillInvocationInput): Promise<void>;

  /** List skill telemetry rows, most-triggered first. */
  querySkillTelemetry(opts?: QuerySkillTelemetryOptions): Promise<SkillTelemetryRow[]>;

  // -------------------------------------------------------------------------
  // File-path rename (session cleanup: moving Notes/*.md into YYYY/MM/)
  // -------------------------------------------------------------------------

  /** Count indexed file rows whose path is in the given list. */
  countFilesWithPaths(paths: string[]): Promise<number>;

  /** Rename file/chunk rows in bulk (path only — content/embeddings untouched). Returns rows updated. */
  renameFilePaths(moves: Array<{ oldPath: string; newPath: string }>): Promise<number>;
}
