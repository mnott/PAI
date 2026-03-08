/**
 * Shared helpers for the PAI memory indexers.
 *
 * Contains utilities used by both the sync (SQLite) and async (StorageBackend)
 * indexer paths: hashing, chunk ID generation, directory walking, and path guards.
 */

import { readdirSync, existsSync } from "node:fs";
import { sha256File } from "../../utils/hash.js";
import { join, normalize } from "node:path";
import { homedir } from "node:os";
import { basename } from "node:path";

// ---------------------------------------------------------------------------
// Tier detection
// ---------------------------------------------------------------------------

/**
 * Classify a relative file path into one of the four memory tiers.
 *
 * Rules (in priority order):
 *  - MEMORY.md anywhere in memory/  → 'evergreen'
 *  - YYYY-MM-DD.md in memory/       → 'daily'
 *  - anything else in memory/       → 'topic'
 *  - anything in Notes/             → 'session'
 */
export function detectTier(
  relativePath: string,
): "evergreen" | "daily" | "topic" | "session" {
  // Normalise to forward slashes and strip leading ./
  const p = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");

  // Notes directory → session tier
  if (p.startsWith("Notes/") || p === "Notes") {
    return "session";
  }

  const fileName = basename(p);

  // MEMORY.md (case-sensitive match) → evergreen
  if (fileName === "MEMORY.md") {
    return "evergreen";
  }

  // YYYY-MM-DD.md → daily
  if (/^\d{4}-\d{2}-\d{2}\.md$/.test(fileName)) {
    return "daily";
  }

  // Default for memory/ files
  return "topic";
}

// ---------------------------------------------------------------------------
// Hashing and chunk ID generation
// ---------------------------------------------------------------------------

// sha256File imported from ../../utils/hash.js
export { sha256File } from "../../utils/hash.js";

/**
 * Generate a deterministic chunk ID from its coordinates.
 * Format: sha256("projectId:path:chunkIndex:startLine:endLine")
 *
 * The chunkIndex (0-based position within the file) is included so that
 * chunks with approximated line numbers (e.g. from splitBySentences) never
 * produce colliding IDs even when multiple chunks share the same startLine/endLine.
 */
export function chunkId(
  projectId: number,
  path: string,
  chunkIndex: number,
  startLine: number,
  endLine: number,
): string {
  return createHash("sha256")
    .update(`${projectId}:${path}:${chunkIndex}:${startLine}:${endLine}`)
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Event loop yield
// ---------------------------------------------------------------------------

/**
 * Yield to the Node.js event loop so that IPC server can process requests
 * during long index runs.
 *
 * Uses setTimeout(10ms) rather than setImmediate — the 10ms pause gives the
 * event loop enough time to accept and process incoming IPC connections
 * (socket data, new connections, etc.). Without this, synchronous ONNX
 * inference blocks IPC for the full duration of each embedding (~50-100ms
 * per chunk).
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

// ---------------------------------------------------------------------------
// Directory skip sets
// ---------------------------------------------------------------------------

/**
 * Directories to ALWAYS skip, at any depth, during any directory walk.
 * These are build artifacts, dependency trees, and VCS internals that
 * should never be indexed regardless of where they appear in the tree.
 */
export const ALWAYS_SKIP_DIRS = new Set([
  // Version control
  ".git",
  // Dependency directories (any language)
  "node_modules",
  "vendor",
  "Pods",              // CocoaPods (iOS/macOS)
  // Build / compile output
  "dist",
  "build",
  "out",
  "DerivedData",       // Xcode
  ".next",             // Next.js
  // Python virtual environments and caches
  ".venv",
  "venv",
  "__pycache__",
  // General caches
  ".cache",
  ".bun",
  // Backup snapshots (Carbon Copy Cloner, Time Machine, etc.)
  "snaps",
  ".Trashes",
]);

/**
 * Directories to skip when doing a root-level content scan.
 * These are either already handled by dedicated scans or should never be indexed.
 */
export const ROOT_SCAN_SKIP_DIRS = new Set([
  "memory",
  "Notes",
  ".claude",
  ".DS_Store",
  // Everything in ALWAYS_SKIP_DIRS is also excluded at root level
  ...ALWAYS_SKIP_DIRS,
]);

/**
 * Additional directories to skip at the content-scan level (first level below root).
 * These are common macOS/Linux home-directory or repo noise directories that are
 * never meaningful as project content.
 */
export const CONTENT_SCAN_SKIP_DIRS = new Set([
  // macOS home directory standard folders
  "Library",
  "Applications",
  "Music",
  "Movies",
  "Pictures",
  "Desktop",
  "Downloads",
  "Public",
  // Common dev noise
  "coverage",
  // Everything in ALWAYS_SKIP_DIRS is also excluded at this level
  ...ALWAYS_SKIP_DIRS,
]);

// ---------------------------------------------------------------------------
// Directory walkers
// ---------------------------------------------------------------------------

/**
 * Safety cap: maximum number of .md files collected per project scan.
 * Prevents runaway scans on huge root paths (e.g. home directory).
 * Projects with more files than this are scanned up to the cap only.
 */
const MAX_FILES_PER_PROJECT = 5_000;

/**
 * Maximum recursion depth for directory walks.
 * Prevents deep traversal of large directory trees (e.g. development repos).
 * Depth 0 = the given directory itself (no recursion).
 * Value 6 allows: root → subdirs → sub-subdirs → ... up to 6 levels.
 * Sufficient for memory/, Notes/, and typical docs structures.
 */
const MAX_WALK_DEPTH = 6;

/**
 * Recursively collect all .md files under a directory.
 * Returns absolute paths. Stops early if the accumulated count hits the cap
 * or if the recursion depth exceeds MAX_WALK_DEPTH.
 *
 * @param dir    Directory to scan.
 * @param acc    Shared accumulator array (mutated in place for early exit).
 * @param cap    Maximum number of files to collect (across all recursive calls).
 * @param depth  Current recursion depth (0 = the initial call).
 */
export function walkMdFiles(
  dir: string,
  acc?: string[],
  cap = MAX_FILES_PER_PROJECT,
  depth = 0,
): string[] {
  const results = acc ?? [];
  if (!existsSync(dir)) return results;
  if (results.length >= cap) return results;
  if (depth > MAX_WALK_DEPTH) return results;

  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (results.length >= cap) break;
      if (entry.isSymbolicLink()) continue;
      // Skip known junk directories at every recursion depth
      if (ALWAYS_SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walkMdFiles(full, results, cap, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(full);
      }
    }
  } catch {
    // Unreadable directory — skip
  }
  return results;
}

/**
 * Recursively collect all .md files under rootPath, excluding directories
 * that are already covered by dedicated scans (memory/, Notes/) and
 * common noise directories (.git, node_modules, etc.).
 *
 * Returns absolute paths for files NOT already handled by the specific scanners.
 * Stops collecting once MAX_FILES_PER_PROJECT is reached.
 */
export function walkContentFiles(rootPath: string): string[] {
  if (!existsSync(rootPath)) return [];

  const results: string[] = [];
  try {
    for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
      if (results.length >= MAX_FILES_PER_PROJECT) break;
      if (entry.isSymbolicLink()) continue;
      if (ROOT_SCAN_SKIP_DIRS.has(entry.name)) continue;
      if (CONTENT_SCAN_SKIP_DIRS.has(entry.name)) continue;

      const full = join(rootPath, entry.name);
      if (entry.isDirectory()) {
        walkMdFiles(full, results, MAX_FILES_PER_PROJECT);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        // Skip root-level MEMORY.md — handled by the dedicated evergreen scan
        if (entry.name !== "MEMORY.md") {
          results.push(full);
        }
      }
    }
  } catch {
    // Unreadable directory — skip
  }
  return results;
}

// ---------------------------------------------------------------------------
// Path safety guard
// ---------------------------------------------------------------------------

/** Paths that must never be indexed — system/temp dirs that can contain backup snapshots. */
const BLOCKED_ROOTS = new Set(["/tmp", "/private/tmp", "/var", "/private/var"]);

/**
 * Returns true if rootPath should skip the recursive content scan.
 *
 * Skips content scanning for:
 *  - The home directory itself or any ancestor (too broad — millions of files)
 *  - Git repositories (code repos — index memory/ and Notes/ only, not all .md files)
 *
 * The content scan is still useful for Obsidian vaults, Notes folders, and
 * other doc-centric project trees where ALL markdown files are meaningful.
 *
 * The memory/, Notes/, and claude_notes_dir scans always run regardless.
 */
export function isPathTooBroadForContentScan(rootPath: string): boolean {
  const normalized = normalize(rootPath);

  // Block system/temp directories outright (CCC snapshots live here)
  if (BLOCKED_ROOTS.has(normalized)) return true;
  for (const blocked of BLOCKED_ROOTS) {
    if (normalized.startsWith(blocked + "/")) return true;
  }

  const home = homedir();

  // Skip the home directory itself or any ancestor of home
  if (home.startsWith(normalized) || normalized === "/") {
    return true;
  }

  // Skip home directory itself (depth 0)
  if (normalized.startsWith(home)) {
    const rel = normalized.slice(home.length).replace(/^\//, "");
    const depth = rel ? rel.split("/").length : 0;
    if (depth === 0) return true;
  }

  // Skip git repositories — content scan is only for doc-centric projects
  // (Obsidian vaults, knowledge bases). Code repos use memory/ and Notes/ only.
  if (existsSync(join(normalized, ".git"))) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Session title parser
// ---------------------------------------------------------------------------

const SESSION_TITLE_RE = /^(\d{4})\s*-\s*(\d{4}-\d{2}-\d{2})\s*-\s*(.+)\.md$/;

/**
 * Parse a session title from a Notes filename.
 * Format: "NNNN - YYYY-MM-DD - Descriptive Title.md"
 * Returns a synthetic chunk text like "Session #0086 2026-02-23: Pai Daemon Background Service"
 * or null if the filename doesn't match the expected pattern.
 */
export function parseSessionTitleChunk(fileName: string): string | null {
  const m = SESSION_TITLE_RE.exec(fileName);
  if (!m) return null;
  const [, num, date, title] = m;
  return `Session #${num} ${date}: ${title}`;
}

/** Number of files to process before yielding to the event loop inside indexProject. */
export const INDEX_YIELD_EVERY = 10;
