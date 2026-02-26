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
   * Return all chunk IDs that have no embedding stored yet.
   * Used by embedChunks() to find work to do.
   */
  getUnembeddedChunkIds(projectId?: number): Promise<Array<{ id: string; text: string }>>;

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
}
