/**
 * PostgresBackend — implements StorageBackend using PostgreSQL + pgvector.
 *
 * Vector similarity: pgvector's <=> cosine distance operator
 * Full-text search:  PostgreSQL tsvector/tsquery (replaces SQLite FTS5)
 * Connection pooling: node-postgres Pool
 *
 * Schema is auto-initialized on first connection if tables don't exist.
 * Per-user database isolation: each macOS user gets their own database (pai_<username>).
 */

import pg from "pg";
import type { Pool, PoolClient } from "pg";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  StorageBackend, ChunkRow, FileRow, FederationStats,
  VaultFileRow, VaultAliasRow, VaultLinkRow, VaultHealthRow, VaultNameEntry,
} from "../interface.js";
import type { SearchResult, SearchOptions } from "../../memory/search.js";
import type { PostgresConfig } from "./config.js";
import { bufferToVector } from "./helpers.js";
import { searchKeyword, searchSemantic } from "./search.js";
import * as vault from "./vault.js";

const { Pool: PgPool } = pg;

export class PostgresBackend implements StorageBackend {
  readonly backendType = "postgres" as const;

  private pool: Pool;

  /**
   * Ensure the per-user database exists and has the required schema.
   * Connects to the default 'postgres' database to CREATE DATABASE if needed,
   * then connects to the target database to apply init.sql schema.
   * Safe to call multiple times (fully idempotent).
   */
  static async ensureDatabase(config: PostgresConfig): Promise<void> {
    const connStr =
      config.connectionString ??
      `postgresql://${config.user ?? "pai"}:${config.password ?? "pai"}@${config.host ?? "localhost"}:${config.port ?? 5432}/${config.database ?? "pai"}`;
    const url = new URL(connStr);
    const targetDb = url.pathname.slice(1);

    const adminUrl = new URL(connStr);
    adminUrl.pathname = "/postgres";
    const adminPool = new PgPool({
      connectionString: adminUrl.toString(),
      max: 1,
      connectionTimeoutMillis: 5000,
    });

    try {
      const check = await adminPool.query(
        "SELECT 1 FROM pg_database WHERE datname = $1",
        [targetDb]
      );
      if (check.rowCount === 0) {
        await adminPool.query(`CREATE DATABASE "${targetDb}"`);
        process.stderr.write(`[pai-postgres] Created database: ${targetDb}\n`);
      }
    } finally {
      await adminPool.end();
    }

    const targetPool = new PgPool({
      connectionString: connStr,
      max: 1,
      connectionTimeoutMillis: 5000,
    });

    try {
      const tableCheck = await targetPool.query(
        "SELECT 1 FROM information_schema.tables WHERE table_name = 'pai_chunks'"
      );
      if (tableCheck.rowCount === 0) {
        const __dirname = dirname(fileURLToPath(import.meta.url));
        const initSqlPath = join(__dirname, "../../docker/init.sql");
        let initSql: string;
        try {
          initSql = readFileSync(initSqlPath, "utf-8");
        } catch {
          const altPath = join(__dirname, "../docker/init.sql");
          initSql = readFileSync(altPath, "utf-8");
        }
        await targetPool.query(initSql);
        process.stderr.write(`[pai-postgres] Applied schema to database: ${targetDb}\n`);
      }

      // Run incremental migrations for existing databases
      await PostgresBackend.runMigrations(targetPool);
    } finally {
      await targetPool.end();
    }
  }

  /**
   * Run incremental migrations for existing databases.
   * Each migration is idempotent — safe to run on databases that already have the change.
   */
  private static async runMigrations(pool: Pool): Promise<void> {
    // Migration: add confidence column to vault_links if it does not exist
    const colCheck = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'vault_links' AND column_name = 'confidence'`
    );
    if (colCheck.rowCount === 0) {
      await pool.query(
        "ALTER TABLE vault_links ADD COLUMN confidence TEXT NOT NULL DEFAULT 'EXTRACTED'"
      );
      process.stderr.write("[pai-postgres] Migration: added confidence column to vault_links\n");
    }

    // Migration: create kg_triples table if it does not exist
    const kgCheck = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'kg_triples'`
    );
    if (kgCheck.rowCount === 0) {
      await pool.query(`
        CREATE TABLE kg_triples (
          id             SERIAL PRIMARY KEY,
          subject        TEXT NOT NULL,
          predicate      TEXT NOT NULL,
          object         TEXT NOT NULL,
          project_id     INTEGER,
          source_session TEXT,
          valid_from     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          valid_to       TIMESTAMP,
          confidence     TEXT DEFAULT 'EXTRACTED',
          created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await pool.query(`CREATE INDEX idx_kg_subject   ON kg_triples(subject)`);
      await pool.query(`CREATE INDEX idx_kg_predicate ON kg_triples(predicate)`);
      await pool.query(`CREATE INDEX idx_kg_object    ON kg_triples(object)`);
      await pool.query(`CREATE INDEX idx_kg_valid     ON kg_triples(valid_from, valid_to)`);
      process.stderr.write("[pai-postgres] Migration: created kg_triples table\n");
    }
  }

  constructor(config: PostgresConfig) {
    const connStr =
      config.connectionString ??
      `postgresql://${config.user ?? "pai"}:${config.password ?? "pai"}@${config.host ?? "localhost"}:${config.port ?? 5432}/${config.database ?? "pai"}`;

    this.pool = new PgPool({
      connectionString: connStr,
      max: config.maxConnections ?? 5,
      connectionTimeoutMillis: config.connectionTimeoutMs ?? 5000,
      idleTimeoutMillis: 30_000,
    });

    this.pool.on("error", (err) => {
      process.stderr.write(`[pai-postgres] Pool error: ${err.message}\n`);
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Expose the underlying pg.Pool for callers that need direct query access
   * (e.g. the daemon's observation IPC methods).
   */
  getPool(): Pool {
    return this.pool;
  }

  async getStats(): Promise<FederationStats> {
    const client = await this.pool.connect();
    try {
      const filesResult = await client.query<{ n: string }>(
        "SELECT COUNT(*)::text AS n FROM pai_files"
      );
      const chunksResult = await client.query<{ n: string }>(
        "SELECT COUNT(*)::text AS n FROM pai_chunks"
      );
      return {
        files: parseInt(filesResult.rows[0]?.n ?? "0", 10),
        chunks: parseInt(chunksResult.rows[0]?.n ?? "0", 10),
      };
    } finally {
      client.release();
    }
  }

  /**
   * Test the connection by running a trivial query.
   * Returns null on success, error message on failure.
   */
  async testConnection(): Promise<string | null> {
    let client: PoolClient | null = null;
    try {
      client = await this.pool.connect();
      await client.query("SELECT 1");
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    } finally {
      client?.release();
    }
  }

  // -------------------------------------------------------------------------
  // File tracking
  // -------------------------------------------------------------------------

  async getFileHash(projectId: number, path: string): Promise<string | undefined> {
    const result = await this.pool.query<{ hash: string }>(
      "SELECT hash FROM pai_files WHERE project_id = $1 AND path = $2",
      [projectId, path]
    );
    return result.rows[0]?.hash;
  }

  async upsertFile(file: FileRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO pai_files (project_id, path, source, tier, hash, mtime, size)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (project_id, path) DO UPDATE SET
         source = EXCLUDED.source,
         tier   = EXCLUDED.tier,
         hash   = EXCLUDED.hash,
         mtime  = EXCLUDED.mtime,
         size   = EXCLUDED.size`,
      [file.projectId, file.path, file.source, file.tier, file.hash, file.mtime, file.size]
    );
  }

  // -------------------------------------------------------------------------
  // Chunk management
  // -------------------------------------------------------------------------

  async getChunkIds(projectId: number, path: string): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>(
      "SELECT id FROM pai_chunks WHERE project_id = $1 AND path = $2",
      [projectId, path]
    );
    return result.rows.map((r) => r.id);
  }

  async deleteChunksForFile(projectId: number, path: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM pai_chunks WHERE project_id = $1 AND path = $2",
      [projectId, path]
    );
  }

  async insertChunks(chunks: ChunkRow[]): Promise<void> {
    if (chunks.length === 0) return;

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      for (const c of chunks) {
        const safeText = c.text.replace(/\0/g, "");

        await client.query(
          `INSERT INTO pai_chunks
             (id, project_id, source, tier, path, start_line, end_line, hash, text, updated_at, fts_vector)
           VALUES
             ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
              to_tsvector('simple', $9))
           ON CONFLICT (id) DO UPDATE SET
             project_id = EXCLUDED.project_id,
             source     = EXCLUDED.source,
             tier       = EXCLUDED.tier,
             path       = EXCLUDED.path,
             start_line = EXCLUDED.start_line,
             end_line   = EXCLUDED.end_line,
             hash       = EXCLUDED.hash,
             text       = EXCLUDED.text,
             updated_at = EXCLUDED.updated_at,
             fts_vector = EXCLUDED.fts_vector`,
          [
            c.id, c.projectId, c.source, c.tier, c.path,
            c.startLine, c.endLine, c.hash, safeText, c.updatedAt,
          ]
        );
      }

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async getDistinctChunkPaths(projectId: number): Promise<string[]> {
    const result = await this.pool.query<{ path: string }>(
      "SELECT DISTINCT path FROM pai_chunks WHERE project_id = $1",
      [projectId]
    );
    return result.rows.map((r) => r.path);
  }

  async deletePaths(projectId: number, paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const path of paths) {
        await client.query("DELETE FROM pai_chunks WHERE project_id = $1 AND path = $2", [projectId, path]);
        await client.query("DELETE FROM pai_files WHERE project_id = $1 AND path = $2", [projectId, path]);
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async getUnembeddedChunkIds(projectId?: number): Promise<Array<{ id: string; text: string; project_id: number; path: string }>> {
    if (projectId !== undefined) {
      const result = await this.pool.query<{ id: string; text: string; project_id: number; path: string }>(
        "SELECT id, text, project_id, path FROM pai_chunks WHERE embedding IS NULL AND project_id = $1 ORDER BY id",
        [projectId]
      );
      return result.rows;
    }
    const result = await this.pool.query<{ id: string; text: string; project_id: number; path: string }>(
      "SELECT id, text, project_id, path FROM pai_chunks WHERE embedding IS NULL ORDER BY id"
    );
    return result.rows;
  }

  async updateEmbedding(chunkId: string, embedding: Buffer): Promise<void> {
    const vec = bufferToVector(embedding);
    const vecStr = "[" + vec.join(",") + "]";
    await this.pool.query(
      "UPDATE pai_chunks SET embedding = $1::vector WHERE id = $2",
      [vecStr, chunkId]
    );
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  async searchKeyword(query: string, opts?: SearchOptions): Promise<SearchResult[]> {
    return searchKeyword(this.pool, query, opts);
  }

  async searchSemantic(queryEmbedding: Float32Array, opts?: SearchOptions): Promise<SearchResult[]> {
    return searchSemantic(this.pool, queryEmbedding, opts);
  }

  // -------------------------------------------------------------------------
  // Vault operations — delegated to vault.ts
  // -------------------------------------------------------------------------

  async upsertVaultFile(file: VaultFileRow): Promise<void> { return vault.upsertVaultFile(this.pool, file); }
  async deleteVaultFile(vaultPath: string): Promise<void> { return vault.deleteVaultFile(this.pool, vaultPath); }
  async getVaultFile(vaultPath: string): Promise<VaultFileRow | null> { return vault.getVaultFile(this.pool, vaultPath); }
  async getVaultFileByInode(inode: number, device: number): Promise<VaultFileRow | null> { return vault.getVaultFileByInode(this.pool, inode, device); }
  async getAllVaultFiles(): Promise<VaultFileRow[]> { return vault.getAllVaultFiles(this.pool); }
  async getRecentVaultFiles(sinceMs: number): Promise<VaultFileRow[]> { return vault.getRecentVaultFiles(this.pool, sinceMs); }
  async countVaultFiles(): Promise<number> { return vault.countVaultFiles(this.pool); }
  async countVaultFilesWithPrefix(prefix: string): Promise<number> { return vault.countVaultFilesWithPrefix(this.pool, prefix); }
  async countVaultFilesAfter(sinceMs: number): Promise<number> { return vault.countVaultFilesAfter(this.pool, sinceMs); }
  async getVaultFilesByPaths(paths: string[]): Promise<VaultFileRow[]> { return vault.getVaultFilesByPaths(this.pool, paths); }
  async getVaultFilesByPathsAfter(paths: string[], sinceMs: number): Promise<VaultFileRow[]> { return vault.getVaultFilesByPathsAfter(this.pool, paths, sinceMs); }
  async getAllVaultFilePaths(): Promise<string[]> { return vault.getAllVaultFilePaths(this.pool); }
  async getVaultFilePathsWithPrefix(prefix: string): Promise<string[]> { return vault.getVaultFilePathsWithPrefix(this.pool, prefix); }
  async getVaultFilePathsAfter(sinceMs: number): Promise<string[]> { return vault.getVaultFilePathsAfter(this.pool, sinceMs); }

  async upsertVaultAliases(aliases: VaultAliasRow[]): Promise<void> { return vault.upsertVaultAliases(this.pool, aliases); }
  async deleteVaultAliases(canonicalPath: string): Promise<void> { return vault.deleteVaultAliases(this.pool, canonicalPath); }
  async getVaultAlias(vaultPath: string): Promise<{ canonicalPath: string } | null> { return vault.getVaultAlias(this.pool, vaultPath); }

  async replaceLinksForSources(sourcePaths: string[], links: VaultLinkRow[]): Promise<void> { return vault.replaceLinksForSources(this.pool, sourcePaths, links); }
  async getLinksFromSource(sourcePath: string): Promise<VaultLinkRow[]> { return vault.getLinksFromSource(this.pool, sourcePath); }
  async getLinksToTarget(targetPath: string): Promise<VaultLinkRow[]> { return vault.getLinksToTarget(this.pool, targetPath); }
  async getVaultLinkGraph(): Promise<Array<{ source_path: string; target_path: string }>> { return vault.getVaultLinkGraph(this.pool); }
  async getDeadLinks(): Promise<Array<{ sourcePath: string; targetRaw: string }>> { return vault.getDeadLinks(this.pool); }
  async getDeadLinksWithLineNumbers(): Promise<Array<{ sourcePath: string; targetRaw: string; lineNumber: number }>> { return vault.getDeadLinksWithLineNumbers(this.pool); }
  async getDeadLinksWithPrefix(prefix: string): Promise<Array<{ sourcePath: string; targetRaw: string; lineNumber: number }>> { return vault.getDeadLinksWithPrefix(this.pool, prefix); }
  async getDeadLinksAfter(sinceMs: number): Promise<Array<{ sourcePath: string; targetRaw: string; lineNumber: number }>> { return vault.getDeadLinksAfter(this.pool, sinceMs); }
  async countVaultLinksWithPrefix(prefix: string): Promise<number> { return vault.countVaultLinksWithPrefix(this.pool, prefix); }
  async countVaultLinksAfter(sinceMs: number): Promise<number> { return vault.countVaultLinksAfter(this.pool, sinceMs); }
  async getVaultLinksFromPaths(sourcePaths: string[]): Promise<VaultLinkRow[]> { return vault.getVaultLinksFromPaths(this.pool, sourcePaths); }
  async getVaultLinkEdges(): Promise<Array<{ source: string; target: string }>> { return vault.getVaultLinkEdges(this.pool); }
  async getVaultLinkEdgesWithPrefix(prefix: string): Promise<Array<{ source: string; target: string }>> { return vault.getVaultLinkEdgesWithPrefix(this.pool, prefix); }
  async getVaultLinkEdgesAfter(sinceMs: number): Promise<Array<{ source: string; target: string }>> { return vault.getVaultLinkEdgesAfter(this.pool, sinceMs); }

  async upsertVaultHealth(rows: VaultHealthRow[]): Promise<void> { return vault.upsertVaultHealth(this.pool, rows); }
  async getVaultHealth(vaultPath: string): Promise<VaultHealthRow | null> { return vault.getVaultHealth(this.pool, vaultPath); }
  async getOrphans(): Promise<VaultHealthRow[]> { return vault.getOrphans(this.pool); }
  async getOrphansWithPrefix(prefix: string): Promise<string[]> { return vault.getOrphansWithPrefix(this.pool, prefix); }
  async getOrphansAfter(sinceMs: number): Promise<string[]> { return vault.getOrphansAfter(this.pool, sinceMs); }
  async getLowConnectivity(): Promise<string[]> { return vault.getLowConnectivity(this.pool); }
  async getLowConnectivityWithPrefix(prefix: string): Promise<string[]> { return vault.getLowConnectivityWithPrefix(this.pool, prefix); }
  async getLowConnectivityAfter(sinceMs: number): Promise<string[]> { return vault.getLowConnectivityAfter(this.pool, sinceMs); }

  async upsertNameIndex(entries: VaultNameEntry[]): Promise<void> { return vault.upsertNameIndex(this.pool, entries); }
  async replaceNameIndex(entries: VaultNameEntry[]): Promise<void> { return vault.replaceNameIndex(this.pool, entries); }
  async resolveVaultName(name: string): Promise<string[]> { return vault.resolveVaultName(this.pool, name); }
  async searchVaultNameIndex(query: string, limit?: number): Promise<string[]> { return vault.searchVaultNameIndex(this.pool, query, limit); }

  // Legacy memory_chunks methods (used by graph and zettelkasten modules)
  async getChunksWithEmbeddings(projectId: number, limit: number): Promise<Array<{ path: string; text: string; embedding: Buffer }>> {
    const r = await this.pool.query<{ path: string; text: string; embedding: Buffer }>(
      `SELECT path, text, embedding FROM memory_chunks WHERE project_id = $1 AND embedding IS NOT NULL ORDER BY path, start_line LIMIT $2`,
      [projectId, limit]
    );
    return r.rows;
  }

  async getChunksForPath(projectId: number, path: string, limit = 20): Promise<Array<{ text: string; embedding: Buffer | null }>> {
    const r = await this.pool.query<{ text: string; embedding: Buffer | null }>(
      `SELECT text, embedding FROM memory_chunks WHERE project_id = $1 AND path = $2 AND embedding IS NOT NULL ORDER BY start_line LIMIT $3`,
      [projectId, path, limit]
    );
    return r.rows;
  }

  async searchChunksByText(projectId: number, query: string, limit: number): Promise<Array<{ path: string; text: string }>> {
    const r = await this.pool.query<{ path: string; text: string }>(
      `SELECT DISTINCT path, text FROM memory_chunks WHERE project_id = $1 AND lower(text) LIKE lower($2) LIMIT $3`,
      [projectId, `%${query}%`, limit]
    );
    return r.rows;
  }
}
