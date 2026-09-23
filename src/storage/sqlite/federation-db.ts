/**
 * Database connection helper for the PAI federation DB.
 *
 * Uses better-sqlite3 (synchronous API) to open or create federation.db.
 * On first open it runs the full DDL via initializeFederationSchema().
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { initializeFederationSchema } from "./federation-schema.js";
import { paiHomePath, resolvePaiFile } from "../../config/pai-home.js";

export type { Database };

/** Old federation.db path, inside the ~/.pai/ directory (pre-2026-09-19). */
export function oldFederationPath(): string {
  return join(homedir(), ".pai", "federation.db");
}

/** Federation DB path: PAI_HOME/federation.db if present, else the old
 *  ~/.pai/federation.db (one-time stderr notice), else the new path. */
export function federationDbPath(): string {
  return resolvePaiFile(paiHomePath("federation.db"), [oldFederationPath()], "pai config migrate --federation");
}

/**
 * Open (or create) the PAI federation database.
 *
 * @param path  Absolute path to federation.db.  Defaults to PAI_HOME/federation.db
 *              (falling back to the pre-2026-09-19 ~/.pai/federation.db).
 * @returns     An open better-sqlite3 Database instance.
 *
 * Side effects on first call:
 *  - Creates the parent directory if it does not exist.
 *  - Enables WAL journal mode.
 *  - Runs initializeFederationSchema() to ensure tables exist.
 */
export function openFederation(path: string = federationDbPath()): Database {
  // Ensure the directory exists before SQLite tries to create the file
  mkdirSync(dirname(path), { recursive: true });

  const db = new BetterSqlite3(path);

  // WAL gives better concurrent read performance and crash safety
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Apply schema (idempotent — all statements use IF NOT EXISTS)
  initializeFederationSchema(db);

  return db;
}
