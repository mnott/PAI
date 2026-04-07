/**
 * kg-backfill.ts — Populate the temporal knowledge graph from existing
 * session notes.
 *
 * Walks `Notes/YYYY/MM/*.md` for each registered project, runs the same
 * extractor that the session-summary-worker uses on every NEW summary, and
 * stores triples in Postgres. Idempotent: a state file at
 * ~/.config/pai/kg-backfill-state.json records which note paths have been
 * processed so re-runs skip them.
 *
 * Even without the state file the operation is safe — extractAndStoreTriples
 * uses supersession logic so re-extracting a note never produces duplicates.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Pool } from "pg";

import { openRegistry } from "../registry/db.js";
import { loadConfig } from "../daemon/config.js";
import { createStorageBackend } from "../storage/factory.js";
import { extractAndStoreTriples } from "./kg-extraction.js";

// ---------------------------------------------------------------------------
// State file
// ---------------------------------------------------------------------------

const STATE_FILE = join(homedir(), ".config", "pai", "kg-backfill-state.json");

interface BackfillState {
  /** Map of absolute note path -> ISO timestamp of when it was processed. */
  processed: Record<string, string>;
}

function loadState(): BackfillState {
  try {
    if (existsSync(STATE_FILE)) {
      const raw = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
      if (raw && typeof raw === "object" && raw.processed) return raw as BackfillState;
    }
  } catch { /* ignore */ }
  return { processed: {} };
}

function saveState(state: BackfillState): void {
  try {
    const dir = join(homedir(), ".config", "pai");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch (e) {
    process.stderr.write(`[kg-backfill] failed to save state: ${e}\n`);
  }
}

// ---------------------------------------------------------------------------
// Note discovery
// ---------------------------------------------------------------------------

interface ProjectRow {
  id: number;
  slug: string;
  root_path: string;
}

interface ProjectNote {
  project: ProjectRow;
  notePath: string;
}

/**
 * Find all session notes under <project_root>/Notes/YYYY/MM/*.md.
 * Falls back to <project_root>/Notes/*.md (flat layout) when no year/month
 * subdirectories are present.
 */
function findProjectNotes(project: ProjectRow): string[] {
  const notesRoot = join(project.root_path, "Notes");
  if (!existsSync(notesRoot)) return [];

  const found: Array<{ path: string; mtime: number }> = [];

  function walk(dir: string, depth: number): void {
    if (depth > 4) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full, depth + 1);
      } else if (st.isFile() && name.endsWith(".md") && /^\d{3,4}/.test(name)) {
        found.push({ path: full, mtime: st.mtimeMs });
      }
    }
  }

  walk(notesRoot, 0);
  // Process oldest first so newer extractions can correctly supersede older facts
  found.sort((a, b) => a.mtime - b.mtime);
  return found.map((f) => f.path);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BackfillOptions {
  /** If set, only process this project's notes. */
  projectSlug?: string;
  /** Cap the total number of notes processed across all projects. */
  limit?: number;
  /** If true, do not call the extractor and do not write any state. */
  dryRun?: boolean;
  /** Progress callback fired before each note is processed. */
  onProgress?: (current: number, total: number, note: string) => void;
}

export interface BackfillResult {
  notes_processed: number;
  triples_extracted: number;
  triples_added: number;
  triples_superseded: number;
  errors: number;
}

/**
 * Backfill the knowledge graph from existing session notes.
 *
 * Requires the Postgres backend (KG tables live there). Throws if Postgres
 * is unavailable, since this is an explicit user action.
 */
export async function backfillKgFromNotes(
  options: BackfillOptions = {}
): Promise<BackfillResult> {
  const result: BackfillResult = {
    notes_processed: 0,
    triples_extracted: 0,
    triples_added: 0,
    triples_superseded: 0,
    errors: 0,
  };

  const config = loadConfig();
  if (config.storageBackend !== "postgres") {
    throw new Error(
      "kg backfill requires the Postgres backend. " +
      'Set "storageBackend": "postgres" in ~/.config/pai/config.json.'
    );
  }

  const backend = await createStorageBackend(config);
  if (backend.backendType !== "postgres") {
    throw new Error(
      "Postgres backend unavailable — fell back to SQLite. Cannot backfill KG."
    );
  }

  const pool: Pool = (backend as unknown as { getPool(): Pool }).getPool();

  // -- Load projects -------------------------------------------------------
  const registry = openRegistry();
  let projects: ProjectRow[];
  try {
    if (options.projectSlug) {
      const row = registry
        .prepare("SELECT id, slug, root_path FROM projects WHERE slug = ?")
        .get(options.projectSlug) as ProjectRow | undefined;
      if (!row) {
        throw new Error(`Project not found: ${options.projectSlug}`);
      }
      projects = [row];
    } else {
      projects = registry
        .prepare(
          "SELECT id, slug, root_path FROM projects WHERE status = 'active' ORDER BY slug"
        )
        .all() as ProjectRow[];
    }
  } finally {
    registry.close();
  }

  // -- Build the work list -------------------------------------------------
  const state = loadState();
  const work: ProjectNote[] = [];
  for (const project of projects) {
    const notes = findProjectNotes(project);
    for (const notePath of notes) {
      if (state.processed[notePath]) continue;
      work.push({ project, notePath });
    }
  }

  const total = options.limit ? Math.min(options.limit, work.length) : work.length;

  // -- Process notes -------------------------------------------------------
  for (let i = 0; i < total; i++) {
    const { project, notePath } = work[i];
    options.onProgress?.(i + 1, total, notePath);

    if (options.dryRun) {
      result.notes_processed++;
      continue;
    }

    let noteContent: string;
    try {
      noteContent = readFileSync(notePath, "utf-8");
    } catch (e) {
      process.stderr.write(`[kg-backfill] read failed ${notePath}: ${e}\n`);
      result.errors++;
      continue;
    }

    try {
      const stats = await extractAndStoreTriples(pool, {
        summaryText: noteContent,
        projectSlug: project.slug,
        projectId: project.id,
        sessionId: `backfill:${notePath}`,
        gitLog: "",
        model: "sonnet",
      });

      result.notes_processed++;
      result.triples_extracted += stats.extracted;
      result.triples_added += stats.added;
      result.triples_superseded += stats.superseded;

      // Mark as processed (state file is the idempotency hint; the supersession
      // logic in the extractor is the actual safety net)
      state.processed[notePath] = new Date().toISOString();
      // Save incrementally so a crash mid-run doesn't lose progress
      if ((i + 1) % 5 === 0) saveState(state);
    } catch (e) {
      process.stderr.write(`[kg-backfill] extract failed ${notePath}: ${e}\n`);
      result.errors++;
    }
  }

  if (!options.dryRun) saveState(state);
  await backend.close();

  return result;
}
