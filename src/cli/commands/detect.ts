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

import { resolve } from "node:path";
import { getRegistryBackend } from "../../storage/factory.js";

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

// ---------------------------------------------------------------------------
// Core detection function
// ---------------------------------------------------------------------------

/**
 * Detect which registered project a filesystem path belongs to.
 *
 * @param cwd  Absolute path to detect (defaults to process.cwd())
 * @returns    The best matching project, or null if no match
 */
export async function detectProject(cwd?: string): Promise<DetectedProject | null> {
  const target = resolve(cwd ?? process.cwd());
  const backend = await getRegistryBackend();

  // Load all active projects ordered by root_path length descending
  // so the longest (most specific) match wins in a linear scan.
  const projects = await backend.listProjectsByPathLengthDesc({ excludeArchived: true });

  let matched: (typeof projects)[number] | null = null;
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
  const sessionCount = await backend.countSessionsForProject(matched.id);
  const lastDate = await backend.getMostRecentSessionDate(matched.id);

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
    session_count: sessionCount,
    last_session_date: lastDate,
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
