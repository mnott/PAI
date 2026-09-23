/**
 * Synchronous (SQLite) indexer — moved from memory/indexer/sync.ts so the
 * only file that opens prepared statements against the federation database
 * lives under src/storage/ (design doc docs/design/postgres-only.md, unit 7).
 *
 * Scans project memory/ and Notes/ directories, chunks markdown files, and
 * inserts the resulting chunks into the federation memory store for BM25
 * search. Uses raw better-sqlite3 Database directly for maximum SQLite
 * performance (synchronous transactions, no serialisation overhead) — the
 * reason SQLiteBackend keeps this path instead of routing through the
 * generic (StorageBackend) indexer that Postgres uses.
 */

import { readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, basename } from "node:path";
import type { Database } from "better-sqlite3";
import type { RegistryBackend } from "../registry-interface.js";
import { chunkMarkdown } from "../../memory/chunker.js";
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
} from "../../memory/indexer/helpers.js";
import type { IndexResult } from "../../memory/indexer/types.js";

// ---------------------------------------------------------------------------
// Single-file indexing
// ---------------------------------------------------------------------------

/**
 * Index a single file into the federation database.
 *
 * @returns true if the file was re-indexed (changed or new), false if skipped.
 */
function indexFile(
  db: Database,
  projectId: number,
  rootPath: string,
  relativePath: string,
  source: string,
  tier: string,
): boolean {
  const absPath = join(rootPath, relativePath);

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

  const existing = db
    .prepare("SELECT hash FROM memory_files WHERE project_id = ? AND path = ?")
    .get(projectId, relativePath) as { hash: string } | undefined;

  if (existing?.hash === hash) {
    return false;
  }

  const oldChunkIds = db
    .prepare("SELECT id FROM memory_chunks WHERE project_id = ? AND path = ?")
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

  const chunks = chunkMarkdown(content);

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
        id, projectId, source, tier, relativePath,
        chunk.startLine, chunk.endLine, chunk.hash, chunk.text, updatedAt,
      );
      insertFts.run(
        chunk.text, id, projectId, relativePath, source, tier,
        chunk.startLine, chunk.endLine,
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
 */
async function indexProject(
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

  if (!isPathTooBroadForContentScan(rootPath)) {
    for (const absPath of walkContentFiles(rootPath)) {
      filesToIndex.push({ absPath, rootBase: rootPath, source: "content", tier: "topic" });
    }
  }

  if (claudeNotesDir && claudeNotesDir !== notesDir) {
    for (const absPath of walkMdFiles(claudeNotesDir)) {
      filesToIndex.push({ absPath, rootBase: claudeNotesDir, source: "notes", tier: "session" });
    }

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
        .prepare("SELECT COUNT(*) as n FROM memory_chunks WHERE project_id = ? AND path = ?")
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
export async function indexAllSqlite(
  db: Database,
  registry: RegistryBackend,
): Promise<{ projects: number; result: IndexResult }> {
  const projects = await registry.listProjects({ status: "active" });

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
