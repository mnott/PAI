/**
 * Name index builder for Obsidian wikilink resolution.
 */

import { basename } from "node:path";
import type { VaultFile } from "./types.js";

/**
 * Build a name lookup index for Obsidian wikilink resolution.
 *
 * Maps lowercase filename (without .md extension) to all vault-relative paths
 * that share that name. Includes both canonical paths and alias paths so that
 * wikilinks resolve regardless of which path the file is accessed through.
 */
export function buildNameIndex(files: VaultFile[]): Map<string, string[]> {
  const index = new Map<string, string[]>();

  for (const file of files) {
    const name = basename(file.vaultRelPath, ".md").toLowerCase();
    const existing = index.get(name);
    if (existing) {
      existing.push(file.vaultRelPath);
    } else {
      index.set(name, [file.vaultRelPath]);
    }
  }

  return index;
}
