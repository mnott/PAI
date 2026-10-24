/**
 * Backend-aware async indexer for PAI federation memory.
 *
 * Provides the same functionality as sync.ts but writes through the
 * StorageBackend interface instead of directly to the SQLite driver.
 * Used when the daemon is configured with the Postgres backend.
 *
 * The SQLite path still uses sync.ts directly (which is faster for SQLite
 * due to synchronous transactions).
 */

import type { IndexAllProgress } from "../job-progress.js";
import { readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { StorageBackend, ChunkRow } from "../../storage/interface.js";
import type { RegistryBackend } from "../../storage/registry-interface.js";
// Static on purpose: a lazy import() of a dist chunk first hit after a rebuild
// throws "Cannot find module" (prune-dist.mjs deletes superseded chunks).
import { serializeEmbedding } from "../embeddings.js";
import { gateBackend } from "../embedding-gate.js";
import { chunkMarkdown, fileContentHash } from "../chunker.js";
import {
  chunkId,
  yieldToEventLoop,
  INDEX_YIELD_EVERY,
} from "./helpers.js";
import { retryTransient } from "./retry.js";
import { discoverProjectFiles } from "./discover.js";
import type { IndexResult } from "./types.js";

export type { IndexResult };

/** Path namespace for memory files from the claude project dir (avoids clashing with the project root's memory/). */
export const CLAUDE_MEMORY_PREFIX = ".claude-memory/";

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
  pathPrefix = "",
): Promise<boolean> {
  const absPath = join(rootPath, relativePath);
  // Path under which the file is stored; the prefix keeps files from other
  // roots (claude project dir) from colliding with the project root's paths.
  const dbPath = pathPrefix + relativePath;

  let content: string;
  let stat: ReturnType<typeof statSync>;
  try {
    content = readFileSync(absPath, "utf8");
    stat = statSync(absPath);
  } catch {
    return false;
  }

  const hash = fileContentHash(content);
  const mtime = Math.floor(stat.mtimeMs);
  const size = stat.size;

  // Change detection
  const existingHash = await backend.getFileHash(projectId, dbPath);
  if (existingHash === hash) return false;

  // Delete old chunks
  await backend.deleteChunksForFile(projectId, dbPath);

  // Chunk the content
  const rawChunks = chunkMarkdown(content);
  const updatedAt = Date.now();

  const chunks: ChunkRow[] = rawChunks.map((c, i) => ({
    id: chunkId(projectId, dbPath, i, c.startLine, c.endLine),
    projectId,
    source,
    tier,
    path: dbPath,
    startLine: c.startLine,
    endLine: c.endLine,
    hash: c.hash,
    text: c.text,
    updatedAt,
    embedding: null,
  }));

  // Insert chunks + update file record
  await backend.insertChunks(chunks);
  await backend.upsertFile({ projectId, path: dbPath, source, tier, hash, mtime, size });

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
  onFile?: (soFar: IndexResult) => void,
): Promise<IndexResult> {
  const result: IndexResult = { filesProcessed: 0, chunksCreated: 0, filesSkipped: 0 };

  const { files: filesToIndex, titleChunks } = discoverProjectFiles(projectId, rootPath, claudeNotesDir, CLAUDE_MEMORY_PREFIX);
  for (const titleChunk of titleChunks) {
    try {
      if ((await backend.getChunkIds(projectId, titleChunk.path)).length > 0) continue;
      await backend.insertChunks([titleChunk]);
    } catch {
      // Skip title chunks that cause backend errors
    }
  }

  await yieldToEventLoop();

  let filesSinceYield = 0;

  for (const { absPath, rootBase, source, tier, pathPrefix = "" } of filesToIndex) {
    if (filesSinceYield >= INDEX_YIELD_EVERY) {
      await yieldToEventLoop();
      filesSinceYield = 0;
    }
    filesSinceYield++;

    const relPath = relative(rootBase, absPath);
    try {
      const changed = await indexFileWithBackend(backend, projectId, rootBase, relPath, source, tier, pathPrefix);

      if (changed) {
        const ids = await backend.getChunkIds(projectId, pathPrefix + relPath);
        result.filesProcessed++;
        result.chunksCreated += ids.length;
      } else {
        result.filesSkipped++;
      }
    } catch {
      // Skip files that cause backend errors (e.g. null bytes in Postgres)
      result.filesSkipped++;
    }
    onFile?.(result);
  }

  // Prune stale paths
  const livePaths = new Set<string>();
  for (const { absPath, rootBase, pathPrefix = "" } of filesToIndex) {
    livePaths.add(pathPrefix + relative(rootBase, absPath));
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

/** Default ceiling on one pass. See EmbedPassOptions. */
const DEFAULT_MAX_CHUNKS_PER_PASS = 5_000;
/** Default wall-clock ceiling on one pass, in milliseconds. */
const DEFAULT_MAX_MILLIS_PER_PASS = 120_000;

export interface EmbedPassOptions {
  /**
   * Stop the pass after this many chunks. Unbounded passes are the reason a
   * six-figure backlog starves the indexer: the daemon serialises indexing and
   * embedding against each other, so a pass that runs for hours means nothing
   * new gets indexed for hours. Bounding the pass costs nothing — every
   * embedding is written as it is produced, so the next pass resumes exactly
   * where this one stopped.
   */
  maxChunks?: number;
  /** Stop the pass after this much wall-clock time, whichever bound hits first. */
  maxMillis?: number;
  /** Chunks per embed call (default EMBED_BATCH_SIZE). */
  batchSize?: number;
  /** Checked between batches; a string stops the pass (yield) with that reason. */
  shouldYield?: () => string | null;
  /** Called after every stored batch with the chunks embedded so far. */
  onProgress?: (embedded: number) => void;
  /** Called once when the loop ends: "done" (backlog slice finished), "budget" or "yielded". */
  onEnd?: (r: { outcome: "done" | "budget" | "yielded" | "failed"; embedded: number; reason?: string }) => void;
}

/**
 * Generate and store embeddings for unembedded chunks via the StorageBackend.
 *
 * The pass is deliberately bounded (see EmbedPassOptions) and resumable: it
 * takes a slice of the backlog, embeds it, and returns so the scheduler can run
 * an index pass before coming back. Draining the whole backlog in one call
 * starves indexing for as long as the call runs.
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
  options?: EmbedPassOptions,
): Promise<number> {

  const maxChunks = options?.maxChunks ?? DEFAULT_MAX_CHUNKS_PER_PASS;
  const maxMillis = options?.maxMillis ?? DEFAULT_MAX_MILLIS_PER_PASS;
  const deadline = Date.now() + maxMillis;
  const batchSize = options?.batchSize ?? EMBED_BATCH_SIZE;
  let outcome: "done" | "budget" | "yielded" = "done";
  let yieldReason: string | undefined;

  const initialYield = options?.shouldYield?.() ?? null;
  if (initialYield) {
    process.stderr.write(`[pai-daemon] Embed pass yielded before start: ${initialYield}\n`);
    options?.onEnd?.({ outcome: "yielded", embedded: 0, reason: initialYield });
    return 0;
  }

  const rows = await retryTransient(() => backend.getUnembeddedChunkIds(undefined, maxChunks));
  if (rows.length === 0) {
    options?.onEnd?.({ outcome: "done", embedded: 0 });
    return 0;
  }

  // The configured backend must match the one that produced the index's vectors
  // and be reachable. Otherwise pause: chunks stay NULL for a later pass, and
  // no other backend is ever substituted.
  const gate = await gateBackend(backend, { record: true });
  if (!gate.ok) {
    process.stderr.write(`[pai-daemon] Embed pass paused (${gate.kind}): ${gate.reason}\n`);
    options?.onEnd?.({ outcome: "failed", embedded: 0, reason: gate.reason });
    return 0;
  }

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

  for (let i = 0; i < rows.length; i += batchSize) {
    // Check cancellation between every batch before touching the pool again
    if (shouldStop?.()) {
      process.stderr.write(
        `[pai-daemon] Embed pass cancelled after ${embedded}/${total} chunks (shutdown requested)\n`
      );
      break;
    }

    // Yield the daemon back to the indexer rather than run past the deadline.
    // The remaining rows are simply picked up by the next scheduled pass.
    if (Date.now() >= deadline) {
      process.stderr.write(
        `[pai-daemon] Embed pass yielding after ${embedded}/${total} chunks (${maxMillis}ms budget spent); resuming next pass\n`
      );
      outcome = "budget";
      break;
    }

    const why = options?.shouldYield?.() ?? null;
    if (why) {
      process.stderr.write(
        `[pai-daemon] Embed pass yielding after ${embedded}/${total} chunks (${why}); resuming next pass\n`
      );
      outcome = "yielded";
      yieldReason = why;
      break;
    }

    const batch = rows.slice(i, i + batchSize);

    // Keep IPC responsive: the forward pass below is synchronous inside the
    // model, so yield before entering it rather than between chunks.
    await yieldToEventLoop();

    const vecs = await gate.backend.embed(batch.map((r) => r.text));
    // Issue the writes together rather than one round-trip at a time. Measured
    // on this machine the model embeds 40-67 chunks/s in isolation while the
    // daemon managed ~5/s: the difference was one sequential UPDATE per chunk,
    // so the pass spent most of its budget waiting on the network, not working.
    // Concurrency is bounded by the batch size, which the pool handles; the
    // SQLite backend is synchronous and simply ignores the difference.
    await Promise.all(
      batch.map((row, j) =>
        retryTransient(() => backend.updateEmbedding(row.id, serializeEmbedding(vecs[j])))
      )
    );

    // Attribute the batch to projects only after it is durably stored, and walk
    // it in order so a batch straddling a project boundary credits each side
    // correctly. Rows arrive ordered by project, so a boundary is a real
    // transition, not the per-chunk flapping this logging used to produce.
    for (const { project_id, path } of batch) {
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
      projectEmbedded++;
    }

    embedded += batch.length;
    options?.onProgress?.(embedded);

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

  options?.onEnd?.({ outcome, embedded, ...(yieldReason ? { reason: yieldReason } : {}) });
  return embedded;
}

// ---------------------------------------------------------------------------
// Global indexing via StorageBackend
// ---------------------------------------------------------------------------

export async function indexAllWithBackend(
  backend: StorageBackend,
  registry: RegistryBackend,
  onProgress?: (p: IndexAllProgress) => void,
): Promise<{ projects: number; result: IndexResult }> {
  const projects = await registry.listProjects({ status: "active" });

  const totals: IndexResult = { filesProcessed: 0, chunksCreated: 0, filesSkipped: 0 };

  const report = (done: number, current: string, part?: IndexResult): void =>
    onProgress?.({ done, total: projects.length, current, files: totals.filesProcessed + (part?.filesProcessed ?? 0), chunks: totals.chunksCreated + (part?.chunksCreated ?? 0), skipped: totals.filesSkipped + (part?.filesSkipped ?? 0) });
  report(0, "");
  let n = 0;
  for (const project of projects) {
    await yieldToEventLoop();
    const r = await indexProjectWithBackend(backend, project.id, project.root_path, project.claude_notes_dir, (part) => report(n, project.display_name, part));
    totals.filesProcessed += r.filesProcessed;
    totals.chunksCreated += r.chunksCreated;
    totals.filesSkipped += r.filesSkipped;
    report(++n, project.display_name);
  }

  return { projects: projects.length, result: totals };
}
