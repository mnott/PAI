/**
 * tunnels.ts — cross-project concept detection ("palace graph / tunnel detection")
 *
 * A "tunnel" is a concept (word or short phrase) that appears in chunks from
 * at least two distinct projects.  These serendipitous cross-project connections
 * are surfaced so the user can discover unexpected relationships between their
 * work streams.
 *
 * The actual SQL (SQLite FTS5 vocab / Postgres ts_stat) lives under
 * src/storage/{sqlite,postgres}/tunnels.ts, reached through
 * StorageBackend.findTunnels() — this module just re-exports the public
 * types and forwards the call, so existing callers (MCP tools) don't have
 * to change their import path.
 */

import type { StorageBackend } from "../storage/interface.js";
import type { RegistryBackend } from "../storage/registry-interface.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface Tunnel {
  /** The shared term or phrase. */
  concept: string;
  /** Project slugs where this concept appears. */
  projects: string[];
  /** Total chunk occurrences across all projects. */
  occurrences: number;
  /** First time the concept appeared (Unix ms). */
  first_seen: number;
  /** Most recent time the concept appeared (Unix ms). */
  last_seen: number;
}

export interface FindTunnelsOptions {
  /** Minimum distinct projects a concept must appear in. Default 2. */
  min_projects?: number;
  /** Minimum total chunk occurrences across all projects. Default 3. */
  min_occurrences?: number;
  /** Maximum number of tunnels to return. Default 20. */
  limit?: number;
}

export interface FindTunnelsResult {
  tunnels: Tunnel[];
  projects_analyzed: number;
  total_concepts_evaluated: number;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Find cross-project concept tunnels.
 *
 * Works with both SQLite and Postgres storage backends.
 * Requires the RegistryBackend for project slug resolution.
 *
 * @param backend        Active PAI storage backend.
 * @param registry       Registry backend for project slug resolution.
 * @param options        Filter and limit options.
 */
export async function findTunnels(
  backend: StorageBackend,
  registry: RegistryBackend,
  options?: FindTunnelsOptions
): Promise<FindTunnelsResult> {
  return backend.findTunnels(registry, options);
}

// ---------------------------------------------------------------------------
// Helpers shared by the SQLite and Postgres tunnel finders
// ---------------------------------------------------------------------------

/** Fill option defaults and map active project ids to slugs. */
export async function resolveTunnelInputs(
  registry: RegistryBackend,
  options?: FindTunnelsOptions
): Promise<{ opts: Required<FindTunnelsOptions>; slugMap: Record<number, string> }> {
  const opts: Required<FindTunnelsOptions> = {
    min_projects: options?.min_projects ?? 2,
    min_occurrences: options?.min_occurrences ?? 3,
    limit: options?.limit ?? 20,
  };
  const slugMap: Record<number, string> = {};
  for (const { id, slug } of await registry.listProjects({ excludeArchived: true })) {
    slugMap[id] = slug;
  }
  return { opts, slugMap };
}

/** Order tunnels by project spread then occurrences and cut to the limit. */
export function rankTunnels(
  tunnels: Tunnel[],
  projectCount: number,
  conceptsEvaluated: number,
  limit: number
): FindTunnelsResult {
  tunnels.sort((a, b) => {
    const byProjects = b.projects.length - a.projects.length;
    if (byProjects !== 0) return byProjects;
    return b.occurrences - a.occurrences;
  });
  return {
    tunnels: tunnels.slice(0, limit),
    projects_analyzed: projectCount,
    total_concepts_evaluated: conceptsEvaluated,
  };
}
