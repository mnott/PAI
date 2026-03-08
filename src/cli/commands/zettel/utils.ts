/** Shared utilities for zettel CLI commands. */

import type { Database } from "better-sqlite3";
import { openFederation } from "../../../memory/db.js";
import { err } from "../../utils.js";

/** Shorten a vault path to just the last 2-3 components for display. */
export function shortPath(p: string, parts = 3): string {
  const segments = p.split("/").filter(Boolean);
  return segments.slice(-parts).join("/");
}

// Lazy-loaded federation DB singleton
let _fedDb: Database | null = null;

/** Get (or lazily open) the PAI federation database. */
export function getFedDb(): Database {
  if (!_fedDb) {
    try {
      _fedDb = openFederation();
    } catch (e) {
      console.error(err(`Failed to open PAI federation DB: ${e}`));
      process.exit(1);
    }
  }
  return _fedDb;
}
