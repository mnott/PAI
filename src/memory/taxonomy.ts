/**
 * getTaxonomy — returns the shape of stored memory without requiring a query.
 *
 * Answers "what do I know about?" not "what do I know about X?"
 *
 * Uses the registry DB (projects, sessions) and the storage backend
 * (memory_files, memory_chunks) to build a structural overview.
 */

import type { StorageBackend } from "../storage/interface.js";
import type { RegistryBackend } from "../storage/registry-interface.js";

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
 * Registry queries (projects, sessions) go through RegistryBackend (async).
 * Storage backend queries (files, chunks) are async.
 */
export async function getTaxonomy(
  registry: RegistryBackend,
  storage: StorageBackend,
  options: TaxonomyOptions = {}
): Promise<TaxonomyResult> {
  const includeArchived = options.include_archived ?? false;
  const limit = options.limit ?? 50;

  // -------------------------------------------------------------------------
  // 1. Load all (active) projects from the registry
  // -------------------------------------------------------------------------

  const projectRows = includeArchived
    ? await registry.listProjects({ orderBy: "updated_desc", limit })
    : await registry.listProjects({ status: "active", orderBy: "updated_desc", limit });

  if (projectRows.length === 0) {
    return {
      projects: [],
      totals: { projects: 0, sessions: 0, notes: 0, chunks: 0 },
      recent_activity: [],
    };
  }

  const projectIds = projectRows.map((p) => p.id);
  const projectIdSet = new Set(projectIds);

  // -------------------------------------------------------------------------
  // 2. Session counts per project (registry, async)
  // -------------------------------------------------------------------------

  const sessionCountsByProject = new Map<number, number>();
  const lastSessionDateByProject = new Map<number, string | null>();

  for (const projectId of projectIds) {
    sessionCountsByProject.set(projectId, await registry.countSessionsForProject(projectId));
    lastSessionDateByProject.set(projectId, await registry.getMostRecentSessionDate(projectId));
  }

  // -------------------------------------------------------------------------
  // 3. Tags per project (registry, async)
  // -------------------------------------------------------------------------

  const tagsByProject = new Map<number, string[]>();

  for (const projectId of projectIds) {
    tagsByProject.set(projectId, await registry.listTagsForProject(projectId));
  }

  // -------------------------------------------------------------------------
  // 4. Note and chunk counts per project (storage backend, async)
  //    memory_files (one row per indexed file) and memory_chunks (many per
  //    file), via StorageBackend.getProjectStats() — same on both backends.
  // -------------------------------------------------------------------------

  const noteCountsByProject = new Map<number, number>();
  const chunkCountsByProject = new Map<number, number>();

  for (const projectId of projectIds) {
    const projectStats = await storage.getProjectStats(projectId);
    noteCountsByProject.set(projectId, projectStats.files);
    chunkCountsByProject.set(projectId, projectStats.chunks);
  }

  // -------------------------------------------------------------------------
  // 5. Global totals
  // -------------------------------------------------------------------------

  const stats = await storage.getStats();

  const totalProjects = includeArchived
    ? await registry.countProjects()
    : await registry.countProjects({ status: "active" });

  // No RegistryBackend method for a global session count (flagged in the
  // report) — approximate as the sum over the projects already fetched
  // above (bounded by `limit`), the closest available without raw SQL.
  const totalSessions = [...sessionCountsByProject.values()].reduce((a, b) => a + b, 0);

  // -------------------------------------------------------------------------
  // 6. Recent activity — last 10 sessions across all (visible) projects
  //    No RegistryBackend method filters sessions by their project's status
  //    directly (flagged in the report) — over-fetch and filter client-side
  //    against the project set already resolved above.
  // -------------------------------------------------------------------------

  const recentSessions = (await registry.listSessions({ limit: Math.max(50, limit) }))
    .filter((s) => projectIdSet.has(s.project_id))
    .slice(0, 10);

  const recentActivity: TaxonomyRecentActivity[] = recentSessions.map((row) => ({
    project_slug: row.project_slug,
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
