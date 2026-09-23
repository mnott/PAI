/**
 * Database connection helper for the PAI registry.
 *
 * Uses better-sqlite3 (synchronous API) to open or create registry.db.
 * On first open it runs the full DDL via initializeSchema().
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { initializeSchema, runMigrations } from "./registry-schema.js";
import { paiHomePath, resolvePaiFile } from "../../config/pai-home.js";

export type { Database };

/** Old registry path, inside the ~/.pai/ directory (pre-2026-09-19). */
export function oldRegistryPath(): string {
  return join(homedir(), ".pai", "registry.db");
}

/** Registry path: PAI_HOME/registry.db if present, else the old
 *  ~/.pai/registry.db (one-time stderr notice), else the new path. */
export function registryDbPath(): string {
  return resolvePaiFile(paiHomePath("registry.db"), [oldRegistryPath()], "pai config migrate --registry");
}

/**
 * Open (or create) the PAI registry database.
 *
 * @param path  Absolute path to registry.db.  Defaults to PAI_HOME/registry.db
 *              (falling back to the pre-2026-09-19 ~/.pai/registry.db).
 * @returns     An open better-sqlite3 Database instance.
 *
 * Side effects on first call:
 *  - Creates the parent directory if it does not exist.
 *  - Enables WAL journal mode.
 *  - Runs initializeSchema() if schema_version is empty.
 */
export function openRegistry(path: string = registryDbPath()): Database {
  // Ensure the directory exists before SQLite tries to create the file
  mkdirSync(dirname(path), { recursive: true });

  const db = new BetterSqlite3(path);

  // WAL gives better concurrent read performance and crash safety
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Check whether the schema has been applied before
  const tableExists = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name = 'schema_version'`
    )
    .get();

  if (!tableExists) {
    // Brand-new database — apply the full schema
    initializeSchema(db);
  } else {
    const row = db
      .prepare("SELECT version FROM schema_version LIMIT 1")
      .get() as { version: number } | undefined;

    if (!row) {
      // Table exists but is empty — apply schema (handles partial init)
      initializeSchema(db);
    }
  }

  // Apply any pending incremental migrations
  runMigrations(db);

  return db;
}
