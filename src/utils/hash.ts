/**
 * Shared hashing utilities. Centralises all SHA-256 usage so every module
 * obtains digests through the same function rather than inlining createHash.
 */

import { createHash } from "node:crypto";

/**
 * Compute a SHA-256 hex digest of the given string.
 * Aliased as sha256File for compatibility with existing call-sites that use
 * that name to hash file contents.
 */
export function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Alias kept for backwards compatibility with memory/indexer call-sites. */
export const sha256File = sha256;
