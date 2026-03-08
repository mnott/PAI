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
} from "./interface.js";
import type { SearchResult, SearchOptions } from "../memory/search.js";
import { buildFtsQuery } from "../memory/search.js";

const { Pool: PgPool } = pg;

// ---------------------------------------------------------------------------
// Postgres config
// ---------------------------------------------------------------------------

export interface PostgresConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  /** Maximum pool connections. Default 5 */
  maxConnections?: number;
  /** Connection timeout in ms. Default 5000 */
  connectionTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

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
    // Parse target database name from connection string or config
    const connStr =
      config.connectionString ??
      `postgresql://${config.user ?? "pai"}:${config.password ?? "pai"}@${config.host ?? "localhost"}:${config.port ?? 5432}/${config.database ?? "pai"}`;
    const url = new URL(connStr);
    const targetDb = url.pathname.slice(1); // strip leading /

    // Connect to default 'postgres' database to check/create the target
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
        // CREATE DATABASE doesn't support parameterized queries;
        // the DB name is derived from config, not user input
        await adminPool.query(`CREATE DATABASE "${targetDb}"`);
        process.stderr.write(
          `[pai-postgres] Created database: ${targetDb}\n`
        );
      }
    } finally {
      await adminPool.end();
    }

    // Now connect to the target database and apply schema
    const targetPool = new PgPool({
      connectionString: connStr,
      max: 1,
      connectionTimeoutMillis: 5000,
    });

    try {
      // Check if schema is already applied (pai_chunks table exists)
      const tableCheck = await targetPool.query(
        "SELECT 1 FROM information_schema.tables WHERE table_name = 'pai_chunks'"
      );
      if (tableCheck.rowCount === 0) {
        // Read init.sql from the docker/ directory
        const __dirname = dirname(fileURLToPath(import.meta.url));
        const initSqlPath = join(__dirname, "../../docker/init.sql");
        let initSql: string;
        try {
          initSql = readFileSync(initSqlPath, "utf-8");
        } catch {
          // Fallback: try relative to dist/ (built code)
          const altPath = join(__dirname, "../docker/init.sql");
          initSql = readFileSync(altPath, "utf-8");
        }
        await targetPool.query(initSql);
        process.stderr.write(
          `[pai-postgres] Applied schema to database: ${targetDb}\n`
        );
      }
    } finally {
      await targetPool.end();
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

    // Log pool errors so they don't crash the process silently
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
   * Mirrors SQLiteBackend.getRawDb().
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
    // Foreign key CASCADE handles pai_chunks deletion automatically
    // but we don't have FK to pai_chunks from pai_files, so delete explicitly
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
        // Strip null bytes — Postgres rejects \0 in text columns
        const safeText = c.text.replace(/\0/g, "");

        // embedding is null at insert time; updated separately via updateEmbedding()
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
            c.id,
            c.projectId,
            c.source,
            c.tier,
            c.path,
            c.startLine,
            c.endLine,
            c.hash,
            safeText,
            c.updatedAt,
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
        await client.query(
          "DELETE FROM pai_chunks WHERE project_id = $1 AND path = $2",
          [projectId, path]
        );
        await client.query(
          "DELETE FROM pai_files WHERE project_id = $1 AND path = $2",
          [projectId, path]
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
    // Deserialize the Buffer (Float32Array LE bytes) to a number[] for pgvector
    const vec = bufferToVector(embedding);
    const vecStr = "[" + vec.join(",") + "]";
    await this.pool.query(
      "UPDATE pai_chunks SET embedding = $1::vector WHERE id = $2",
      [vecStr, chunkId]
    );
  }

  // -------------------------------------------------------------------------
  // Search — keyword (tsvector/tsquery)
  // -------------------------------------------------------------------------

  async searchKeyword(query: string, opts?: SearchOptions): Promise<SearchResult[]> {
    const maxResults = opts?.maxResults ?? 10;

    // Build tsquery from the same token logic as buildFtsQuery, but for Postgres
    const tsQuery = buildPgTsQuery(query);
    if (!tsQuery) return [];

    // Use 'simple' dictionary: preserves tokens as-is, no language-specific
    // stemming. Works reliably with any language (German, French, etc.).
    const conditions: string[] = ["fts_vector @@ to_tsquery('simple', $1)"];
    const params: (string | number)[] = [tsQuery];
    let paramIdx = 2;

    if (opts?.projectIds && opts.projectIds.length > 0) {
      const placeholders = opts.projectIds.map(() => `$${paramIdx++}`).join(", ");
      conditions.push(`project_id IN (${placeholders})`);
      params.push(...opts.projectIds);
    }

    if (opts?.sources && opts.sources.length > 0) {
      const placeholders = opts.sources.map(() => `$${paramIdx++}`).join(", ");
      conditions.push(`source IN (${placeholders})`);
      params.push(...opts.sources);
    }

    if (opts?.tiers && opts.tiers.length > 0) {
      const placeholders = opts.tiers.map(() => `$${paramIdx++}`).join(", ");
      conditions.push(`tier IN (${placeholders})`);
      params.push(...opts.tiers);
    }

    params.push(maxResults);
    const limitParam = `$${paramIdx}`;

    const sql = `
      SELECT
        project_id,
        path,
        start_line,
        end_line,
        text AS snippet,
        tier,
        source,
        ts_rank(fts_vector, to_tsquery('simple', $1)) AS rank_score
      FROM pai_chunks
      WHERE ${conditions.join(" AND ")}
      ORDER BY rank_score DESC
      LIMIT ${limitParam}
    `;

    try {
      const result = await this.pool.query<{
        project_id: number;
        path: string;
        start_line: number;
        end_line: number;
        snippet: string;
        tier: string;
        source: string;
        rank_score: number;
      }>(sql, params);

      return result.rows.map((row) => ({
        projectId: row.project_id,
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line,
        snippet: row.snippet,
        score: row.rank_score,
        tier: row.tier,
        source: row.source,
      }));
    } catch (e) {
      process.stderr.write(`[pai-postgres] searchKeyword error: ${e}\n`);
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Search — semantic (pgvector cosine distance)
  // -------------------------------------------------------------------------

  async searchSemantic(queryEmbedding: Float32Array, opts?: SearchOptions): Promise<SearchResult[]> {
    const maxResults = opts?.maxResults ?? 10;

    const conditions: string[] = ["embedding IS NOT NULL"];
    const params: (string | number | string)[] = [];
    let paramIdx = 1;

    // pgvector vector literal
    const vecStr = "[" + Array.from(queryEmbedding).join(",") + "]";
    params.push(vecStr);
    const vecParam = `$${paramIdx++}`;

    if (opts?.projectIds && opts.projectIds.length > 0) {
      const placeholders = opts.projectIds.map(() => `$${paramIdx++}`).join(", ");
      conditions.push(`project_id IN (${placeholders})`);
      params.push(...opts.projectIds);
    }

    if (opts?.sources && opts.sources.length > 0) {
      const placeholders = opts.sources.map(() => `$${paramIdx++}`).join(", ");
      conditions.push(`source IN (${placeholders})`);
      params.push(...opts.sources);
    }

    if (opts?.tiers && opts.tiers.length > 0) {
      const placeholders = opts.tiers.map(() => `$${paramIdx++}`).join(", ");
      conditions.push(`tier IN (${placeholders})`);
      params.push(...opts.tiers);
    }

    params.push(maxResults);
    const limitParam = `$${paramIdx}`;

    // <=> is cosine distance; 1 - distance = cosine similarity
    const sql = `
      SELECT
        project_id,
        path,
        start_line,
        end_line,
        text AS snippet,
        tier,
        source,
        1 - (embedding <=> ${vecParam}::vector) AS cosine_similarity
      FROM pai_chunks
      WHERE ${conditions.join(" AND ")}
      ORDER BY embedding <=> ${vecParam}::vector
      LIMIT ${limitParam}
    `;

    try {
      const result = await this.pool.query<{
        project_id: number;
        path: string;
        start_line: number;
        end_line: number;
        snippet: string;
        tier: string;
        source: string;
        cosine_similarity: number;
      }>(sql, params);

      const minScore = opts?.minScore ?? -Infinity;

      return result.rows
        .map((row) => ({
          projectId: row.project_id,
          path: row.path,
          startLine: row.start_line,
          endLine: row.end_line,
          snippet: row.snippet,
          score: row.cosine_similarity,
          tier: row.tier,
          source: row.source,
        }))
        .filter((r) => r.score >= minScore);
    } catch (e) {
      process.stderr.write(`[pai-postgres] searchSemantic error: ${e}\n`);
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Vault operations
  // -------------------------------------------------------------------------

  async upsertVaultFile(file: VaultFileRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO vault_files (vault_path, inode, device, hash, title, indexed_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (vault_path) DO UPDATE SET
         inode = EXCLUDED.inode, device = EXCLUDED.device,
         hash = EXCLUDED.hash, title = EXCLUDED.title,
         indexed_at = EXCLUDED.indexed_at`,
      [file.vaultPath, file.inode, file.device, file.hash, file.title, file.indexedAt]
    );
  }

  async deleteVaultFile(vaultPath: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM vault_links WHERE source_path = $1", [vaultPath]);
      await client.query("DELETE FROM vault_health WHERE vault_path = $1", [vaultPath]);
      await client.query("DELETE FROM vault_name_index WHERE vault_path = $1", [vaultPath]);
      await client.query("DELETE FROM vault_aliases WHERE vault_path = $1 OR canonical_path = $1", [vaultPath]);
      await client.query("DELETE FROM vault_files WHERE vault_path = $1", [vaultPath]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async getVaultFile(vaultPath: string): Promise<VaultFileRow | null> {
    const r = await this.pool.query<{ vault_path: string; inode: string; device: string; hash: string; title: string | null; indexed_at: string }>(
      "SELECT vault_path, inode, device, hash, title, indexed_at FROM vault_files WHERE vault_path = $1",
      [vaultPath]
    );
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    return { vaultPath: row.vault_path, inode: Number(row.inode), device: Number(row.device), hash: row.hash, title: row.title, indexedAt: Number(row.indexed_at) };
  }

  async getVaultFileByInode(inode: number, device: number): Promise<VaultFileRow | null> {
    const r = await this.pool.query<{ vault_path: string; inode: string; device: string; hash: string; title: string | null; indexed_at: string }>(
      "SELECT vault_path, inode, device, hash, title, indexed_at FROM vault_files WHERE inode = $1 AND device = $2 LIMIT 1",
      [inode, device]
    );
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    return { vaultPath: row.vault_path, inode: Number(row.inode), device: Number(row.device), hash: row.hash, title: row.title, indexedAt: Number(row.indexed_at) };
  }

  async getAllVaultFiles(): Promise<VaultFileRow[]> {
    const r = await this.pool.query<{ vault_path: string; inode: string; device: string; hash: string; title: string | null; indexed_at: string }>(
      "SELECT vault_path, inode, device, hash, title, indexed_at FROM vault_files"
    );
    return r.rows.map(row => ({
      vaultPath: row.vault_path, inode: Number(row.inode), device: Number(row.device),
      hash: row.hash, title: row.title, indexedAt: Number(row.indexed_at),
    }));
  }

  async getRecentVaultFiles(sinceMs: number): Promise<VaultFileRow[]> {
    const r = await this.pool.query<{ vault_path: string; inode: string; device: string; hash: string; title: string | null; indexed_at: string }>(
      "SELECT vault_path, inode, device, hash, title, indexed_at FROM vault_files WHERE indexed_at > $1",
      [sinceMs]
    );
    return r.rows.map(row => ({
      vaultPath: row.vault_path, inode: Number(row.inode), device: Number(row.device),
      hash: row.hash, title: row.title, indexedAt: Number(row.indexed_at),
    }));
  }

  async countVaultFiles(): Promise<number> {
    const r = await this.pool.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM vault_files");
    return parseInt(r.rows[0]?.n ?? "0", 10);
  }

  async upsertVaultAliases(aliases: VaultAliasRow[]): Promise<void> {
    if (aliases.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const a of aliases) {
        await client.query(
          `INSERT INTO vault_aliases (vault_path, canonical_path, inode, device)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (vault_path) DO UPDATE SET
             canonical_path = EXCLUDED.canonical_path,
             inode = EXCLUDED.inode, device = EXCLUDED.device`,
          [a.vaultPath, a.canonicalPath, a.inode, a.device]
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

  async deleteVaultAliases(canonicalPath: string): Promise<void> {
    await this.pool.query("DELETE FROM vault_aliases WHERE canonical_path = $1", [canonicalPath]);
  }

  async replaceLinksForSources(sourcePaths: string[], links: VaultLinkRow[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Delete existing links for these sources
      if (sourcePaths.length > 0) {
        await client.query(
          "DELETE FROM vault_links WHERE source_path = ANY($1::text[])",
          [sourcePaths]
        );
      }
      // Bulk insert new links
      for (let i = 0; i < links.length; i += 500) {
        const batch = links.slice(i, i + 500);
        const values: string[] = [];
        const params: (string | number | null)[] = [];
        let idx = 1;
        for (const l of batch) {
          values.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
          params.push(l.sourcePath, l.targetRaw, l.targetPath, l.linkType, l.lineNumber);
        }
        await client.query(
          `INSERT INTO vault_links (source_path, target_raw, target_path, link_type, line_number)
           VALUES ${values.join(", ")}
           ON CONFLICT (source_path, target_raw, line_number) DO UPDATE SET
             target_path = EXCLUDED.target_path, link_type = EXCLUDED.link_type`,
          params
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

  async getLinksFromSource(sourcePath: string): Promise<VaultLinkRow[]> {
    const r = await this.pool.query<{ source_path: string; target_raw: string; target_path: string | null; link_type: string; line_number: number }>(
      "SELECT source_path, target_raw, target_path, link_type, line_number FROM vault_links WHERE source_path = $1",
      [sourcePath]
    );
    return r.rows.map(row => ({
      sourcePath: row.source_path, targetRaw: row.target_raw,
      targetPath: row.target_path, linkType: row.link_type, lineNumber: row.line_number,
    }));
  }

  async getLinksToTarget(targetPath: string): Promise<VaultLinkRow[]> {
    const r = await this.pool.query<{ source_path: string; target_raw: string; target_path: string | null; link_type: string; line_number: number }>(
      "SELECT source_path, target_raw, target_path, link_type, line_number FROM vault_links WHERE target_path = $1",
      [targetPath]
    );
    return r.rows.map(row => ({
      sourcePath: row.source_path, targetRaw: row.target_raw,
      targetPath: row.target_path, linkType: row.link_type, lineNumber: row.line_number,
    }));
  }

  async getVaultLinkGraph(): Promise<Array<{ source_path: string; target_path: string }>> {
    const r = await this.pool.query<{ source_path: string; target_path: string }>(
      "SELECT source_path, target_path FROM vault_links WHERE target_path IS NOT NULL"
    );
    return r.rows;
  }

  async upsertVaultHealth(rows: VaultHealthRow[]): Promise<void> {
    if (rows.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const h of rows) {
        await client.query(
          `INSERT INTO vault_health (vault_path, inbound_count, outbound_count, dead_link_count, is_orphan, computed_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (vault_path) DO UPDATE SET
             inbound_count = EXCLUDED.inbound_count,
             outbound_count = EXCLUDED.outbound_count,
             dead_link_count = EXCLUDED.dead_link_count,
             is_orphan = EXCLUDED.is_orphan,
             computed_at = EXCLUDED.computed_at`,
          [h.vaultPath, h.inboundCount, h.outboundCount, h.deadLinkCount, h.isOrphan ? 1 : 0, h.computedAt]
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

  async getVaultHealth(vaultPath: string): Promise<VaultHealthRow | null> {
    const r = await this.pool.query<{ vault_path: string; inbound_count: number; outbound_count: number; dead_link_count: number; is_orphan: number; computed_at: string }>(
      "SELECT vault_path, inbound_count, outbound_count, dead_link_count, is_orphan, computed_at FROM vault_health WHERE vault_path = $1",
      [vaultPath]
    );
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    return {
      vaultPath: row.vault_path, inboundCount: row.inbound_count,
      outboundCount: row.outbound_count, deadLinkCount: row.dead_link_count,
      isOrphan: row.is_orphan === 1, computedAt: Number(row.computed_at),
    };
  }

  async getOrphans(): Promise<VaultHealthRow[]> {
    const r = await this.pool.query<{ vault_path: string; inbound_count: number; outbound_count: number; dead_link_count: number; is_orphan: number; computed_at: string }>(
      "SELECT vault_path, inbound_count, outbound_count, dead_link_count, is_orphan, computed_at FROM vault_health WHERE is_orphan = 1"
    );
    return r.rows.map(row => ({
      vaultPath: row.vault_path, inboundCount: row.inbound_count,
      outboundCount: row.outbound_count, deadLinkCount: row.dead_link_count,
      isOrphan: true, computedAt: Number(row.computed_at),
    }));
  }

  async getDeadLinks(): Promise<Array<{ sourcePath: string; targetRaw: string }>> {
    const r = await this.pool.query<{ source_path: string; target_raw: string }>(
      "SELECT source_path, target_raw FROM vault_links WHERE target_path IS NULL"
    );
    return r.rows.map(row => ({ sourcePath: row.source_path, targetRaw: row.target_raw }));
  }

  async upsertNameIndex(entries: VaultNameEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const e of entries) {
        await client.query(
          `INSERT INTO vault_name_index (name, vault_path)
           VALUES ($1, $2) ON CONFLICT (name, vault_path) DO NOTHING`,
          [e.name, e.vaultPath]
        );
      }
      await client.query("COMMIT");
    } catch (e_) {
      await client.query("ROLLBACK");
      throw e_;
    } finally {
      client.release();
    }
  }

  async replaceNameIndex(entries: VaultNameEntry[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM vault_name_index");
      for (let i = 0; i < entries.length; i += 500) {
        const batch = entries.slice(i, i + 500);
        const values: string[] = [];
        const params: string[] = [];
        let idx = 1;
        for (const e of batch) {
          values.push(`($${idx++}, $${idx++})`);
          params.push(e.name, e.vaultPath);
        }
        await client.query(
          `INSERT INTO vault_name_index (name, vault_path) VALUES ${values.join(", ")}`,
          params
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

  async resolveVaultName(name: string): Promise<string[]> {
    const r = await this.pool.query<{ vault_path: string }>(
      "SELECT vault_path FROM vault_name_index WHERE name = $1",
      [name]
    );
    return r.rows.map(row => row.vault_path);
  }

  async searchVaultNameIndex(query: string, limit = 100): Promise<string[]> {
    const r = await this.pool.query<{ vault_path: string }>(
      "SELECT DISTINCT vault_path FROM vault_name_index WHERE lower(name) LIKE lower($1) LIMIT $2",
      [`%${query}%`, limit]
    );
    return r.rows.map(row => row.vault_path);
  }

  async getVaultFilesByPaths(paths: string[]): Promise<import("./interface.js").VaultFileRow[]> {
    if (paths.length === 0) return [];
    const placeholders = paths.map((_, i) => `$${i + 1}`).join(", ");
    const r = await this.pool.query<{ vault_path: string; inode: number; device: number; hash: string; title: string | null; indexed_at: string }>(
      `SELECT vault_path, inode, device, hash, title, indexed_at FROM vault_files WHERE vault_path IN (${placeholders})`,
      paths
    );
    return r.rows.map(row => ({
      vaultPath: row.vault_path, inode: Number(row.inode), device: Number(row.device),
      hash: row.hash, title: row.title, indexedAt: Number(row.indexed_at),
    }));
  }

  async getVaultFilesByPathsAfter(paths: string[], sinceMs: number): Promise<import("./interface.js").VaultFileRow[]> {
    if (paths.length === 0) return [];
    const placeholders = paths.map((_, i) => `$${i + 1}`).join(", ");
    const r = await this.pool.query<{ vault_path: string; inode: number; device: number; hash: string; title: string | null; indexed_at: string }>(
      `SELECT vault_path, inode, device, hash, title, indexed_at FROM vault_files WHERE vault_path IN (${placeholders}) AND indexed_at >= $${paths.length + 1} ORDER BY indexed_at ASC`,
      [...paths, sinceMs]
    );
    return r.rows.map(row => ({
      vaultPath: row.vault_path, inode: Number(row.inode), device: Number(row.device),
      hash: row.hash, title: row.title, indexedAt: Number(row.indexed_at),
    }));
  }

  async getVaultLinksFromPaths(sourcePaths: string[]): Promise<import("./interface.js").VaultLinkRow[]> {
    if (sourcePaths.length === 0) return [];
    const placeholders = sourcePaths.map((_, i) => `$${i + 1}`).join(", ");
    const r = await this.pool.query<{ source_path: string; target_raw: string; target_path: string | null; link_type: string; line_number: number }>(
      `SELECT source_path, target_raw, target_path, link_type, line_number FROM vault_links WHERE source_path IN (${placeholders}) AND target_path IS NOT NULL`,
      sourcePaths
    );
    return r.rows.map(row => ({
      sourcePath: row.source_path, targetRaw: row.target_raw, targetPath: row.target_path,
      linkType: row.link_type, lineNumber: row.line_number,
    }));
  }

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

  async countVaultFilesWithPrefix(prefix: string): Promise<number> {
    const r = await this.pool.query<{ n: string }>("SELECT COUNT(*) AS n FROM vault_files WHERE vault_path LIKE $1", [`${prefix}%`]);
    return Number(r.rows[0]?.n ?? 0);
  }

  async countVaultFilesAfter(sinceMs: number): Promise<number> {
    const r = await this.pool.query<{ n: string }>("SELECT COUNT(*) AS n FROM vault_files WHERE indexed_at > $1", [sinceMs]);
    return Number(r.rows[0]?.n ?? 0);
  }

  async countVaultLinksWithPrefix(prefix: string): Promise<number> {
    const r = await this.pool.query<{ n: string }>("SELECT COUNT(*) AS n FROM vault_links WHERE source_path LIKE $1", [`${prefix}%`]);
    return Number(r.rows[0]?.n ?? 0);
  }

  async countVaultLinksAfter(sinceMs: number): Promise<number> {
    const r = await this.pool.query<{ n: string }>(
      "SELECT COUNT(*) AS n FROM vault_links WHERE source_path IN (SELECT vault_path FROM vault_files WHERE indexed_at > $1)",
      [sinceMs]
    );
    return Number(r.rows[0]?.n ?? 0);
  }

  async getDeadLinksWithLineNumbers(): Promise<Array<{ sourcePath: string; targetRaw: string; lineNumber: number }>> {
    const r = await this.pool.query<{ source_path: string; target_raw: string; line_number: number }>(
      "SELECT source_path, target_raw, line_number FROM vault_links WHERE target_path IS NULL"
    );
    return r.rows.map(row => ({ sourcePath: row.source_path, targetRaw: row.target_raw, lineNumber: row.line_number }));
  }

  async getDeadLinksWithPrefix(prefix: string): Promise<Array<{ sourcePath: string; targetRaw: string; lineNumber: number }>> {
    const r = await this.pool.query<{ source_path: string; target_raw: string; line_number: number }>(
      "SELECT source_path, target_raw, line_number FROM vault_links WHERE target_path IS NULL AND source_path LIKE $1",
      [`${prefix}%`]
    );
    return r.rows.map(row => ({ sourcePath: row.source_path, targetRaw: row.target_raw, lineNumber: row.line_number }));
  }

  async getDeadLinksAfter(sinceMs: number): Promise<Array<{ sourcePath: string; targetRaw: string; lineNumber: number }>> {
    const r = await this.pool.query<{ source_path: string; target_raw: string; line_number: number }>(
      "SELECT source_path, target_raw, line_number FROM vault_links WHERE target_path IS NULL AND source_path IN (SELECT vault_path FROM vault_files WHERE indexed_at > $1)",
      [sinceMs]
    );
    return r.rows.map(row => ({ sourcePath: row.source_path, targetRaw: row.target_raw, lineNumber: row.line_number }));
  }

  async getOrphansWithPrefix(prefix: string): Promise<string[]> {
    const r = await this.pool.query<{ vault_path: string }>(
      "SELECT vault_path FROM vault_health WHERE is_orphan = 1 AND vault_path LIKE $1",
      [`${prefix}%`]
    );
    return r.rows.map(row => row.vault_path);
  }

  async getOrphansAfter(sinceMs: number): Promise<string[]> {
    const r = await this.pool.query<{ vault_path: string }>(
      "SELECT vh.vault_path FROM vault_health vh JOIN vault_files vf ON vh.vault_path = vf.vault_path WHERE vh.is_orphan = 1 AND vf.indexed_at > $1",
      [sinceMs]
    );
    return r.rows.map(row => row.vault_path);
  }

  async getLowConnectivity(): Promise<string[]> {
    const r = await this.pool.query<{ vault_path: string }>(
      "SELECT vault_path FROM vault_health WHERE inbound_count + outbound_count <= 1"
    );
    return r.rows.map(row => row.vault_path);
  }

  async getLowConnectivityWithPrefix(prefix: string): Promise<string[]> {
    const r = await this.pool.query<{ vault_path: string }>(
      "SELECT vault_path FROM vault_health WHERE inbound_count + outbound_count <= 1 AND vault_path LIKE $1",
      [`${prefix}%`]
    );
    return r.rows.map(row => row.vault_path);
  }

  async getLowConnectivityAfter(sinceMs: number): Promise<string[]> {
    const r = await this.pool.query<{ vault_path: string }>(
      "SELECT vh.vault_path FROM vault_health vh JOIN vault_files vf ON vh.vault_path = vf.vault_path WHERE vh.inbound_count + vh.outbound_count <= 1 AND vf.indexed_at > $1",
      [sinceMs]
    );
    return r.rows.map(row => row.vault_path);
  }

  async getAllVaultFilePaths(): Promise<string[]> {
    const r = await this.pool.query<{ vault_path: string }>("SELECT vault_path FROM vault_files");
    return r.rows.map(row => row.vault_path);
  }

  async getVaultFilePathsWithPrefix(prefix: string): Promise<string[]> {
    const r = await this.pool.query<{ vault_path: string }>(
      "SELECT vault_path FROM vault_files WHERE vault_path LIKE $1",
      [`${prefix}%`]
    );
    return r.rows.map(row => row.vault_path);
  }

  async getVaultFilePathsAfter(sinceMs: number): Promise<string[]> {
    const r = await this.pool.query<{ vault_path: string }>(
      "SELECT vault_path FROM vault_files WHERE indexed_at > $1",
      [sinceMs]
    );
    return r.rows.map(row => row.vault_path);
  }

  async getVaultLinkEdges(): Promise<Array<{ source: string; target: string }>> {
    const r = await this.pool.query<{ source: string; target: string }>(
      "SELECT DISTINCT source_path AS source, target_path AS target FROM vault_links WHERE target_path IS NOT NULL"
    );
    return r.rows;
  }

  async getVaultLinkEdgesWithPrefix(prefix: string): Promise<Array<{ source: string; target: string }>> {
    const r = await this.pool.query<{ source: string; target: string }>(
      "SELECT DISTINCT source_path AS source, target_path AS target FROM vault_links WHERE target_path IS NOT NULL AND source_path LIKE $1",
      [`${prefix}%`]
    );
    return r.rows;
  }

  async getVaultLinkEdgesAfter(sinceMs: number): Promise<Array<{ source: string; target: string }>> {
    const r = await this.pool.query<{ source: string; target: string }>(
      "SELECT DISTINCT source_path AS source, target_path AS target FROM vault_links WHERE target_path IS NOT NULL AND source_path IN (SELECT vault_path FROM vault_files WHERE indexed_at > $1)",
      [sinceMs]
    );
    return r.rows;
  }

  async getVaultAlias(vaultPath: string): Promise<{ canonicalPath: string } | null> {
    const r = await this.pool.query<{ canonical_path: string }>(
      "SELECT canonical_path FROM vault_aliases WHERE vault_path = $1",
      [vaultPath]
    );
    return r.rows.length > 0 ? { canonicalPath: r.rows[0].canonical_path } : null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a Buffer of Float32 LE bytes (as stored in SQLite) to number[].
 */
function bufferToVector(buf: Buffer): number[] {
  const floats: number[] = [];
  for (let i = 0; i < buf.length; i += 4) {
    floats.push(buf.readFloatLE(i));
  }
  return floats;
}

/**
 * Convert a free-text query to a Postgres tsquery string.
 *
 * Uses OR (|) semantics so that a chunk matching ANY query term is returned,
 * ranked by ts_rank (which scores higher when more terms match).  AND (&)
 * semantics are too strict for multi-word queries because all terms rarely
 * co-occur in a single chunk.
 *
 * Example: "Synchrotech interview follow-up Gilles"
 *   → "synchrotech | interview | follow | gilles"
 *   → returns chunks containing any of these words, highest-matching first
 */
function buildPgTsQuery(query: string): string {
  const STOP_WORDS = new Set([
    "a", "an", "and", "are", "as", "at", "be", "been", "but", "by",
    "do", "for", "from", "has", "have", "he", "her", "him", "his",
    "how", "i", "if", "in", "is", "it", "its", "me", "my", "not",
    "of", "on", "or", "our", "out", "she", "so", "that", "the",
    "their", "them", "they", "this", "to", "up", "us", "was", "we",
    "were", "what", "when", "who", "will", "with", "you", "your",
  ]);

  const tokens = query
    .toLowerCase()
    .split(/[\s\p{P}]+/u)
    .filter(Boolean)
    .filter((t) => t.length >= 2)
    .filter((t) => !STOP_WORDS.has(t))
    // Sanitize: strip tsquery special characters to prevent syntax errors
    .map((t) => t.replace(/'/g, "''").replace(/[&|!():]/g, ""))
    .filter(Boolean);

  if (tokens.length === 0) {
    // Fallback: sanitize the raw query and use it as a single term
    const raw = query.replace(/[^a-z0-9]/gi, " ").trim().split(/\s+/).filter(Boolean).join(" | ");
    return raw || "";
  }

  // Use OR (|) so that chunks matching ANY term are returned.
  // ts_rank naturally scores chunks higher when more terms match, so the
  // most relevant results still bubble to the top.
  return tokens.join(" | ");
}

// Re-export buildFtsQuery so it is accessible without importing search.ts
export { buildPgTsQuery };
