/**
 * SQLite DDL for the PAI registry database.
 *
 * Tables:
 *  - projects        — tracked project directories with type and status
 *  - sessions        — per-project session notes
 *  - tags            — normalised tag vocabulary
 *  - project_tags    — M:N join between projects and tags
 *  - session_tags    — M:N join between sessions and tags
 *  - aliases         — alternative slugs that resolve to a project
 *  - compaction_log  — audit trail for context-compaction events
 *  - schema_version  — single-row migration version tracking
 */

import type { Database } from "better-sqlite3";

export const SCHEMA_VERSION = 3;

export const CREATE_TABLES_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT    NOT NULL UNIQUE,
  display_name  TEXT    NOT NULL,
  root_path     TEXT    NOT NULL UNIQUE,
  encoded_dir   TEXT    NOT NULL UNIQUE,
  type          TEXT    NOT NULL DEFAULT 'local'
                        CHECK(type IN ('local','central','obsidian-linked','external')),
  status        TEXT    NOT NULL DEFAULT 'active'
                        CHECK(status IN ('active','archived','migrating')),
  parent_id       INTEGER,
  obsidian_link   TEXT,
  claude_notes_dir TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  archived_at     INTEGER,
  FOREIGN KEY (parent_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id        INTEGER NOT NULL,
  number            INTEGER NOT NULL,
  date              TEXT    NOT NULL,
  slug              TEXT    NOT NULL,
  title             TEXT    NOT NULL,
  filename          TEXT    NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'open'
                            CHECK(status IN ('open','completed','compacted')),
  claude_session_id TEXT,
  token_count       INTEGER,
  created_at        INTEGER NOT NULL,
  closed_at         INTEGER,
  UNIQUE (project_id, number),
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS tags (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT    NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS project_tags (
  project_id INTEGER NOT NULL,
  tag_id     INTEGER NOT NULL,
  PRIMARY KEY (project_id, tag_id),
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (tag_id)     REFERENCES tags(id)
);

CREATE TABLE IF NOT EXISTS session_tags (
  session_id INTEGER NOT NULL,
  tag_id     INTEGER NOT NULL,
  PRIMARY KEY (session_id, tag_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  FOREIGN KEY (tag_id)     REFERENCES tags(id)
);

CREATE TABLE IF NOT EXISTS aliases (
  alias      TEXT    PRIMARY KEY,
  project_id INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS compaction_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL,
  session_id    INTEGER,
  trigger       TEXT    NOT NULL
                        CHECK(trigger IN ('precompact','manual','end-session')),
  files_written TEXT    NOT NULL,
  token_count   INTEGER,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS links (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id       INTEGER NOT NULL,
  target_project_id INTEGER NOT NULL,
  link_type        TEXT    NOT NULL DEFAULT 'related'
                           CHECK(link_type IN ('related','follow-up','reference')),
  created_at       INTEGER NOT NULL,
  UNIQUE (session_id, target_project_id),
  FOREIGN KEY (session_id)        REFERENCES sessions(id),
  FOREIGN KEY (target_project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_projects_slug    ON projects(slug);
CREATE INDEX IF NOT EXISTS idx_projects_status  ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_type    ON projects(type);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_date    ON sessions(date);
CREATE INDEX IF NOT EXISTS idx_sessions_status  ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_claude  ON sessions(claude_session_id);
CREATE INDEX IF NOT EXISTS idx_pc_project       ON project_tags(project_id);
`;

/**
 * Run the full DDL against an open database connection.
 *
 * The function is idempotent — every statement uses IF NOT EXISTS so it is
 * safe to call on an already-initialised database.  After creating the tables
 * it inserts the current SCHEMA_VERSION into schema_version if no row exists
 * yet.
 */
export function initializeSchema(db: Database): void {
  // better-sqlite3's exec() runs multiple semicolon-separated statements
  db.exec(CREATE_TABLES_SQL);

  const row = db
    .prepare("SELECT version FROM schema_version WHERE version = ?")
    .get(SCHEMA_VERSION);

  if (!row) {
    db.prepare(
      "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)"
    ).run(SCHEMA_VERSION, Date.now());
  }
}

/**
 * Apply incremental schema migrations to an already-initialised database.
 *
 * Each migration is guarded by a version check so it is safe to call on
 * databases at any schema version — already-applied migrations are skipped.
 */
export function runMigrations(db: Database): void {
  const currentRow = db
    .prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1")
    .get() as { version: number } | undefined;

  const current = currentRow?.version ?? 0;

  // Migration v1 → v2: add claude_notes_dir column to projects
  if (current < 2) {
    db.transaction(() => {
      // Use a try/catch so re-running on a DB that already has the column is safe
      try {
        db.exec("ALTER TABLE projects ADD COLUMN claude_notes_dir TEXT");
      } catch {
        // Column may already exist (e.g. fresh DB created with v2 DDL)
      }
      db.prepare(
        "INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)"
      ).run(2, Date.now());
    })();
  }

  // Migration v2 → v3: add links table for cross-project session references
  if (current < 3) {
    db.transaction(() => {
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS links (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id       INTEGER NOT NULL,
            target_project_id INTEGER NOT NULL,
            link_type        TEXT    NOT NULL DEFAULT 'related'
                                     CHECK(link_type IN ('related','follow-up','reference')),
            created_at       INTEGER NOT NULL,
            UNIQUE (session_id, target_project_id),
            FOREIGN KEY (session_id)        REFERENCES sessions(id),
            FOREIGN KEY (target_project_id) REFERENCES projects(id)
          )
        `);
      } catch {
        // Table may already exist (fresh DB created with v3 DDL)
      }
      db.prepare(
        "INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)"
      ).run(3, Date.now());
    })();
  }
}
