/**
 * Wikilink resolver using Obsidian's shortest-match algorithm.
 */

import { normalize, basename, dirname } from "node:path";

/**
 * Resolve a wikilink target to a vault-relative path using Obsidian's rules.
 *
 * Resolution algorithm:
 *  1. If raw contains "/", attempt exact path match (with and without .md).
 *  2. Normalize: lowercase the raw target, strip .md extension.
 *  3. Look up in the name index (all files with that basename).
 *  4. If exactly one match, return it.
 *  5. If multiple matches, pick the one closest to the source file
 *     (longest common directory prefix, then shortest overall path).
 *  6. If no matches, return null (dead link).
 *
 * @param raw         The raw link target (heading-stripped, pipe-stripped).
 * @param nameIndex   Map from lowercase basename-without-ext to vault paths.
 * @param sourcePath  Vault-relative path of the file containing the link.
 * @returns           Vault-relative path of the resolved target, or null.
 */
export function resolveWikilink(
  raw: string,
  nameIndex: Map<string, string[]>,
  sourcePath: string,
): string | null {
  if (!raw) return null;

  // Case 1: path contains "/" — try exact match with and without .md
  if (raw.includes("/")) {
    const normalized = normalize(raw);
    const normalizedMd = normalized.endsWith(".md") ? normalized : normalized + ".md";

    // Check if any indexed path matches (case-insensitive for macOS compatibility)
    for (const [, paths] of nameIndex) {
      for (const p of paths) {
        if (p === normalizedMd || p === normalized) return p;
        if (p.toLowerCase() === normalizedMd.toLowerCase()) return p;
      }
    }
    // Fall through to name lookup in case the path prefix was wrong
  }

  // Normalize the raw target for name lookup.
  // Use the basename only — Obsidian resolves by filename, not full path.
  const rawBase = basename(raw)
    .replace(/\.md$/i, "")
    .toLowerCase()
    .trim();

  if (!rawBase) return null;

  const candidates = nameIndex.get(rawBase);

  if (!candidates || candidates.length === 0) {
    return null; // Dead link
  }

  if (candidates.length === 1) {
    return candidates[0]!;
  }

  // Multiple matches — pick the one closest to the source file
  const sourceDir = dirname(sourcePath);

  let bestPath: string | null = null;
  let bestPrefixLen = -1;
  let bestPathLen = Infinity;

  for (const candidate of candidates) {
    const candidateDir = dirname(candidate);
    const prefixLen = commonPrefixLength(sourceDir, candidateDir);
    const pathLen = candidate.length;

    if (
      prefixLen > bestPrefixLen ||
      (prefixLen === bestPrefixLen && pathLen < bestPathLen)
    ) {
      bestPrefixLen = prefixLen;
      bestPathLen = pathLen;
      bestPath = candidate;
    }
  }

  return bestPath;
}

/**
 * Compute the length of the common prefix between two directory paths,
 * measured in path segments (not raw characters).
 *
 * Example: "a/b/c" and "a/b/d" → 2 (common: "a", "b")
 */
function commonPrefixLength(a: string, b: string): number {
  if (a === "." && b === ".") return 0;
  const aParts = a === "." ? [] : a.split("/");
  const bParts = b === "." ? [] : b.split("/");
  let count = 0;
  const len = Math.min(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    if (aParts[i] === bParts[i]) {
      count++;
    } else {
      break;
    }
  }
  return count;
}
