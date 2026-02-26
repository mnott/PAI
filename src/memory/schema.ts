/**
 * SQLite DDL for the PAI federation database (federation.db).
 *
 * The federation DB is the cross-project search index — a single SQLite file
 * at ~/.pai/federation.db that holds chunked text from every registered
 * project's memory/ and Notes/ directories.
 *
 * Tables:
 *  - memory_files   — file-level metadata (hash, mtime, size) for change detection
 *  - memory_chunks  — chunked text with line numbers, tier classification, and optional embedding
 *  - memory_fts     — FTS5 virtual table backed by memory_chunks text
 *
 * Schema version history:
 *  v1 — initial schema (BM25 search only)
 *  v2 — added embedding BLOB column to memory_chunks (Phase 2.5, vector search)
 */

import type { Database } from "better-sqlite3";

/** Current schema version. Bump when adding new columns or tables. */
export const SCHEMA_VERSION = 2;

export const FEDERATION_SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS memory_files (
  project_id   INTEGER NOT NULL,
  path         TEXT    NOT NULL,
  source       TEXT    NOT NULL DEFAULT 'memory',
  tier         TEXT    NOT NULL DEFAULT 'topic',
  hash         TEXT    NOT NULL,
  mtime        INTEGER NOT NULL,
  size         INTEGER NOT NULL,
  PRIMARY KEY (project_id, path)
);

CREATE TABLE IF NOT EXISTS memory_chunks (
  id           TEXT    PRIMARY KEY,
  project_id   INTEGER NOT NULL,
  source       TEXT    NOT NULL DEFAULT 'memory',
  tier         TEXT    NOT NULL DEFAULT 'topic',
  path         TEXT    NOT NULL,
  start_line   INTEGER NOT NULL,
  end_line     INTEGER NOT NULL,
  hash         TEXT    NOT NULL,
  text         TEXT    NOT NULL,
  updated_at   INTEGER NOT NULL,
  embedding    BLOB
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  text,
  id UNINDEXED,
  project_id UNINDEXED,
  path UNINDEXED,
  source UNINDEXED,
  tier UNINDEXED,
  start_line UNINDEXED,
  end_line UNINDEXED
);

CREATE INDEX IF NOT EXISTS idx_mc_project ON memory_chunks(project_id);
CREATE INDEX IF NOT EXISTS idx_mc_source  ON memory_chunks(project_id, source);
CREATE INDEX IF NOT EXISTS idx_mc_tier    ON memory_chunks(tier);
CREATE INDEX IF NOT EXISTS idx_mf_project ON memory_files(project_id);
`;

/**
 * Apply the full federation schema to an open database.
 *
 * Idempotent — all statements use IF NOT EXISTS so calling this on an
 * already-initialised database is safe.
 *
 * Also runs any necessary migrations for existing databases (e.g. adding the
 * embedding column to an older schema that was created without it).
 */
export function initializeFederationSchema(db: Database): void {
  db.exec(FEDERATION_SCHEMA_SQL);
  runMigrations(db);
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

/**
 * Apply incremental migrations to an existing database.
 *
 * Each migration is idempotent — safe to call on a database that has already
 * been migrated.
 */
function runMigrations(db: Database): void {
  // Migration: add embedding BLOB column if it does not already exist.
  // This handles databases created before Phase 2.5 (schema v1).
  const columns = db.prepare("PRAGMA table_info(memory_chunks)").all() as Array<{
    name: string;
  }>;
  const hasEmbedding = columns.some((c) => c.name === "embedding");
  if (!hasEmbedding) {
    db.exec("ALTER TABLE memory_chunks ADD COLUMN embedding BLOB");
  }

  // Create the partial index for embedded chunks (safe now that the column exists)
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_mc_embedding ON memory_chunks(id) WHERE embedding IS NOT NULL",
  );
}
