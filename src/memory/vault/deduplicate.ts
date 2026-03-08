/**
 * Inode-based deduplication for vault files.
 */

import type { VaultFile, InodeGroup } from "./types.js";

/**
 * Group vault files by inode identity (device + inode).
 *
 * Within each group, the canonical file is chosen as the one with the
 * fewest path separators (shallowest), breaking ties by shortest string.
 * All other group members become aliases.
 */
export function deduplicateByInode(files: VaultFile[]): InodeGroup[] {
  const groups = new Map<string, VaultFile[]>();

  for (const file of files) {
    const key = `${file.device}:${file.inode}`;
    const existing = groups.get(key);
    if (existing) {
      existing.push(file);
    } else {
      groups.set(key, [file]);
    }
  }

  const result: InodeGroup[] = [];

  for (const group of groups.values()) {
    if (group.length === 0) continue;

    // Sort: fewest path separators first, then shortest string
    const sorted = [...group].sort((a, b) => {
      const aDepth = (a.vaultRelPath.match(/\//g) ?? []).length;
      const bDepth = (b.vaultRelPath.match(/\//g) ?? []).length;
      if (aDepth !== bDepth) return aDepth - bDepth;
      return a.vaultRelPath.length - b.vaultRelPath.length;
    });

    const [canonical, ...aliases] = sorted as [VaultFile, ...VaultFile[]];
    result.push({ canonical, aliases });
  }

  return result;
}
