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
 *  - vault_files       — Obsidian vault file inventory with inode-based dedup
 *  - vault_aliases     — Alternate paths to same inode (dual-symlink handling)
 *  - vault_links       — Directed wikilink graph edges
 *  - vault_name_index  — Obsidian shortest-match resolution lookup
 *  - vault_health      — Per-file health metrics (orphan detection, dead links)
 *
 * Schema version history:
 *  v1 — initial schema (BM25 search only)
 *  v2 — added embedding BLOB column to memory_chunks (Phase 2.5, vector search)
 *  v3 — added vault tables for Zettelkasten file graph (vault_files, vault_aliases,
 *        vault_links, vault_name_index, vault_health)
 */

import type { Database } from "better-sqlite3";

/** Current schema version. Bump when adding new columns or tables. */
export const SCHEMA_VERSION = 3;

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

-- Vault file inventory with inode dedup
CREATE TABLE IF NOT EXISTS vault_files (
  vault_path  TEXT PRIMARY KEY,
  inode       INTEGER NOT NULL,
  device      INTEGER NOT NULL,
  hash        TEXT NOT NULL,
  title       TEXT,
  indexed_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vf_inode ON vault_files(inode, device);

-- Alternate paths to same inode (dual-symlink handling)
CREATE TABLE IF NOT EXISTS vault_aliases (
  vault_path     TEXT PRIMARY KEY,
  canonical_path TEXT NOT NULL,
  inode          INTEGER NOT NULL,
  device         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_va_canonical ON vault_aliases(canonical_path);

-- Wikilink graph: directed edges
CREATE TABLE IF NOT EXISTS vault_links (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source_path TEXT NOT NULL,
  target_raw  TEXT NOT NULL,
  target_path TEXT,
  link_type   TEXT NOT NULL DEFAULT 'wikilink',
  line_number INTEGER NOT NULL DEFAULT 0,
  UNIQUE(source_path, target_raw, line_number)
);
CREATE INDEX IF NOT EXISTS idx_vl_source ON vault_links(source_path);
CREATE INDEX IF NOT EXISTS idx_vl_target ON vault_links(target_path);
CREATE INDEX IF NOT EXISTS idx_vl_dead ON vault_links(target_path) WHERE target_path IS NULL;

-- Obsidian shortest-match resolution lookup
CREATE TABLE IF NOT EXISTS vault_name_index (
  name       TEXT NOT NULL,
  vault_path TEXT NOT NULL,
  PRIMARY KEY (name, vault_path)
);
CREATE INDEX IF NOT EXISTS idx_vni_name ON vault_name_index(name);

-- Per-file health metrics
CREATE TABLE IF NOT EXISTS vault_health (
  vault_path      TEXT PRIMARY KEY,
  inbound_count   INTEGER NOT NULL DEFAULT 0,
  outbound_count  INTEGER NOT NULL DEFAULT 0,
  dead_link_count INTEGER NOT NULL DEFAULT 0,
  is_orphan       INTEGER NOT NULL DEFAULT 0,
  computed_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vh_orphan ON vault_health(is_orphan) WHERE is_orphan = 1;
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

  // Migration v2 -> v3: add vault tables if vault_files does not yet exist.
  // All vault table DDL uses CREATE TABLE/INDEX IF NOT EXISTS, so this is idempotent.
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='vault_files'",
  ).all() as Array<{ name: string }>;
  if (tables.length === 0) {
    db.exec(`
CREATE TABLE IF NOT EXISTS vault_files (
  vault_path  TEXT PRIMARY KEY,
  inode       INTEGER NOT NULL,
  device      INTEGER NOT NULL,
  hash        TEXT NOT NULL,
  title       TEXT,
  indexed_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vf_inode ON vault_files(inode, device);

CREATE TABLE IF NOT EXISTS vault_aliases (
  vault_path     TEXT PRIMARY KEY,
  canonical_path TEXT NOT NULL,
  inode          INTEGER NOT NULL,
  device         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_va_canonical ON vault_aliases(canonical_path);

CREATE TABLE IF NOT EXISTS vault_links (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source_path TEXT NOT NULL,
  target_raw  TEXT NOT NULL,
  target_path TEXT,
  link_type   TEXT NOT NULL DEFAULT 'wikilink',
  line_number INTEGER NOT NULL DEFAULT 0,
  UNIQUE(source_path, target_raw, line_number)
);
CREATE INDEX IF NOT EXISTS idx_vl_source ON vault_links(source_path);
CREATE INDEX IF NOT EXISTS idx_vl_target ON vault_links(target_path);
CREATE INDEX IF NOT EXISTS idx_vl_dead ON vault_links(target_path) WHERE target_path IS NULL;

CREATE TABLE IF NOT EXISTS vault_name_index (
  name       TEXT NOT NULL,
  vault_path TEXT NOT NULL,
  PRIMARY KEY (name, vault_path)
);
CREATE INDEX IF NOT EXISTS idx_vni_name ON vault_name_index(name);

CREATE TABLE IF NOT EXISTS vault_health (
  vault_path      TEXT PRIMARY KEY,
  inbound_count   INTEGER NOT NULL DEFAULT 0,
  outbound_count  INTEGER NOT NULL DEFAULT 0,
  dead_link_count INTEGER NOT NULL DEFAULT 0,
  is_orphan       INTEGER NOT NULL DEFAULT 0,
  computed_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vh_orphan ON vault_health(is_orphan) WHERE is_orphan = 1;
`);
  }
}
