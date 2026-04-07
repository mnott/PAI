/**
 * getTaxonomy — returns the shape of stored memory without requiring a query.
 *
 * Answers "what do I know about?" not "what do I know about X?"
 *
 * Uses the registry DB (projects, sessions) and the storage backend
 * (memory_files, memory_chunks) to build a structural overview.
 */

import type { Database } from "better-sqlite3";
import type { StorageBackend } from "../storage/interface.js";

// ---------------------------------------------------------------------------
// Return types
// ---------------------------------------------------------------------------

export interface TaxonomyProject {
  slug: string;
  display_name: string;
  session_count: number;
  note_count: number;
  last_activity: string | null; // ISO date string, e.g. "2026-04-07"
  top_tags: string[];            // project tags from the registry
}

export interface TaxonomyTotals {
  projects: number;
  sessions: number;
  notes: number;
  chunks: number;
}

export interface TaxonomyRecentActivity {
  project_slug: string;
  action: string;
  timestamp: string; // ISO date string
}

export interface TaxonomyResult {
  projects: TaxonomyProject[];
  totals: TaxonomyTotals;
  recent_activity: TaxonomyRecentActivity[];
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface TaxonomyOptions {
  /** Include archived projects. Default: false. */
  include_archived?: boolean;
  /** Maximum projects to return. Default: 50. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Build a taxonomy of stored memory — what projects exist, how much is stored,
 * and what has been active recently.
 *
 * Registry queries (projects, sessions) are synchronous (better-sqlite3).
 * Storage backend queries (files, chunks) are async.
 */
export async function getTaxonomy(
  registryDb: Database,
  storage: StorageBackend,
  options: TaxonomyOptions = {}
): Promise<TaxonomyResult> {
  const includeArchived = options.include_archived ?? false;
  const limit = options.limit ?? 50;

  // -------------------------------------------------------------------------
  // 1. Load all (active) projects from the registry
  // -------------------------------------------------------------------------

  const statusFilter = includeArchived
    ? "status IN ('active', 'archived', 'migrating')"
    : "status = 'active'";

  const projectRows = registryDb
    .prepare(
      `SELECT id, slug, display_name, status, created_at, updated_at
       FROM projects
       WHERE ${statusFilter}
       ORDER BY updated_at DESC
       LIMIT ?`
    )
    .all(limit) as Array<{
    id: number;
    slug: string;
    display_name: string;
    status: string;
    created_at: number;
    updated_at: number;
  }>;

  if (projectRows.length === 0) {
    return {
      projects: [],
      totals: { projects: 0, sessions: 0, notes: 0, chunks: 0 },
      recent_activity: [],
    };
  }

  const projectIds = projectRows.map((p) => p.id);

  // -------------------------------------------------------------------------
  // 2. Session counts per project (registry, synchronous)
  // -------------------------------------------------------------------------

  const sessionCountsByProject = new Map<number, number>();
  const lastSessionDateByProject = new Map<number, string | null>();

  for (const projectId of projectIds) {
    const countRow = registryDb
      .prepare("SELECT COUNT(*) AS n FROM sessions WHERE project_id = ?")
      .get(projectId) as { n: number };
    sessionCountsByProject.set(projectId, countRow.n);

    const lastRow = registryDb
      .prepare(
        "SELECT date FROM sessions WHERE project_id = ? ORDER BY number DESC LIMIT 1"
      )
      .get(projectId) as { date: string } | undefined;
    lastSessionDateByProject.set(projectId, lastRow?.date ?? null);
  }

  // -------------------------------------------------------------------------
  // 3. Tags per project (registry, synchronous)
  // -------------------------------------------------------------------------

  const tagsByProject = new Map<number, string[]>();

  for (const projectId of projectIds) {
    const tags = registryDb
      .prepare(
        `SELECT t.name
         FROM tags t
         JOIN project_tags pt ON pt.tag_id = t.id
         WHERE pt.project_id = ?
         ORDER BY t.name`
      )
      .all(projectId) as Array<{ name: string }>;
    tagsByProject.set(projectId, tags.map((t) => t.name));
  }

  // -------------------------------------------------------------------------
  // 4. Note and chunk counts per project (storage backend, async)
  //    We use memory_files for note count (one row per indexed file) and
  //    memory_chunks for chunk count (may be many per file).
  //    The StorageBackend interface exposes getStats() for totals but not
  //    per-project breakdowns, so we cast to the raw DB when it is SQLite
  //    and fall back to a single getStats() call for Postgres.
  // -------------------------------------------------------------------------

  const noteCountsByProject = new Map<number, number>();
  const chunkCountsByProject = new Map<number, number>();

  const isBackend = (x: StorageBackend): boolean => x.backendType === "sqlite";

  if (isBackend(storage)) {
    // SQLite: access raw DB via the getRawDb() escape hatch present on SQLiteBackend.
    // We reach through the interface via a duck-type check — getRawDb is not on the
    // interface but is documented as an escape hatch for exactly this kind of work.
    const rawDb = (storage as unknown as { getRawDb?: () => Database }).getRawDb?.();
    if (rawDb) {
      for (const projectId of projectIds) {
        const noteRow = rawDb
          .prepare(
            "SELECT COUNT(*) AS n FROM memory_files WHERE project_id = ?"
          )
          .get(projectId) as { n: number };
        noteCountsByProject.set(projectId, noteRow.n);

        const chunkRow = rawDb
          .prepare(
            "SELECT COUNT(*) AS n FROM memory_chunks WHERE project_id = ?"
          )
          .get(projectId) as { n: number };
        chunkCountsByProject.set(projectId, chunkRow.n);
      }
    }
  } else {
    // Postgres: the storage backend interface does not expose per-project file/chunk
    // counts, so we leave them as 0 — totals are still reported via getStats().
    // Future: add per-project getStats(projectId?) to the interface if needed.
    for (const projectId of projectIds) {
      noteCountsByProject.set(projectId, 0);
      chunkCountsByProject.set(projectId, 0);
    }
  }

  // -------------------------------------------------------------------------
  // 5. Global totals
  // -------------------------------------------------------------------------

  const stats = await storage.getStats();

  const totalProjects = (
    registryDb
      .prepare(
        `SELECT COUNT(*) AS n FROM projects WHERE ${statusFilter}`
      )
      .get() as { n: number }
  ).n;

  const totalSessions = (
    registryDb.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }
  ).n;

  // -------------------------------------------------------------------------
  // 6. Recent activity — last 10 sessions across all projects
  // -------------------------------------------------------------------------

  const recentSessions = registryDb
    .prepare(
      `SELECT s.date, s.title, p.slug
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
       WHERE p.${statusFilter.replace("status", "p.status")}
       ORDER BY s.created_at DESC
       LIMIT 10`
    )
    .all() as Array<{ date: string; title: string; slug: string }>;

  const recentActivity: TaxonomyRecentActivity[] = recentSessions.map((row) => ({
    project_slug: row.slug,
    action: `session: ${row.title || "(untitled)"}`,
    timestamp: row.date,
  }));

  // -------------------------------------------------------------------------
  // 7. Assemble result
  // -------------------------------------------------------------------------

  const projects: TaxonomyProject[] = projectRows.map((row) => ({
    slug: row.slug,
    display_name: row.display_name,
    session_count: sessionCountsByProject.get(row.id) ?? 0,
    note_count: noteCountsByProject.get(row.id) ?? 0,
    last_activity: lastSessionDateByProject.get(row.id) ?? null,
    top_tags: tagsByProject.get(row.id) ?? [],
  }));

  return {
    projects,
    totals: {
      projects: totalProjects,
      sessions: totalSessions,
      notes: stats.files,
      chunks: stats.chunks,
    },
    recent_activity: recentActivity,
  };
}
