/**
 * SQLiteBackend — wraps the existing better-sqlite3 federation.db
 * behind the StorageBackend interface.
 *
 * This is a thin adapter.  The heavy lifting is all in the existing
 * memory/indexer.ts and memory/search.ts code; we just provide a
 * backend-agnostic surface so the daemon and tools can call either
 * SQLite or Postgres transparently.
 */

import type { Database } from "better-sqlite3";
import type { StorageBackend, ChunkRow, FileRow, FederationStats } from "./interface.js";
import type { SearchResult, SearchOptions } from "../memory/search.js";
import { searchMemory, searchMemorySemantic } from "../memory/search.js";

export class SQLiteBackend implements StorageBackend {
  readonly backendType = "sqlite" as const;

  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Expose the raw better-sqlite3 Database handle.
   * Used by the daemon to pass to indexAll() which still uses the synchronous API directly.
   */
  getRawDb(): Database {
    return this.db;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async close(): Promise<void> {
    try {
      this.db.close();
    } catch {
      // ignore
    }
  }

  async getStats(): Promise<FederationStats> {
    const files = (
      this.db.prepare("SELECT COUNT(*) AS n FROM memory_files").get() as { n: number }
    ).n;
    const chunks = (
      this.db.prepare("SELECT COUNT(*) AS n FROM memory_chunks").get() as { n: number }
    ).n;
    return { files, chunks };
  }

  // -------------------------------------------------------------------------
  // File tracking
  // -------------------------------------------------------------------------

  async getFileHash(projectId: number, path: string): Promise<string | undefined> {
    const row = this.db
      .prepare("SELECT hash FROM memory_files WHERE project_id = ? AND path = ?")
      .get(projectId, path) as { hash: string } | undefined;
    return row?.hash;
  }

  async upsertFile(file: FileRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO memory_files (project_id, path, source, tier, hash, mtime, size)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, path) DO UPDATE SET
           source = excluded.source,
           tier   = excluded.tier,
           hash   = excluded.hash,
           mtime  = excluded.mtime,
           size   = excluded.size`
      )
      .run(file.projectId, file.path, file.source, file.tier, file.hash, file.mtime, file.size);
  }

  // -------------------------------------------------------------------------
  // Chunk management
  // -------------------------------------------------------------------------

  async getChunkIds(projectId: number, path: string): Promise<string[]> {
    const rows = this.db
      .prepare("SELECT id FROM memory_chunks WHERE project_id = ? AND path = ?")
      .all(projectId, path) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  async deleteChunksForFile(projectId: number, path: string): Promise<void> {
    const ids = await this.getChunkIds(projectId, path);
    const deleteFts = this.db.prepare("DELETE FROM memory_fts WHERE id = ?");
    const deleteChunks = this.db.prepare(
      "DELETE FROM memory_chunks WHERE project_id = ? AND path = ?"
    );
    this.db.transaction(() => {
      for (const id of ids) {
        deleteFts.run(id);
      }
      deleteChunks.run(projectId, path);
    })();
  }

  async insertChunks(chunks: ChunkRow[]): Promise<void> {
    if (chunks.length === 0) return;

    const insertChunk = this.db.prepare(
      `INSERT INTO memory_chunks (id, project_id, source, tier, path, start_line, end_line, hash, text, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertFts = this.db.prepare(
      `INSERT INTO memory_fts (text, id, project_id, path, source, tier, start_line, end_line)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    this.db.transaction(() => {
      for (const c of chunks) {
        insertChunk.run(
          c.id,
          c.projectId,
          c.source,
          c.tier,
          c.path,
          c.startLine,
          c.endLine,
          c.hash,
          c.text,
          c.updatedAt
        );
        insertFts.run(
          c.text,
          c.id,
          c.projectId,
          c.path,
          c.source,
          c.tier,
          c.startLine,
          c.endLine
        );
      }
    })();
  }

  async getUnembeddedChunkIds(projectId?: number): Promise<Array<{ id: string; text: string }>> {
    const conditions = ["embedding IS NULL"];
    const params: (string | number)[] = [];

    if (projectId !== undefined) {
      conditions.push("project_id = ?");
      params.push(projectId);
    }

    const where = "WHERE " + conditions.join(" AND ");
    const rows = this.db
      .prepare(`SELECT id, text FROM memory_chunks ${where} ORDER BY id`)
      .all(...params) as Array<{ id: string; text: string }>;
    return rows;
  }

  async updateEmbedding(chunkId: string, embedding: Buffer): Promise<void> {
    this.db
      .prepare("UPDATE memory_chunks SET embedding = ? WHERE id = ?")
      .run(embedding, chunkId);
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  async searchKeyword(query: string, opts?: SearchOptions): Promise<SearchResult[]> {
    return searchMemory(this.db, query, opts);
  }

  async searchSemantic(queryEmbedding: Float32Array, opts?: SearchOptions): Promise<SearchResult[]> {
    return searchMemorySemantic(this.db, queryEmbedding, opts);
  }
}
