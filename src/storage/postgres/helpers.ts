/**
 * Internal helper utilities for the Postgres storage backend.
 */

import { STOP_WORDS } from "../../utils/stop-words.js";

/**
 * Convert a Buffer of Float32 LE bytes (as stored in SQLite) to number[].
 */
export function bufferToVector(buf: Buffer): number[] {
  const floats: number[] = [];
  for (let i = 0; i < buf.length; i += 4) {
    floats.push(buf.readFloatLE(i));
  }
  return floats;
}

/**
 * Convert a free-text query to a Postgres tsquery string.
 *
 * Uses OR (|) semantics so that a chunk matching ANY query term is returned,
 * ranked by ts_rank (which scores higher when more terms match). AND (&)
 * semantics are too strict for multi-word queries because all terms rarely
 * co-occur in a single chunk.
 *
 * Example: "Synchrotech interview follow-up Gilles"
 *   → "synchrotech | interview | follow | gilles"
 */
export function buildPgTsQuery(query: string): string {
  const tokens = query
    .toLowerCase()
    .split(/[\s\p{P}]+/u)
    .filter(Boolean)
    .filter((t) => t.length >= 2)
    .filter((t) => !STOP_WORDS.has(t))
    // Sanitize: strip tsquery special characters to prevent syntax errors
    .map((t) => t.replace(/'/g, "''").replace(/[&|!():]/g, ""))
    .filter(Boolean);

  if (tokens.length === 0) {
    const raw = query.replace(/[^a-z0-9]/gi, " ").trim().split(/\s+/).filter(Boolean).join(" | ");
    return raw || "";
  }

  return tokens.join(" | ");
}
