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
// StorageBackend interface
// ---------------------------------------------------------------------------

export interface StorageBackend {
  /** Backend identifier — useful for logging */
  readonly backendType: "sqlite" | "postgres";

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
   * Return all chunk IDs that have no embedding stored yet.
   * Used by embedChunks() to find work to do.
   */
  getUnembeddedChunkIds(projectId?: number): Promise<Array<{ id: string; text: string; project_id: number; path: string }>>;

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
}
