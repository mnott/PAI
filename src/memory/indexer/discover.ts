/**
 * File discovery shared by the SQLite and backend (Postgres) project indexers:
 * which markdown/content files a project contributes and which synthetic
 * session-title chunks its Notes directories yield.
 */

import { existsSync } from "node:fs";
import { join, relative, basename } from "node:path";
import type { ChunkRow } from "../../storage/interface.js";
import {
  sha256File,
  chunkId,
  detectTier,
  walkMdFiles,
  walkContentFiles,
  isPathTooBroadForContentScan,
  parseSessionTitleChunk,
} from "./helpers.js";

export interface IndexFile {
  absPath: string;
  rootBase: string;
  source: string;
  tier: string;
  pathPrefix?: string;
}

/**
 * Synthetic title chunks for Notes files with the standard filename format
 * "NNNN - YYYY-MM-DD - Descriptive Title.md".
 */
function sessionTitleChunks(projectId: number, notesDir: string, relBase: string, updatedAt: number): ChunkRow[] {
  const chunks: ChunkRow[] = [];
  for (const absPath of walkMdFiles(notesDir)) {
    const text = parseSessionTitleChunk(basename(absPath));
    if (!text) continue;
    const path = `${relative(relBase, absPath)}::title`;
    chunks.push({
      id: chunkId(projectId, path, 0, 0, 0),
      projectId, source: "notes", tier: "session",
      path, startLine: 0, endLine: 0,
      hash: sha256File(text), text, updatedAt, embedding: null,
    });
  }
  return chunks;
}

/** Memory markdown files under `base`: MEMORY.md (evergreen) plus memory/*.md (tiered). */
function memoryFiles(base: string, pathPrefix?: string): IndexFile[] {
  const files: IndexFile[] = [];
  const prefix = pathPrefix === undefined ? {} : { pathPrefix };
  const memoryMd = join(base, "MEMORY.md");
  if (existsSync(memoryMd)) {
    files.push({ absPath: memoryMd, rootBase: base, source: "memory", tier: "evergreen", ...prefix });
  }
  for (const absPath of walkMdFiles(join(base, "memory"))) {
    files.push({ absPath, rootBase: base, source: "memory", tier: detectTier(relative(base, absPath)), ...prefix });
  }
  return files;
}

/**
 * Everything a project contributes to the index: the files to chunk and the
 * session-title chunks to insert. `claudeMemoryPrefix` namespaces the claude
 * project dir's memory files (omit for no prefix).
 */
export function discoverProjectFiles(
  projectId: number,
  rootPath: string,
  claudeNotesDir?: string | null,
  claudeMemoryPrefix?: string,
): { files: IndexFile[]; titleChunks: ChunkRow[] } {
  const notesDir = join(rootPath, "Notes");
  const updatedAt = Date.now();
  const files = memoryFiles(rootPath);
  const titleChunks = sessionTitleChunks(projectId, notesDir, rootPath, updatedAt);

  for (const absPath of walkMdFiles(notesDir)) {
    files.push({ absPath, rootBase: rootPath, source: "notes", tier: "session" });
  }
  if (!isPathTooBroadForContentScan(rootPath)) {
    for (const absPath of walkContentFiles(rootPath)) {
      files.push({ absPath, rootBase: rootPath, source: "content", tier: "topic" });
    }
  }

  if (claudeNotesDir && claudeNotesDir !== notesDir) {
    for (const absPath of walkMdFiles(claudeNotesDir)) {
      files.push({ absPath, rootBase: claudeNotesDir, source: "notes", tier: "session" });
    }
    titleChunks.push(...sessionTitleChunks(projectId, claudeNotesDir, claudeNotesDir, updatedAt));
    if (claudeNotesDir.endsWith("/Notes")) {
      files.push(...memoryFiles(claudeNotesDir.slice(0, -"/Notes".length), claudeMemoryPrefix));
    }
  }
  return { files, titleChunks };
}
