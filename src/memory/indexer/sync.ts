/**
 * Synchronous (SQLite) indexer for the PAI federation memory engine.
 *
 * Scans project memory/ and Notes/ directories, chunks markdown files, and
 * inserts the resulting chunks into federation.db for BM25 search.
 *
 * Change detection: files whose SHA-256 hash has not changed since the last
 * index run are skipped, keeping incremental re-indexing fast.
 *
 * Uses raw better-sqlite3 Database directly for maximum SQLite performance
 * (synchronous transactions, no serialisation overhead).
 */

import { readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, basename } from "node:path";
import type { Database } from "better-sqlite3";
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
import type { IndexResult, EmbedResult } from "./types.js";

export type { IndexResult, EmbedResult };

// Re-export detectTier for backward-compatibility (consumers import it from indexer.js)
export { detectTier };

// ---------------------------------------------------------------------------
// Single-file indexing
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
// Project-level indexing
// ---------------------------------------------------------------------------

/**
 * Index all memory, Notes, and content files for a single registered project.
 *
 * Scans:
 *  - {rootPath}/MEMORY.md    → source='memory', tier='evergreen'
 *  - {rootPath}/memory/      → source='memory', tier from detectTier()
 *  - {rootPath}/Notes/       → source='notes',  tier='session'
 *  - {rootPath}/**\/*.md    → source='content', tier='topic'  (all other .md files, recursive)
 *  - {claudeNotesDir}/       → source='notes',  tier='session'  (if set and different)
 */
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
  {
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
      const text = parseSessionTitleChunk(fileName);
      if (!text) continue;
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

  // {rootPath}/**/*.md — all other markdown content
  if (!isPathTooBroadForContentScan(rootPath)) {
    for (const absPath of walkContentFiles(rootPath)) {
      filesToIndex.push({ absPath, rootBase: rootPath, source: "content", tier: "topic" });
    }
  }

  // Claude Code session notes directory (~/.claude/projects/{encoded}/Notes/)
  if (claudeNotesDir && claudeNotesDir !== notesDir) {
    for (const absPath of walkMdFiles(claudeNotesDir)) {
      filesToIndex.push({ absPath, rootBase: claudeNotesDir, source: "notes", tier: "session" });
    }

    // Synthetic title chunks for claude notes dir
    {
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
        const text = parseSessionTitleChunk(fileName);
        if (!text) continue;
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

      const claudeMemoryMd = join(claudeProjectDir, "MEMORY.md");
      if (existsSync(claudeMemoryMd)) {
        filesToIndex.push({
          absPath: claudeMemoryMd,
          rootBase: claudeProjectDir,
          source: "memory",
          tier: "evergreen",
        });
      }

      for (const absPath of walkMdFiles(claudeMemoryDir)) {
        const relPath = relative(claudeProjectDir, absPath);
        const tier = detectTier(relPath);
        filesToIndex.push({ absPath, rootBase: claudeProjectDir, source: "memory", tier });
      }
    }
  }

  // Yield after collection phase before processing
  await yieldToEventLoop();

  let filesSinceYield = 0;

  for (const { absPath, rootBase, source, tier } of filesToIndex) {
    if (filesSinceYield >= INDEX_YIELD_EVERY) {
      await yieldToEventLoop();
      filesSinceYield = 0;
    }
    filesSinceYield++;

    const relPath = relative(rootBase, absPath);
    const changed = indexFile(db, projectId, rootBase, relPath, source, tier);

    if (changed) {
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

  // Prune stale paths: remove DB entries for files that no longer exist on disk.
  const livePaths = new Set<string>();
  for (const { absPath, rootBase } of filesToIndex) {
    livePaths.add(relative(rootBase, absPath));
  }

  const dbChunkPaths = db
    .prepare("SELECT DISTINCT path FROM memory_chunks WHERE project_id = ?")
    .all(projectId) as Array<{ path: string }>;

  const stalePaths: string[] = [];
  for (const row of dbChunkPaths) {
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
  const { generateEmbedding, serializeEmbedding } = await import("../embeddings.js");

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
