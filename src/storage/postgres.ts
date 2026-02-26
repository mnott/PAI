/**
 * PostgresBackend — implements StorageBackend using PostgreSQL + pgvector.
 *
 * Vector similarity: pgvector's <=> cosine distance operator
 * Full-text search:  PostgreSQL tsvector/tsquery (replaces SQLite FTS5)
 * Connection pooling: node-postgres Pool
 *
 * Schema is initialized via docker/init.sql.
 * This module only handles runtime queries — schema creation is external.
 */

import pg from "pg";
import type { Pool, PoolClient } from "pg";
import type { StorageBackend, ChunkRow, FileRow, FederationStats } from "./interface.js";
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
            c.text,
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

  async getUnembeddedChunkIds(projectId?: number): Promise<Array<{ id: string; text: string }>> {
    if (projectId !== undefined) {
      const result = await this.pool.query<{ id: string; text: string }>(
        "SELECT id, text FROM pai_chunks WHERE embedding IS NULL AND project_id = $1 ORDER BY id",
        [projectId]
      );
      return result.rows;
    }
    const result = await this.pool.query<{ id: string; text: string }>(
      "SELECT id, text FROM pai_chunks WHERE embedding IS NULL ORDER BY id"
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
