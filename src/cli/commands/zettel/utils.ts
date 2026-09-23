/** Shared utilities for zettel CLI commands. */

import type { StorageBackend } from "../../../storage/interface.js";
import { getStorageBackend } from "../../../storage/factory.js";
import { err } from "../../utils.js";

/** Shorten a vault path to just the last 2-3 components for display. */
export function shortPath(p: string, parts = 3): string {
  const segments = p.split("/").filter(Boolean);
  return segments.slice(-parts).join("/");
}

/** Get the process-wide StorageBackend (SQLite or Postgres, per config). */
export async function getFedBackend(): Promise<StorageBackend> {
  try {
    return await getStorageBackend();
  } catch (e) {
    console.error(err(`Failed to open PAI storage backend: ${e}`));
    process.exit(1);
  }
}
