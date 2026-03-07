/**
 * File indexer for the PAI federation memory engine.
 *
 * Scans project memory/ and Notes/ directories, chunks markdown files, and
 * inserts the resulting chunks into federation.db for BM25 search.
 *
 * Change detection: files whose SHA-256 hash has not changed since the last
 * index run are skipped, keeping incremental re-indexing fast.
 *
 * Phase 2.5: adds embedChunks() for generating vector embeddings on indexed
 * chunks that do not yet have an embedding stored.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { join, relative, basename, normalize } from "node:path";
import { homedir } from "node:os";
import type { Database } from "better-sqlite3";
import { chunkMarkdown } from "./chunker.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IndexResult {
  filesProcessed: number;
  chunksCreated: number;
  filesSkipped: number;
}

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
// Chunk ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic chunk ID from its coordinates.
 * Format: sha256("projectId:path:chunkIndex:startLine:endLine")
 *
 * The chunkIndex (0-based position within the file) is included so that
 * chunks with approximated line numbers (e.g. from splitBySentences) never
 * produce colliding IDs even when multiple chunks share the same startLine/endLine.
 */
function chunkId(
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
// File hash
// ---------------------------------------------------------------------------

function sha256File(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// ---------------------------------------------------------------------------
// Core indexing operations
// ---------------------------------------------------------------------------

/**
 * Index a single file into the federation database.
 *
 * @returns true if the file was re-indexed (changed or new), false if skipped.
 */
export function indexFile(
  db: Database,
  projectId: number,
  rootPath: string,
  relativePath: string,
  source: string,
  tier: string,
): boolean {
  const absPath = join(rootPath, relativePath);

  // Read file content
  let content: string;
  let stat: ReturnType<typeof statSync>;
  try {
    content = readFileSync(absPath, "utf8");
    stat = statSync(absPath);
  } catch {
    // File unreadable or missing — skip silently
    return false;
  }

  const hash = sha256File(content);
  const mtime = Math.floor(stat.mtimeMs);
  const size = stat.size;

  // Check if the file has changed since last index
  const existing = db
    .prepare(
      "SELECT hash FROM memory_files WHERE project_id = ? AND path = ?",
    )
    .get(projectId, relativePath) as { hash: string } | undefined;

  if (existing?.hash === hash) {
    // Unchanged — skip
    return false;
  }

  // Delete old chunks for this file from both tables
  const oldChunkIds = db
    .prepare(
      "SELECT id FROM memory_chunks WHERE project_id = ? AND path = ?",
    )
    .all(projectId, relativePath) as Array<{ id: string }>;

  const deleteFts = db.prepare("DELETE FROM memory_fts WHERE id = ?");
  const deleteChunk = db.prepare(
    "DELETE FROM memory_chunks WHERE project_id = ? AND path = ?",
  );

  db.transaction(() => {
    for (const row of oldChunkIds) {
      deleteFts.run(row.id);
    }
    deleteChunk.run(projectId, relativePath);
  })();

  // Chunk the new content
  const chunks = chunkMarkdown(content);

  // Insert new chunks into memory_chunks and memory_fts
  const insertChunk = db.prepare(`
    INSERT INTO memory_chunks (id, project_id, source, tier, path, start_line, end_line, hash, text, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertFts = db.prepare(`
    INSERT INTO memory_fts (text, id, project_id, path, source, tier, start_line, end_line)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const upsertFile = db.prepare(`
    INSERT INTO memory_files (project_id, path, source, tier, hash, mtime, size)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, path) DO UPDATE SET
      source = excluded.source,
      tier   = excluded.tier,
      hash   = excluded.hash,
      mtime  = excluded.mtime,
      size   = excluded.size
  `);

  const updatedAt = Date.now();

  db.transaction(() => {
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const id = chunkId(projectId, relativePath, i, chunk.startLine, chunk.endLine);
      insertChunk.run(
        id,
        projectId,
        source,
        tier,
        relativePath,
        chunk.startLine,
        chunk.endLine,
        chunk.hash,
        chunk.text,
        updatedAt,
      );
      insertFts.run(
        chunk.text,
        id,
        projectId,
        relativePath,
        source,
        tier,
        chunk.startLine,
        chunk.endLine,
      );
    }
    upsertFile.run(projectId, relativePath, source, tier, hash, mtime, size);
  })();

  return true;
}

// ---------------------------------------------------------------------------
// Directory walker
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
function walkMdFiles(
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
 * Directories to ALWAYS skip, at any depth, during any directory walk.
 * These are build artifacts, dependency trees, and VCS internals that
 * should never be indexed regardless of where they appear in the tree.
 */
const ALWAYS_SKIP_DIRS = new Set([
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
const ROOT_SCAN_SKIP_DIRS = new Set([
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
const CONTENT_SCAN_SKIP_DIRS = new Set([
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

/**
 * Recursively collect all .md files under rootPath, excluding directories
 * that are already covered by dedicated scans (memory/, Notes/) and
 * common noise directories (.git, node_modules, etc.).
 *
 * Returns absolute paths for files NOT already handled by the specific scanners.
 * Stops collecting once MAX_FILES_PER_PROJECT is reached.
 */
function walkContentFiles(rootPath: string): string[] {
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
// Project-level indexing
// ---------------------------------------------------------------------------

/**
 * Index all memory, Notes, and content files for a single registered project.
 *
 * Scans:
 *  - {rootPath}/MEMORY.md    → source='memory', tier='evergreen'
 *  - {rootPath}/memory/      → source='memory', tier from detectTier()
 *  - {rootPath}/Notes/       → source='notes',  tier='session'
 *  - {rootPath}/**\/\*.md    → source='content', tier='topic'  (all other .md files, recursive)
 *  - {claudeNotesDir}/       → source='notes',  tier='session'  (if set and different)
 *
 * The content scan covers projects like job-discussions where markdown files
 * live in date/topic subdirectories rather than a memory/ folder.  The
 * memory/, Notes/, .git/, and node_modules/ directories are excluded from
 * the content scan to avoid double-indexing.
 *
 * The claudeNotesDir parameter points to ~/.claude/projects/{encoded}/Notes/
 * where Claude Code writes session notes for a given working directory.
 * It is stored on the project row as claude_notes_dir after a registry scan.
 */
/**
 * Number of files to process before yielding to the event loop inside
 * indexProject. Keeps IPC responsive even while indexing large projects.
 * Lower = more responsive but more overhead. 10 is a good balance.
 */
const INDEX_YIELD_EVERY = 10;

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
/** Paths that must never be indexed — system/temp dirs that can contain backup snapshots. */
const BLOCKED_ROOTS = new Set(["/tmp", "/private/tmp", "/var", "/private/var"]);

function isPathTooBroadForContentScan(rootPath: string): boolean {
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

export async function indexProject(
  db: Database,
  projectId: number,
  rootPath: string,
  claudeNotesDir?: string | null,
): Promise<IndexResult> {
  const result: IndexResult = {
    filesProcessed: 0,
    chunksCreated: 0,
    filesSkipped: 0,
  };

  const filesToIndex: Array<{ absPath: string; rootBase: string; source: string; tier: string }> = [];

  // Root-level MEMORY.md
  const rootMemoryMd = join(rootPath, "MEMORY.md");
  if (existsSync(rootMemoryMd)) {
    filesToIndex.push({ absPath: rootMemoryMd, rootBase: rootPath, source: "memory", tier: "evergreen" });
  }

  // memory/ directory
  const memoryDir = join(rootPath, "memory");
  for (const absPath of walkMdFiles(memoryDir)) {
    const relPath = relative(rootPath, absPath);
    const tier = detectTier(relPath);
    filesToIndex.push({ absPath, rootBase: rootPath, source: "memory", tier });
  }

  // {rootPath}/Notes/ directory
  const notesDir = join(rootPath, "Notes");
  for (const absPath of walkMdFiles(notesDir)) {
    filesToIndex.push({ absPath, rootBase: rootPath, source: "notes", tier: "session" });
  }

  // Synthetic session-title chunks for Notes files with the standard filename format:
  // "NNNN - YYYY-MM-DD - Descriptive Title.md"
  // These are small, high-signal chunks that make session titles searchable via BM25 and embeddings.
  {
    const SESSION_TITLE_RE = /^(\d{4})\s*-\s*(\d{4}-\d{2}-\d{2})\s*-\s*(.+)\.md$/;
    const titleInsertChunk = db.prepare(`
      INSERT OR IGNORE INTO memory_chunks (id, project_id, source, tier, path, start_line, end_line, hash, text, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const titleInsertFts = db.prepare(`
      INSERT OR IGNORE INTO memory_fts (text, id, project_id, path, source, tier, start_line, end_line)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updatedAt = Date.now();
    for (const absPath of walkMdFiles(notesDir)) {
      const fileName = basename(absPath);
      const m = SESSION_TITLE_RE.exec(fileName);
      if (!m) continue;
      const [, num, date, title] = m;
      const text = `Session #${num} ${date}: ${title}`;
      const relPath = relative(rootPath, absPath);
      const syntheticPath = `${relPath}::title`;
      const id = chunkId(projectId, syntheticPath, 0, 0, 0);
      const hash = sha256File(text);
      db.transaction(() => {
        titleInsertChunk.run(id, projectId, "notes", "session", syntheticPath, 0, 0, hash, text, updatedAt);
        titleInsertFts.run(text, id, projectId, syntheticPath, "notes", "session", 0, 0);
      })();
    }
  }

  // {rootPath}/**/*.md — all other markdown content (e.g. year/month/topic dirs)
  // Uses walkContentFiles which skips memory/, Notes/, .git/, node_modules/ etc.
  // Skip the content scan for paths that are too broad (home dir, filesystem root, etc.)
  // to avoid runaway directory traversal. Memory and Notes scans above are always safe
  // because they target specific named subdirectories.
  if (!isPathTooBroadForContentScan(rootPath)) {
    for (const absPath of walkContentFiles(rootPath)) {
      filesToIndex.push({ absPath, rootBase: rootPath, source: "content", tier: "topic" });
    }
  }

  // Claude Code session notes directory (~/.claude/projects/{encoded}/Notes/)
  // Only scan if it is set, exists, and is not the same path as rootPath/Notes/
  if (claudeNotesDir && claudeNotesDir !== notesDir) {
    for (const absPath of walkMdFiles(claudeNotesDir)) {
      filesToIndex.push({ absPath, rootBase: claudeNotesDir, source: "notes", tier: "session" });
    }

    // Synthetic title chunks for claude notes dir
    {
      const SESSION_TITLE_RE_CLAUDE = /^(\d{4})\s*-\s*(\d{4}-\d{2}-\d{2})\s*-\s*(.+)\.md$/;
      const updatedAt = Date.now();
      const titleInsertChunk2 = db.prepare(`
        INSERT OR IGNORE INTO memory_chunks (id, project_id, source, tier, path, start_line, end_line, hash, text, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const titleInsertFts2 = db.prepare(`
        INSERT OR IGNORE INTO memory_fts (text, id, project_id, path, source, tier, start_line, end_line)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const absPath of walkMdFiles(claudeNotesDir)) {
        const fileName = basename(absPath);
        const m = SESSION_TITLE_RE_CLAUDE.exec(fileName);
        if (!m) continue;
        const [, num, date, title] = m;
        const text = `Session #${num} ${date}: ${title}`;
        const relPath = relative(claudeNotesDir, absPath);
        const syntheticPath = `${relPath}::title`;
        const id = chunkId(projectId, syntheticPath, 0, 0, 0);
        const hash = sha256File(text);
        db.transaction(() => {
          titleInsertChunk2.run(id, projectId, "notes", "session", syntheticPath, 0, 0, hash, text, updatedAt);
          titleInsertFts2.run(text, id, projectId, syntheticPath, "notes", "session", 0, 0);
        })();
      }
    }

    // Derive the sibling memory/ directory: .../Notes/ → .../memory/
    if (claudeNotesDir.endsWith("/Notes")) {
      const claudeProjectDir = claudeNotesDir.slice(0, -"/Notes".length);
      const claudeMemoryDir = join(claudeProjectDir, "memory");

      // MEMORY.md at the Claude Code project dir level (sibling of Notes/)
      const claudeMemoryMd = join(claudeProjectDir, "MEMORY.md");
      if (existsSync(claudeMemoryMd)) {
        filesToIndex.push({
          absPath: claudeMemoryMd,
          rootBase: claudeProjectDir,
          source: "memory",
          tier: "evergreen",
        });
      }

      // memory/ directory sibling of Notes/
      for (const absPath of walkMdFiles(claudeMemoryDir)) {
        const relPath = relative(claudeProjectDir, absPath);
        const tier = detectTier(relPath);
        filesToIndex.push({ absPath, rootBase: claudeProjectDir, source: "memory", tier });
      }
    }
  }

  // Yield after collection phase (which is synchronous) before we start processing
  await yieldToEventLoop();

  let filesSinceYield = 0;

  for (const { absPath, rootBase, source, tier } of filesToIndex) {
    // Yield to the event loop periodically so the IPC server stays responsive
    if (filesSinceYield >= INDEX_YIELD_EVERY) {
      await yieldToEventLoop();
      filesSinceYield = 0;
    }
    filesSinceYield++;

    const relPath = relative(rootBase, absPath);
    const changed = indexFile(db, projectId, rootBase, relPath, source, tier);

    if (changed) {
      // Count chunks created for this file
      const count = db
        .prepare(
          "SELECT COUNT(*) as n FROM memory_chunks WHERE project_id = ? AND path = ?",
        )
        .get(projectId, relPath) as { n: number };

      result.filesProcessed++;
      result.chunksCreated += count.n;
    } else {
      result.filesSkipped++;
    }
  }

  // ---------------------------------------------------------------------------
  // Prune stale paths: remove DB entries for files that no longer exist on disk.
  // This handles renames, moves, and deletions — the indexer only adds/updates,
  // so without pruning, old paths accumulate forever.
  // ---------------------------------------------------------------------------

  const livePaths = new Set<string>();
  for (const { absPath, rootBase } of filesToIndex) {
    livePaths.add(relative(rootBase, absPath));
  }

  // Query all distinct paths in memory_chunks for this project
  const dbChunkPaths = db
    .prepare("SELECT DISTINCT path FROM memory_chunks WHERE project_id = ?")
    .all(projectId) as Array<{ path: string }>;

  const stalePaths: string[] = [];
  for (const row of dbChunkPaths) {
    // Synthetic title paths (ending in "::title") are live if their base file is live
    const basePath = row.path.endsWith("::title")
      ? row.path.slice(0, -"::title".length)
      : row.path;
    if (!livePaths.has(basePath)) {
      stalePaths.push(row.path);
    }
  }

  if (stalePaths.length > 0) {
    const deleteChunksFts = db.prepare("DELETE FROM memory_fts WHERE id = ?");
    const deleteChunks = db.prepare(
      "DELETE FROM memory_chunks WHERE project_id = ? AND path = ?",
    );
    const deleteFile = db.prepare(
      "DELETE FROM memory_files WHERE project_id = ? AND path = ?",
    );

    db.transaction(() => {
      for (const stalePath of stalePaths) {
        const chunkIds = db
          .prepare("SELECT id FROM memory_chunks WHERE project_id = ? AND path = ?")
          .all(projectId, stalePath) as Array<{ id: string }>;
        for (const { id } of chunkIds) {
          deleteChunksFts.run(id);
        }
        deleteChunks.run(projectId, stalePath);
        deleteFile.run(projectId, stalePath);
      }
    })();
  }

  return result;
}

// ---------------------------------------------------------------------------
// Global indexing (all registered projects)
// ---------------------------------------------------------------------------

/**
 * Yield to the Node.js event loop between projects so the IPC server
 * remains responsive during long index runs.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Index all active projects registered in the registry DB.
 *
 * Async: yields to the event loop between each project so that the daemon's
 * Unix socket server can process IPC requests (e.g. status) while indexing.
 */
export async function indexAll(
  db: Database,
  registryDb: Database,
): Promise<{ projects: number; result: IndexResult }> {
  const projects = registryDb
    .prepare("SELECT id, root_path, claude_notes_dir FROM projects WHERE status = 'active'")
    .all() as Array<{ id: number; root_path: string; claude_notes_dir: string | null }>;

  const totals: IndexResult = {
    filesProcessed: 0,
    chunksCreated: 0,
    filesSkipped: 0,
  };

  for (const project of projects) {
    // Yield before each project so the event loop can drain IPC requests
    await yieldToEventLoop();

    const r = await indexProject(db, project.id, project.root_path, project.claude_notes_dir);
    totals.filesProcessed += r.filesProcessed;
    totals.chunksCreated += r.chunksCreated;
    totals.filesSkipped += r.filesSkipped;
  }

  return { projects: projects.length, result: totals };
}

// ---------------------------------------------------------------------------
// Embedding generation
// ---------------------------------------------------------------------------

export interface EmbedResult {
  chunksEmbedded: number;
  chunksSkipped: number;
}

/**
 * Generate and store embeddings for chunks that do not yet have one.
 *
 * Because better-sqlite3 is synchronous but the embedding pipeline is async,
 * we fetch all unembedded chunk texts first, generate embeddings in batches,
 * and then write them back in a transaction.
 *
 * @param db         Open federation database.
 * @param projectId  Optional — restrict to a specific project.
 * @param batchSize  Number of chunks to embed per round. Default 50.
 * @param onProgress Optional callback called after each batch with running totals.
 */
export async function embedChunks(
  db: Database,
  projectId?: number,
  batchSize = 50,
  onProgress?: (embedded: number, total: number) => void,
): Promise<EmbedResult> {
  // Dynamic import — keeps the heavy ML runtime out of the module load path
  const { generateEmbedding, serializeEmbedding } = await import("./embeddings.js");

  const conditions = ["embedding IS NULL"];
  const params: (string | number)[] = [];

  if (projectId !== undefined) {
    conditions.push("project_id = ?");
    params.push(projectId);
  }

  const where = "WHERE " + conditions.join(" AND ");

  const rows = db
    .prepare(`SELECT id, text FROM memory_chunks ${where} ORDER BY id`)
    .all(...params) as Array<{ id: string; text: string }>;

  if (rows.length === 0) {
    return { chunksEmbedded: 0, chunksSkipped: 0 };
  }

  const updateStmt = db.prepare(
    "UPDATE memory_chunks SET embedding = ? WHERE id = ?",
  );

  let embedded = 0;
  const total = rows.length;

  // Process in batches so progress callbacks are meaningful
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);

    // Generate embeddings for the batch (async — must happen OUTSIDE transaction)
    const embeddings: Array<{ id: string; blob: Buffer }> = [];
    for (const row of batch) {
      const vec = await generateEmbedding(row.text);
      const blob = serializeEmbedding(vec);
      embeddings.push({ id: row.id, blob });
    }

    // Write the batch in a single transaction
    db.transaction(() => {
      for (const { id, blob } of embeddings) {
        updateStmt.run(blob, id);
      }
    })();

    embedded += embeddings.length;
    onProgress?.(embedded, total);
  }

  return { chunksEmbedded: embedded, chunksSkipped: 0 };
}
