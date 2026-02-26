#!/usr/bin/env -S node --input-type=module
/**
 * migrate-sqlite.ts — Migrate PAI SQLite federation data to PostgreSQL/pgvector
 *
 * Reads existing ~/.pai/federation.db and inserts all data into Postgres.
 * Handles vector embeddings: stored as Float32 LE blobs in SQLite → pgvector format.
 * Idempotent: uses UPSERT so it can be safely re-run.
 *
 * Usage:
 *   bun docker/migrate-sqlite.ts [--connection-string <url>]
 *   bun docker/migrate-sqlite.ts --connection-string "postgresql://pai:pai@localhost:5432/pai"
 *
 * The connection string defaults to the value in ~/.config/pai/config.json,
 * or "postgresql://pai:pai@localhost:5432/pai" if not configured.
 */

import BetterSqlite3 from "better-sqlite3";
import pg from "pg";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";

const { Pool } = pg;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let connectionString = "postgresql://pai:pai@localhost:5432/pai";

// Try loading from config first
const configPath = join(homedir(), ".config", "pai", "config.json");
if (existsSync(configPath)) {
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    const pg = config["postgres"] as Record<string, unknown> | undefined;
    if (pg?.connectionString) connectionString = pg.connectionString as string;
    else if (pg?.host) {
      connectionString = `postgresql://${pg.user ?? "pai"}:${pg.password ?? "pai"}@${pg.host ?? "localhost"}:${pg.port ?? 5432}/${pg.database ?? "pai"}`;
    }
  } catch { /* use default */ }
}

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--connection-string" && args[i + 1]) {
    connectionString = args[++i]!;
  }
}

// ---------------------------------------------------------------------------
// SQLite path
// ---------------------------------------------------------------------------

const FEDERATION_PATH = join(homedir(), ".pai", "federation.db");

if (!existsSync(FEDERATION_PATH)) {
  console.error(`federation.db not found at ${FEDERATION_PATH}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SqliteFileRow {
  project_id: number;
  path: string;
  source: string;
  tier: string;
  hash: string;
  mtime: number;
  size: number;
}

interface SqliteChunkRow {
  id: string;
  project_id: number;
  source: string;
  tier: string;
  path: string;
  start_line: number;
  end_line: number;
  hash: string;
  text: string;
  updated_at: number;
  embedding: Buffer | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a Float32 LE binary blob (as stored in SQLite) to a pgvector literal.
 * Returns null if the buffer is empty or malformed.
 */
function blobToVector(buf: Buffer | null): string | null {
  if (!buf || buf.length === 0) return null;
  if (buf.length % 4 !== 0) return null;

  const floats: number[] = [];
  for (let i = 0; i < buf.length; i += 4) {
    floats.push(buf.readFloatLE(i));
  }
  return "[" + floats.join(",") + "]";
}

/** Strip null bytes — Postgres text columns reject \0 */
function sanitize(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/\0/g, "");
}

function progress(current: number, total: number, label: string): void {
  const pct = Math.round((current / total) * 100);
  process.stdout.write(`\r  ${label}: ${current}/${total} (${pct}%)   `);
}

// ---------------------------------------------------------------------------
// Main migration
// ---------------------------------------------------------------------------

async function migrate(): Promise<void> {
  console.log();
  console.log("PAI SQLite → PostgreSQL Migration");
  console.log("===================================");
  console.log(`Source:      ${FEDERATION_PATH}`);
  console.log(`Destination: ${connectionString}`);
  console.log();

  // Open SQLite
  const sqlite = new BetterSqlite3(FEDERATION_PATH, { readonly: true });

  // Open Postgres
  const pool = new Pool({ connectionString, max: 3, connectionTimeoutMillis: 10_000 });

  // Test connection
  try {
    const client = await pool.connect();
    await client.query("SELECT 1");
    client.release();
    console.log("Postgres connection: OK");
  } catch (e) {
    console.error(`Postgres connection failed: ${e}`);
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // Migrate memory_files → pai_files
  // ---------------------------------------------------------------------------

  const files = sqlite
    .prepare("SELECT * FROM memory_files")
    .all() as SqliteFileRow[];

  console.log(`\nMigrating ${files.length} file records...`);

  const FILE_BATCH = 500;
  let filesDone = 0;

  for (let i = 0; i < files.length; i += FILE_BATCH) {
    const batch = files.slice(i, i + FILE_BATCH);
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      for (const f of batch) {
        await client.query(
          `INSERT INTO pai_files (project_id, path, source, tier, hash, mtime, size)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (project_id, path) DO UPDATE SET
             source = EXCLUDED.source,
             tier   = EXCLUDED.tier,
             hash   = EXCLUDED.hash,
             mtime  = EXCLUDED.mtime,
             size   = EXCLUDED.size`,
          [f.project_id, sanitize(f.path), sanitize(f.source), sanitize(f.tier), sanitize(f.hash), f.mtime, f.size]
        );
      }
      await client.query("COMMIT");
      filesDone += batch.length;
      progress(filesDone, files.length, "Files");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  console.log(`\n  Done: ${filesDone} file records migrated.`);

  // ---------------------------------------------------------------------------
  // Migrate memory_chunks → pai_chunks
  // ---------------------------------------------------------------------------

  const totalChunks = (
    sqlite.prepare("SELECT COUNT(*) AS n FROM memory_chunks").get() as { n: number }
  ).n;

  console.log(`\nMigrating ${totalChunks} chunks (with embeddings where available)...`);

  const CHUNK_BATCH = 200;
  let chunksDone = 0;
  let embeddingsMigrated = 0;
  let offset = 0;

  while (offset < totalChunks) {
    const batch = sqlite
      .prepare("SELECT * FROM memory_chunks ORDER BY id LIMIT ? OFFSET ?")
      .all(CHUNK_BATCH, offset) as SqliteChunkRow[];

    if (batch.length === 0) break;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      for (const c of batch) {
        const vecStr = blobToVector(c.embedding);
        if (vecStr) embeddingsMigrated++;

        await client.query(
          `INSERT INTO pai_chunks
             (id, project_id, source, tier, path, start_line, end_line, hash, text, updated_at, embedding, fts_vector)
           VALUES
             ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
              $11::vector,
              to_tsvector('english', $9))
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
             embedding  = EXCLUDED.embedding,
             fts_vector = EXCLUDED.fts_vector`,
          [
            sanitize(c.id),
            c.project_id,
            sanitize(c.source),
            sanitize(c.tier),
            sanitize(c.path),
            c.start_line,
            c.end_line,
            sanitize(c.hash),
            sanitize(c.text),
            c.updated_at,
            vecStr,  // null if no embedding
          ]
        );
      }

      await client.query("COMMIT");
      chunksDone += batch.length;
      offset += batch.length;
      progress(chunksDone, totalChunks, "Chunks");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  console.log(`\n  Done: ${chunksDone} chunks migrated (${embeddingsMigrated} with embeddings).`);

  // ---------------------------------------------------------------------------
  // Final stats
  // ---------------------------------------------------------------------------

  const statsResult = await pool.query<{
    total_files: string;
    total_chunks: string;
    embedded_chunks: string;
    projects_indexed: string;
  }>("SELECT * FROM pai_stats");

  const stats = statsResult.rows[0];
  console.log();
  console.log("Migration complete. Postgres stats:");
  console.log(`  Files:             ${stats?.total_files}`);
  console.log(`  Chunks:            ${stats?.total_chunks}`);
  console.log(`  With embeddings:   ${stats?.embedded_chunks}`);
  console.log(`  Projects indexed:  ${stats?.projects_indexed}`);
  console.log();
  console.log("To activate Postgres backend, update ~/.config/pai/config.json:");
  console.log('  "storageBackend": "postgres"');
  console.log();

  sqlite.close();
  await pool.end();
}

migrate().catch((e) => {
  console.error(`\nMigration failed: ${e}`);
  process.exit(1);
});
