/**
 * Postgres DDL for the code knowledge graph, run as an incremental migration
 * from PostgresBackend.runMigrations() (the same place kg_triples and the
 * registry tables are created for existing databases). docker/init.sql is
 * deliberately NOT touched: new databases get these tables through this
 * migration too, since ensureDatabase() always runs it.
 *
 * Mirrors the SQLite schema (schema-sqlite.ts): repo_root-scoped rows so many
 * repos share one set of tables; full-text search on a generated tsvector over
 * code_symbols.search_text (sub-word expanded identifier text, see fts.ts)
 * with a GIN index — the same 'simple' config the memory chunks use.
 */

import type { Pool } from "pg";

export const CODEGRAPH_POSTGRES_SQL = `
CREATE TABLE IF NOT EXISTS code_files (
  id           SERIAL PRIMARY KEY,
  repo_root    TEXT NOT NULL,
  path         TEXT NOT NULL,
  language     TEXT NOT NULL DEFAULT 'unknown',
  content_hash TEXT NOT NULL,
  mtime        BIGINT NOT NULL,
  size         INTEGER NOT NULL,
  indexed_at   BIGINT NOT NULL,
  UNIQUE (repo_root, path)
);

CREATE TABLE IF NOT EXISTS code_symbols (
  id             SERIAL PRIMARY KEY,
  repo_root      TEXT NOT NULL,
  file_id        INTEGER NOT NULL REFERENCES code_files(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  kind           TEXT NOT NULL,
  start_line     INTEGER NOT NULL,
  end_line       INTEGER NOT NULL,
  signature      TEXT NOT NULL DEFAULT '',
  exported       BOOLEAN NOT NULL DEFAULT FALSE,
  search_text    TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS code_refs (
  id             SERIAL PRIMARY KEY,
  repo_root      TEXT NOT NULL,
  from_file_id   INTEGER NOT NULL REFERENCES code_files(id) ON DELETE CASCADE,
  from_symbol_id INTEGER REFERENCES code_symbols(id) ON DELETE CASCADE,
  to_name        TEXT NOT NULL,
  to_symbol_id   INTEGER REFERENCES code_symbols(id) ON DELETE SET NULL,
  kind           TEXT NOT NULL,
  line           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_code_files_root    ON code_files (repo_root);
CREATE INDEX IF NOT EXISTS idx_code_symbols_file  ON code_symbols (file_id);
CREATE INDEX IF NOT EXISTS idx_code_symbols_name  ON code_symbols (repo_root, name);
CREATE INDEX IF NOT EXISTS idx_code_refs_from     ON code_refs (from_file_id);
CREATE INDEX IF NOT EXISTS idx_code_refs_toname   ON code_refs (repo_root, to_name);
CREATE INDEX IF NOT EXISTS idx_code_refs_tosym    ON code_refs (to_symbol_id);

-- ADD COLUMN IF NOT EXISTS needs PG 12+; a generated column is added only to a
-- fresh/empty table here, and an existing one predates this migration entirely.
-- Generated column keeps the tsvector in sync on every insert/update, like the
-- pai_chunks trigger does for text; 'simple' config, same as memory search.
ALTER TABLE code_symbols
  ADD COLUMN IF NOT EXISTS fts_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', search_text)) STORED;
CREATE INDEX IF NOT EXISTS idx_code_symbols_fts ON code_symbols USING GIN (fts_vector);
`;

/** Apply the code-graph schema to a Postgres database. Idempotent. */
export async function ensureCodeGraphSchemaPostgres(pool: Pool): Promise<void> {
  await pool.query(CODEGRAPH_POSTGRES_SQL);
}
