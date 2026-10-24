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

/** Float32 LE bytes of a vector. */
export function vectorToBuffer(vec: number[]): Buffer {
  const f = Float32Array.from(vec);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

/**
 * Convert a free-text query to a Postgres tsquery string.
 *
 * Uses OR (|) semantics so that a chunk matching ANY query term is returned,
 * ranked by ts_rank (which scores higher when more terms match). AND (&)
 * semantics are too strict for multi-word queries because all terms rarely
 * co-occur in a single chunk.
 *
 * The query is reduced to plain words (letters, digits, underscore, any script)
 * and each word is single-quoted, so no user text can form a tsquery operator
 * (& | ! < > - * ~ : parentheses, backslash).
 *
 * Example: "Acme interview follow-up Alice"
 *   → "'acme' | 'interview' | 'follow' | 'alice'"
 */
export function buildPgTsQuery(query: string): string {
  const words = query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const long = words.filter((t) => t.length >= 2);
  const tokens = long.filter((t) => !STOP_WORDS.has(t));
  // A query made only of stop words still searches for those words.
  const chosen = tokens.length > 0 ? tokens : long;
  return chosen.map((t) => `'${t}'`).join(" | ");
}
