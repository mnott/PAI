/**
 * Backend-aware indexer for PAI federation memory.
 *
 * This module provides the same functionality as indexer.ts but writes
 * through the StorageBackend interface instead of directly to better-sqlite3.
 * Used when the daemon is configured with the Postgres backend.
 *
 * The SQLite path still uses indexer.ts directly (which is faster for SQLite
 * due to synchronous transactions).
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { join, relative, basename, normalize } from "node:path";

// ---------------------------------------------------------------------------
// Session title parsing
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
import { homedir } from "node:os";
import type { Database } from "better-sqlite3";
import type { StorageBackend, ChunkRow } from "../storage/interface.js";
import type { IndexResult } from "./indexer.js";
import { chunkMarkdown } from "./chunker.js";
import { detectTier } from "./indexer.js";

// ---------------------------------------------------------------------------
// Constants (mirrored from indexer.ts)
// ---------------------------------------------------------------------------

const MAX_FILES_PER_PROJECT = 5_000;
const MAX_WALK_DEPTH = 6;
const INDEX_YIELD_EVERY = 10;

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
]);

const ROOT_SCAN_SKIP_DIRS = new Set([
  "memory", "Notes", ".claude", ".DS_Store",
  ...ALWAYS_SKIP_DIRS,
]);

const CONTENT_SCAN_SKIP_DIRS = new Set([
  "Library", "Applications", "Music", "Movies", "Pictures", "Desktop",
  "Downloads", "Public", "coverage",
  ...ALWAYS_SKIP_DIRS,
]);

// ---------------------------------------------------------------------------
// Helpers (same logic as indexer.ts)
// ---------------------------------------------------------------------------

function sha256File(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

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
  } catch { /* skip unreadable */ }
  return results;
}

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
        if (entry.name !== "MEMORY.md") results.push(full);
      }
    }
  } catch { /* skip */ }
  return results;
}

function isPathTooBroadForContentScan(rootPath: string): boolean {
  const normalized = normalize(rootPath);
  const home = homedir();
  if (home.startsWith(normalized) || normalized === "/") return true;
  if (normalized.startsWith(home)) {
    const rel = normalized.slice(home.length).replace(/^\//, "");
    const depth = rel ? rel.split("/").length : 0;
    if (depth === 0) return true;
  }
  if (existsSync(join(normalized, ".git"))) return true;
  return false;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// File indexing via StorageBackend
// ---------------------------------------------------------------------------

/**
 * Index a single file through the StorageBackend interface.
 * Returns true if the file was re-indexed (changed or new), false if skipped.
 */
export async function indexFileWithBackend(
  backend: StorageBackend,
  projectId: number,
  rootPath: string,
  relativePath: string,
  source: string,
  tier: string,
): Promise<boolean> {
  const absPath = join(rootPath, relativePath);

  let content: string;
  let stat: ReturnType<typeof statSync>;
  try {
    content = readFileSync(absPath, "utf8");
    stat = statSync(absPath);
  } catch {
    return false;
  }

  const hash = sha256File(content);
  const mtime = Math.floor(stat.mtimeMs);
  const size = stat.size;

  // Change detection
  const existingHash = await backend.getFileHash(projectId, relativePath);
  if (existingHash === hash) return false;

  // Delete old chunks
  await backend.deleteChunksForFile(projectId, relativePath);

  // Chunk the content
  const rawChunks = chunkMarkdown(content);
  const updatedAt = Date.now();

  const chunks: ChunkRow[] = rawChunks.map((c, i) => ({
    id: chunkId(projectId, relativePath, i, c.startLine, c.endLine),
    projectId,
    source,
    tier,
    path: relativePath,
    startLine: c.startLine,
    endLine: c.endLine,
    hash: c.hash,
    text: c.text,
    updatedAt,
    embedding: null,
  }));

  // Insert chunks + update file record
  await backend.insertChunks(chunks);
  await backend.upsertFile({ projectId, path: relativePath, source, tier, hash, mtime, size });

  return true;
}

// ---------------------------------------------------------------------------
// Project-level indexing via StorageBackend
// ---------------------------------------------------------------------------

export async function indexProjectWithBackend(
  backend: StorageBackend,
  projectId: number,
  rootPath: string,
  claudeNotesDir?: string | null,
): Promise<IndexResult> {
  const result: IndexResult = { filesProcessed: 0, chunksCreated: 0, filesSkipped: 0 };

  const filesToIndex: Array<{ absPath: string; rootBase: string; source: string; tier: string }> = [];

  const rootMemoryMd = join(rootPath, "MEMORY.md");
  if (existsSync(rootMemoryMd)) {
    filesToIndex.push({ absPath: rootMemoryMd, rootBase: rootPath, source: "memory", tier: "evergreen" });
  }

  const memoryDir = join(rootPath, "memory");
  for (const absPath of walkMdFiles(memoryDir)) {
    const relPath = relative(rootPath, absPath);
    const tier = detectTier(relPath);
    filesToIndex.push({ absPath, rootBase: rootPath, source: "memory", tier });
  }

  const notesDir = join(rootPath, "Notes");
  for (const absPath of walkMdFiles(notesDir)) {
    filesToIndex.push({ absPath, rootBase: rootPath, source: "notes", tier: "session" });
  }

  // Synthetic session-title chunks: parse titles from Notes filenames and insert
  // as high-signal chunks so session names are searchable via BM25 and embeddings.
  {
    const updatedAt = Date.now();
    for (const absPath of walkMdFiles(notesDir)) {
      const fileName = basename(absPath);
      const text = parseSessionTitleChunk(fileName);
      if (!text) continue;
      const relPath = relative(rootPath, absPath);
      const syntheticPath = `${relPath}::title`;
      const id = chunkId(projectId, syntheticPath, 0, 0, 0);
      const hash = sha256File(text);
      const titleChunk: import("../storage/interface.js").ChunkRow = {
        id, projectId, source: "notes", tier: "session",
        path: syntheticPath, startLine: 0, endLine: 0,
        hash, text, updatedAt, embedding: null,
      };
      try {
        await backend.insertChunks([titleChunk]);
      } catch {
        // Skip title chunks that cause backend errors
      }
    }
  }

  if (!isPathTooBroadForContentScan(rootPath)) {
    for (const absPath of walkContentFiles(rootPath)) {
      filesToIndex.push({ absPath, rootBase: rootPath, source: "content", tier: "topic" });
    }
  }

  if (claudeNotesDir && claudeNotesDir !== notesDir) {
    for (const absPath of walkMdFiles(claudeNotesDir)) {
      filesToIndex.push({ absPath, rootBase: claudeNotesDir, source: "notes", tier: "session" });
    }

    // Synthetic title chunks for claude notes dir
    {
      const updatedAt = Date.now();
      for (const absPath of walkMdFiles(claudeNotesDir)) {
        const fileName = basename(absPath);
        const text = parseSessionTitleChunk(fileName);
        if (!text) continue;
        const relPath = relative(claudeNotesDir, absPath);
        const syntheticPath = `${relPath}::title`;
        const id = chunkId(projectId, syntheticPath, 0, 0, 0);
        const hash = sha256File(text);
        const titleChunk: import("../storage/interface.js").ChunkRow = {
          id, projectId, source: "notes", tier: "session",
          path: syntheticPath, startLine: 0, endLine: 0,
          hash, text, updatedAt, embedding: null,
        };
        try {
          await backend.insertChunks([titleChunk]);
        } catch {
          // Skip title chunks that cause backend errors
        }
      }
    }

    if (claudeNotesDir.endsWith("/Notes")) {
      const claudeProjectDir = claudeNotesDir.slice(0, -"/Notes".length);
      const claudeMemoryMd = join(claudeProjectDir, "MEMORY.md");
      if (existsSync(claudeMemoryMd)) {
        filesToIndex.push({ absPath: claudeMemoryMd, rootBase: claudeProjectDir, source: "memory", tier: "evergreen" });
      }
      const claudeMemoryDir = join(claudeProjectDir, "memory");
      for (const absPath of walkMdFiles(claudeMemoryDir)) {
        const relPath = relative(claudeProjectDir, absPath);
        const tier = detectTier(relPath);
        filesToIndex.push({ absPath, rootBase: claudeProjectDir, source: "memory", tier });
      }
    }
  }

  await yieldToEventLoop();

  let filesSinceYield = 0;

  for (const { absPath, rootBase, source, tier } of filesToIndex) {
    if (filesSinceYield >= INDEX_YIELD_EVERY) {
      await yieldToEventLoop();
      filesSinceYield = 0;
    }
    filesSinceYield++;

    const relPath = relative(rootBase, absPath);
    try {
      const changed = await indexFileWithBackend(backend, projectId, rootBase, relPath, source, tier);

      if (changed) {
        // Count chunks — we know we just inserted them, count from the chunk IDs
        const ids = await backend.getChunkIds(projectId, relPath);
        result.filesProcessed++;
        result.chunksCreated += ids.length;
      } else {
        result.filesSkipped++;
      }
    } catch {
      // Skip files that cause backend errors (e.g. null bytes in Postgres)
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

  const dbChunkPaths = await backend.getDistinctChunkPaths(projectId);

  const stalePaths: string[] = [];
  for (const p of dbChunkPaths) {
    const basePath = p.endsWith("::title") ? p.slice(0, -"::title".length) : p;
    if (!livePaths.has(basePath)) {
      stalePaths.push(p);
    }
  }

  if (stalePaths.length > 0) {
    await backend.deletePaths(projectId, stalePaths);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Embedding generation via StorageBackend
// ---------------------------------------------------------------------------

const EMBED_BATCH_SIZE = 50;
const EMBED_YIELD_EVERY = 10;

/**
 * Generate and store embeddings for all unembedded chunks via the StorageBackend.
 *
 * Processes chunks in batches of EMBED_BATCH_SIZE, yielding to the event loop
 * every EMBED_YIELD_EVERY chunks to avoid blocking IPC calls from MCP shims.
 *
 * The optional `shouldStop` callback is checked between every batch. When it
 * returns true the embed loop exits early so the caller (e.g. the daemon
 * shutdown handler) can close the pool without racing against active queries.
 *
 * Returns the number of newly embedded chunks.
 */
export async function embedChunksWithBackend(
  backend: StorageBackend,
  shouldStop?: () => boolean,
): Promise<number> {
  const { generateEmbedding, serializeEmbedding } = await import("./embeddings.js");

  const rows = await backend.getUnembeddedChunkIds();
  if (rows.length === 0) return 0;

  const total = rows.length;
  let embedded = 0;

  for (let i = 0; i < rows.length; i += EMBED_BATCH_SIZE) {
    // Check cancellation between every batch before touching the pool again
    if (shouldStop?.()) {
      process.stderr.write(
        `[pai-daemon] Embed pass cancelled after ${embedded}/${total} chunks (shutdown requested)\n`
      );
      break;
    }

    const batch = rows.slice(i, i + EMBED_BATCH_SIZE);

    for (let j = 0; j < batch.length; j++) {
      const { id, text } = batch[j];

      // Yield to the event loop periodically to keep IPC responsive
      if ((embedded + j) % EMBED_YIELD_EVERY === 0) {
        await yieldToEventLoop();
      }

      const vec = await generateEmbedding(text);
      const blob = serializeEmbedding(vec);
      await backend.updateEmbedding(id, blob);
    }

    embedded += batch.length;
    process.stderr.write(
      `[pai-daemon] Embedded ${embedded}/${total} chunks\n`
    );
  }

  return embedded;
}

// ---------------------------------------------------------------------------
// Global indexing via StorageBackend
// ---------------------------------------------------------------------------

export async function indexAllWithBackend(
  backend: StorageBackend,
  registryDb: Database,
): Promise<{ projects: number; result: IndexResult }> {
  const projects = registryDb
    .prepare("SELECT id, root_path, claude_notes_dir FROM projects WHERE status = 'active'")
    .all() as Array<{ id: number; root_path: string; claude_notes_dir: string | null }>;

  const totals: IndexResult = { filesProcessed: 0, chunksCreated: 0, filesSkipped: 0 };

  for (const project of projects) {
    await yieldToEventLoop();
    const r = await indexProjectWithBackend(backend, project.id, project.root_path, project.claude_notes_dir);
    totals.filesProcessed += r.filesProcessed;
    totals.chunksCreated += r.chunksCreated;
    totals.filesSkipped += r.filesSkipped;
  }

  return { projects: projects.length, result: totals };
}
