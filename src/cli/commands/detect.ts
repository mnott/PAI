/**
 * Project detection logic for PAI.
 *
 * detectProject(cwd) — given a filesystem path, returns the best matching
 * project from the registry:
 *   1. Exact path match
 *   2. Longest parent match (project whose root_path is an ancestor of cwd)
 *
 * Exported for use by the CLI `pai project detect` command and the MCP
 * `project_detect` tool.
 */

import type { Database } from "better-sqlite3";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DetectedProject {
  id: number;
  slug: string;
  display_name: string;
  root_path: string;
  encoded_dir: string;
  type: string;
  status: string;
  session_count: number;
  last_session_date: string | null;
  match_type: "exact" | "parent";
  /** Only set when match_type is 'parent' — the portion of cwd below root_path */
  relative_path: string | null;
}

interface ProjectRow {
  id: number;
  slug: string;
  display_name: string;
  root_path: string;
  encoded_dir: string;
  type: string;
  status: string;
}

// ---------------------------------------------------------------------------
// Core detection function
// ---------------------------------------------------------------------------

/**
 * Detect which registered project a filesystem path belongs to.
 *
 * @param db   Open registry database
 * @param cwd  Absolute path to detect (defaults to process.cwd())
 * @returns    The best matching project, or null if no match
 */
export function detectProject(
  db: Database,
  cwd?: string
): DetectedProject | null {
  const target = resolve(cwd ?? process.cwd());

  // Load all active projects ordered by root_path length descending
  // so the longest (most specific) match wins in a linear scan.
  const projects = db
    .prepare(
      `SELECT id, slug, display_name, root_path, encoded_dir, type, status
       FROM projects
       WHERE status != 'archived'
       ORDER BY LENGTH(root_path) DESC`
    )
    .all() as ProjectRow[];

  let matched: ProjectRow | null = null;
  let matchType: "exact" | "parent" = "exact";

  for (const p of projects) {
    const root = resolve(p.root_path);
    if (target === root) {
      matched = p;
      matchType = "exact";
      break;
    }
    if (!matched && target.startsWith(root + "/")) {
      matched = p;
      matchType = "parent";
      // Keep scanning — a longer root_path match might exist (but shouldn't
      // since we sorted by length desc). Safety break anyway once found.
      break;
    }
  }

  if (!matched) return null;

  // Enrich with session stats
  const sessionStats = db
    .prepare(
      `SELECT COUNT(*) AS cnt, MAX(date) AS last_date
       FROM sessions WHERE project_id = ?`
    )
    .get(matched.id) as { cnt: number; last_date: string | null };

  const relative =
    matchType === "parent"
      ? target.slice(resolve(matched.root_path).length + 1)
      : null;

  return {
    id: matched.id,
    slug: matched.slug,
    display_name: matched.display_name,
    root_path: matched.root_path,
    encoded_dir: matched.encoded_dir,
    type: matched.type,
    status: matched.status,
    session_count: sessionStats.cnt,
    last_session_date: sessionStats.last_date,
    match_type: matchType,
    relative_path: relative,
  };
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

/**
 * Format a DetectedProject for human-readable CLI output.
 */
export function formatDetection(d: DetectedProject): string {
  const lines: string[] = [
    `slug:         ${d.slug}`,
    `display_name: ${d.display_name}`,
    `root_path:    ${d.root_path}`,
    `type:         ${d.type}`,
    `status:       ${d.status}`,
    `match:        ${d.match_type}${d.relative_path ? ` (+${d.relative_path})` : ""}`,
    `sessions:     ${d.session_count}`,
  ];
  if (d.last_session_date) {
    lines.push(`last_session: ${d.last_session_date}`);
  }
  return lines.join("\n");
}

/**
 * Format a DetectedProject as JSON for machine consumption.
 */
export function formatDetectionJson(d: DetectedProject): string {
  return JSON.stringify(
    {
      slug: d.slug,
      display_name: d.display_name,
      root_path: d.root_path,
      encoded_dir: d.encoded_dir,
      type: d.type,
      status: d.status,
      match_type: d.match_type,
      relative_path: d.relative_path,
      session_count: d.session_count,
      last_session_date: d.last_session_date,
    },
    null,
    2
  );
}
