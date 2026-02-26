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
import { initializeFederationSchema } from "./schema.js";

export type { Database };

/** Default federation DB path inside the ~/.pai/ directory. */
const DEFAULT_FEDERATION_PATH = join(homedir(), ".pai", "federation.db");

/**
 * Open (or create) the PAI federation database.
 *
 * @param path  Absolute path to federation.db.  Defaults to ~/.pai/federation.db.
 * @returns     An open better-sqlite3 Database instance.
 *
 * Side effects on first call:
 *  - Creates the parent directory if it does not exist.
 *  - Enables WAL journal mode.
 *  - Runs initializeFederationSchema() to ensure tables exist.
 */
export function openFederation(path: string = DEFAULT_FEDERATION_PATH): Database {
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
