/**
 * Vault directory walker — follows symlinks with cycle detection.
 */

import { statSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import type { VaultFile } from "./types.js";

/** Maximum number of .md files to collect from a vault. */
const VAULT_MAX_FILES = 10_000;

/** Maximum recursion depth for vault directory walks. */
const VAULT_MAX_DEPTH = 10;

/**
 * Directories to always skip, at any depth, during vault walks.
 * Includes standard build/VCS noise plus Obsidian-specific directories.
 */
const VAULT_SKIP_DIRS = new Set([
  // Version control
  ".git",
  // Dependency directories (any language)
  "node_modules",
  "vendor",
  "Pods",
  // Build / compile output
  "dist",
  "build",
  "out",
  "DerivedData",
  ".next",
  // Python virtual environments and caches
  ".venv",
  "venv",
  "__pycache__",
  // General caches
  ".cache",
  ".bun",
  // Obsidian internals
  ".obsidian",
  ".trash",
]);

/**
 * Recursively collect all .md files under a vault root, following symlinks.
 *
 * Symlink-following behaviour:
 *  - Symbolic links to files: followed if the target is a .md file
 *  - Symbolic links to directories: followed with cycle detection via inode
 *
 * Cycle detection is based on the real inode of each visited directory.
 * Using the real stat (not lstat) ensures that symlinked dirs resolve to
 * their actual inode, preventing infinite loops.
 *
 * @param vaultRoot  Absolute path to the vault root directory.
 * @param opts       Optional overrides for maxFiles and maxDepth.
 */
export function walkVaultMdFiles(
  vaultRoot: string,
  opts?: { maxFiles?: number; maxDepth?: number },
): VaultFile[] {
  const maxFiles = opts?.maxFiles ?? VAULT_MAX_FILES;
  const maxDepth = opts?.maxDepth ?? VAULT_MAX_DEPTH;

  const results: VaultFile[] = [];
  const visitedDirs = new Set<string>();

  function walk(dir: string, depth: number): void {
    if (results.length >= maxFiles) return;
    if (depth > maxDepth) return;

    // Get the real inode of this directory (follows symlinks on the dir itself)
    let dirStat: ReturnType<typeof statSync>;
    try {
      dirStat = statSync(dir);
    } catch {
      return; // Unreadable or broken symlink — skip
    }

    const dirKey = `${dirStat.dev}:${dirStat.ino}`;
    if (visitedDirs.has(dirKey)) return; // Cycle detected
    visitedDirs.add(dirKey);

    let entries: import("node:fs").Dirent<string>[];
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return; // Unreadable directory — skip
    }

    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      if (VAULT_SKIP_DIRS.has(entry.name)) continue;

      const full = join(dir, entry.name);

      if (entry.isSymbolicLink()) {
        // Follow the symlink — resolve to real target
        let targetStat: ReturnType<typeof statSync>;
        try {
          targetStat = statSync(full); // statSync follows symlinks
        } catch {
          continue; // Broken symlink — skip
        }

        if (targetStat.isDirectory()) {
          if (!VAULT_SKIP_DIRS.has(entry.name)) {
            walk(full, depth + 1);
          }
        } else if (targetStat.isFile() && entry.name.endsWith(".md")) {
          results.push({
            absPath: full,
            vaultRelPath: relative(vaultRoot, full),
            inode: targetStat.ino,
            device: targetStat.dev,
          });
        }
      } else if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        let fileStat: ReturnType<typeof statSync>;
        try {
          fileStat = statSync(full);
        } catch {
          continue;
        }
        results.push({
          absPath: full,
          vaultRelPath: relative(vaultRoot, full),
          inode: fileStat.ino,
          device: fileStat.dev,
        });
      }
    }
  }

  if (existsSync(vaultRoot)) {
    walk(vaultRoot, 0);
  }

  return results;
}
