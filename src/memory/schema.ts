/**
 * SQLite DDL for the PAI federation database (federation.db).
 *
 * The federation DB is the cross-project search index — a single SQLite file
 * at ~/.pai/federation.db that holds chunked text from every registered
 * project's memory/ and Notes/ directories.
 *
 * Tables:
 *  - memory_files      — file-level metadata (hash, mtime, size) for change detection
 *  - memory_chunks     — chunked text with line numbers, tier classification, and optional embedding
 *  - memory_fts        — FTS5 virtual table backed by memory_chunks text
 *
 * Vault tables (vault_files, vault_aliases, vault_links, vault_name_index, vault_health)
 * have been migrated to Postgres (docker/init.sql) and are no longer created here.
 *
 * Schema version history:
 *  v1 — initial schema (BM25 search only)
 *  v2 — added embedding BLOB column to memory_chunks (Phase 2.5, vector search)
 *  v3 — added vault tables (now removed — vault tables live in Postgres)
 */

import type { Database } from "better-sqlite3";

/** Current schema version. Bump when adding new columns or tables. */
export const SCHEMA_VERSION = 5;

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
  id               TEXT    PRIMARY KEY,
  project_id       INTEGER NOT NULL,
  source           TEXT    NOT NULL DEFAULT 'memory',
  tier             TEXT    NOT NULL DEFAULT 'topic',
  path             TEXT    NOT NULL,
  start_line       INTEGER NOT NULL,
  end_line         INTEGER NOT NULL,
  hash             TEXT    NOT NULL,
  text             TEXT    NOT NULL,
  updated_at       INTEGER NOT NULL,
  last_accessed_at INTEGER,
  relevance_score  REAL    DEFAULT 0.5,
  embedding        BLOB
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

CREATE TABLE IF NOT EXISTS kg_entities (
  entity_id       TEXT    PRIMARY KEY,
  tenant_id       TEXT    NOT NULL DEFAULT 'default',
  name            TEXT    NOT NULL,
  type            TEXT    NOT NULL DEFAULT 'unknown',
  description     TEXT,
  first_seen      INTEGER,
  last_seen       INTEGER,
  mention_count   INTEGER NOT NULL DEFAULT 1,
  feedback_weight REAL    NOT NULL DEFAULT 0.5,
  UNIQUE(tenant_id, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_kge_tenant    ON kg_entities(tenant_id);
CREATE INDEX IF NOT EXISTS idx_kge_name      ON kg_entities(tenant_id, name);
CREATE INDEX IF NOT EXISTS idx_kge_type      ON kg_entities(tenant_id, type);
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
  const columns = db.prepare("PRAGMA table_info(memory_chunks)").all() as Array<{
    name: string;
  }>;

  // Migration v1→v2: add embedding BLOB column (schema v2, Phase 2.5)
  const hasEmbedding = columns.some((c) => c.name === "embedding");
  if (!hasEmbedding) {
    db.exec("ALTER TABLE memory_chunks ADD COLUMN embedding BLOB");
  }

  // Create the partial index for embedded chunks (safe now that the column exists)
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_mc_embedding ON memory_chunks(id) WHERE embedding IS NOT NULL",
  );

  // Migration v4→v5: add last_accessed_at and relevance_score columns (QW2 + MR2)
  const hasLastAccessedAt = columns.some((c) => c.name === "last_accessed_at");
  if (!hasLastAccessedAt) {
    db.exec("ALTER TABLE memory_chunks ADD COLUMN last_accessed_at INTEGER");
  }

  const hasRelevanceScore = columns.some((c) => c.name === "relevance_score");
  if (!hasRelevanceScore) {
    db.exec("ALTER TABLE memory_chunks ADD COLUMN relevance_score REAL DEFAULT 0.5");
  }
}
