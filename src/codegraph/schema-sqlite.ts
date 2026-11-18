/**
 * SQLite DDL for the code knowledge graph (code_files / code_symbols /
 * code_refs + FTS5), living in the same federation.db as the memory tables.
 *
 * Everything is scoped by repo_root so many repos share one set of tables.
 * Symbol full-text search uses an external-content FTS5 table over
 * code_symbols.search_text (the sub-word expanded identifier text built by
 * src/codegraph/fts.ts); AFTER insert/update/delete triggers keep it in sync
 * (created in store-sqlite.ts ensure()).
 *
 * Deleting a file cascades: symbols ON DELETE CASCADE from code_files, refs
 * from both sides (a ref whose target symbol is deleted keeps the row with
 * to_symbol_id NULL'd, so bare unresolved names survive re-extraction).
 */

export const CODEGRAPH_SQLITE_SQL = `
CREATE TABLE IF NOT EXISTS code_files (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_root    TEXT NOT NULL,
  path         TEXT NOT NULL,
  language     TEXT NOT NULL DEFAULT 'unknown',
  content_hash TEXT NOT NULL,
  mtime        INTEGER NOT NULL,
  size         INTEGER NOT NULL,
  indexed_at   INTEGER NOT NULL,
  UNIQUE (repo_root, path)
);

CREATE TABLE IF NOT EXISTS code_symbols (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_root      TEXT NOT NULL,
  file_id        INTEGER NOT NULL REFERENCES code_files(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  kind           TEXT NOT NULL,
  start_line     INTEGER NOT NULL,
  end_line       INTEGER NOT NULL,
  signature      TEXT NOT NULL DEFAULT '',
  exported       INTEGER NOT NULL DEFAULT 0,
  search_text    TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS code_refs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_root      TEXT NOT NULL,
  from_file_id   INTEGER NOT NULL REFERENCES code_files(id) ON DELETE CASCADE,
  from_symbol_id INTEGER REFERENCES code_symbols(id) ON DELETE CASCADE,
  to_name        TEXT NOT NULL,
  to_symbol_id   INTEGER REFERENCES code_symbols(id) ON DELETE SET NULL,
  kind           TEXT NOT NULL,
  line           INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS code_symbols_fts USING fts5(
  search_text,
  content='code_symbols',
  content_rowid='id',
  tokenize="unicode61 remove_diacritics 2"
);

-- The FTS sync triggers are created by store-sqlite.ts ensure() with explicit
-- sqlite_master guards: CREATE TRIGGER ... IF NOT EXISTS cannot run inside a
-- multi-statement db.exec() through better-sqlite3's statement splitter.

CREATE INDEX IF NOT EXISTS idx_code_files_root ON code_files(repo_root);
CREATE INDEX IF NOT EXISTS idx_code_symbols_file ON code_symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_code_symbols_name ON code_symbols(repo_root, name);
CREATE INDEX IF NOT EXISTS idx_code_refs_from ON code_refs(from_file_id);
CREATE INDEX IF NOT EXISTS idx_code_refs_toname ON code_refs(repo_root, to_name);
CREATE INDEX IF NOT EXISTS idx_code_refs_tosym ON code_refs(to_symbol_id);
`;

export const CODE_SUMMARIES_SQLITE_SQL = `
CREATE TABLE IF NOT EXISTS code_summaries (
  repo_root    TEXT NOT NULL,
  key          TEXT NOT NULL,
  kind         TEXT NOT NULL,
  path         TEXT NOT NULL,
  summary      TEXT NOT NULL,
  model        TEXT NOT NULL,
  source_hash  TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  PRIMARY KEY (repo_root, key)
);
`;
