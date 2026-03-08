/**
 * Backend-aware async indexer for PAI federation memory.
 *
 * Provides the same functionality as sync.ts but writes through the
 * StorageBackend interface instead of directly to better-sqlite3.
 * Used when the daemon is configured with the Postgres backend.
 *
 * The SQLite path still uses sync.ts directly (which is faster for SQLite
 * due to synchronous transactions).
 */

import { readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, basename } from "node:path";
import type { Database } from "better-sqlite3";
import type { StorageBackend, ChunkRow } from "../../storage/interface.js";
import { chunkMarkdown } from "../chunker.js";
import {
  sha256File,
  chunkId,
  detectTier,
  walkMdFiles,
  walkContentFiles,
  isPathTooBroadForContentScan,
  parseSessionTitleChunk,
  yieldToEventLoop,
  INDEX_YIELD_EVERY,
} from "./helpers.js";
import type { IndexResult } from "./types.js";

export type { IndexResult };

// ---------------------------------------------------------------------------
// Single-file indexing via StorageBackend
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

  // Synthetic session-title chunks for Notes files
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
      const titleChunk: ChunkRow = {
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
        const titleChunk: ChunkRow = {
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

  // Prune stale paths
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
const EMBED_YIELD_EVERY = 1;

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
  projectNames?: Map<number, string>,
): Promise<number> {
  const { generateEmbedding, serializeEmbedding } = await import("../embeddings.js");

  const rows = await backend.getUnembeddedChunkIds();
  if (rows.length === 0) return 0;

  const total = rows.length;
  let embedded = 0;

  // Build a summary of what needs embedding: count chunks per project_id
  const projectChunkCounts = new Map<number, { count: number; samplePath: string }>();
  for (const row of rows) {
    const entry = projectChunkCounts.get(row.project_id);
    if (entry) {
      entry.count++;
    } else {
      projectChunkCounts.set(row.project_id, { count: 1, samplePath: row.path });
    }
  }
  const pName = (pid: number) => projectNames?.get(pid) ?? `project ${pid}`;
  const projectSummary = Array.from(projectChunkCounts.entries())
    .map(([pid, { count, samplePath }]) => `  ${pName(pid)}: ${count} chunks (e.g. ${samplePath})`)
    .join("\n");
  process.stderr.write(
    `[pai-daemon] Embed pass: ${total} unembedded chunks across ${projectChunkCounts.size} project(s)\n${projectSummary}\n`
  );

  // Track current project for transition logging
  let currentProjectId = -1;
  let projectEmbedded = 0;

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
      const { id, text, project_id, path } = batch[j];

      // Log when switching to a new project
      if (project_id !== currentProjectId) {
        if (currentProjectId !== -1) {
          process.stderr.write(
            `[pai-daemon] Finished ${pName(currentProjectId)}: ${projectEmbedded} chunks embedded\n`
          );
        }
        const info = projectChunkCounts.get(project_id);
        process.stderr.write(
          `[pai-daemon] Embedding ${pName(project_id)} (${info?.count ?? "?"} chunks, starting at ${path})\n`
        );
        currentProjectId = project_id;
        projectEmbedded = 0;
      }

      // Yield to the event loop periodically to keep IPC responsive
      if ((embedded + j) % EMBED_YIELD_EVERY === 0) {
        await yieldToEventLoop();
      }

      const vec = await generateEmbedding(text);
      const blob = serializeEmbedding(vec);
      await backend.updateEmbedding(id, blob);
      projectEmbedded++;
    }

    embedded += batch.length;

    // Log progress with current file path for context
    const lastChunk = batch[batch.length - 1];
    process.stderr.write(
      `[pai-daemon] Embedded ${embedded}/${total} chunks (${pName(lastChunk.project_id)}: ${lastChunk.path})\n`
    );
  }

  // Log final project completion
  if (currentProjectId !== -1) {
    process.stderr.write(
      `[pai-daemon] Finished ${pName(currentProjectId)}: ${projectEmbedded} chunks embedded\n`
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
