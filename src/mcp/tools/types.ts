/**
 * Shared types and project-row helpers used across all MCP tool handler modules.
 */

import { resolve } from "node:path";
import type { Database } from "better-sqlite3";

export interface ToolContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Shared row type — mirrors the projects SQLite schema
// ---------------------------------------------------------------------------

export interface ProjectRow {
  id: number;
  slug: string;
  display_name: string;
  root_path: string;
  type: string;
  status: string;
  created_at: number;
  updated_at: number;
  archived_at?: number | null;
  parent_id?: number | null;
  obsidian_link?: string | null;
}

// ---------------------------------------------------------------------------
// Helper: lookup project_id by slug (also checks aliases)
// ---------------------------------------------------------------------------

export function lookupProjectId(
  registryDb: Database,
  slug: string
): number | null {
  const bySlug = registryDb
    .prepare("SELECT id FROM projects WHERE slug = ?")
    .get(slug) as { id: number } | undefined;
  if (bySlug) return bySlug.id;

  const byAlias = registryDb
    .prepare("SELECT project_id FROM aliases WHERE alias = ?")
    .get(slug) as { project_id: number } | undefined;
  if (byAlias) return byAlias.project_id;

  return null;
}

// ---------------------------------------------------------------------------
// Helper: detect project from a filesystem path
// ---------------------------------------------------------------------------

export function detectProjectFromPath(
  registryDb: Database,
  fsPath: string
): ProjectRow | null {
  const resolved = resolve(fsPath);

  const exact = registryDb
    .prepare(
      "SELECT id, slug, display_name, root_path, type, status, created_at, updated_at FROM projects WHERE root_path = ?"
    )
    .get(resolved) as ProjectRow | undefined;

  if (exact) return exact;

  const all = registryDb
    .prepare(
      "SELECT id, slug, display_name, root_path, type, status, created_at, updated_at FROM projects ORDER BY LENGTH(root_path) DESC"
    )
    .all() as ProjectRow[];

  for (const project of all) {
    if (
      resolved.startsWith(project.root_path + "/") ||
      resolved === project.root_path
    ) {
      return project;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helper: format project row for tool output
// ---------------------------------------------------------------------------

export function formatProject(registryDb: Database, project: ProjectRow): string {
  const sessionCount = (
    registryDb
      .prepare("SELECT COUNT(*) AS n FROM sessions WHERE project_id = ?")
      .get(project.id) as { n: number }
  ).n;

  const lastSession = registryDb
    .prepare(
      "SELECT date FROM sessions WHERE project_id = ? ORDER BY date DESC LIMIT 1"
    )
    .get(project.id) as { date: string } | undefined;

  const tags = (
    registryDb
      .prepare(
        `SELECT t.name FROM tags t
         JOIN project_tags pt ON pt.tag_id = t.id
         WHERE pt.project_id = ?
         ORDER BY t.name`
      )
      .all(project.id) as Array<{ name: string }>
  ).map((r) => r.name);

  const aliases = (
    registryDb
      .prepare("SELECT alias FROM aliases WHERE project_id = ? ORDER BY alias")
      .all(project.id) as Array<{ alias: string }>
  ).map((r) => r.alias);

  const lines: string[] = [
    `slug: ${project.slug}`,
    `display_name: ${project.display_name}`,
    `root_path: ${project.root_path}`,
    `type: ${project.type}`,
    `status: ${project.status}`,
    `sessions: ${sessionCount}`,
  ];

  if (lastSession) lines.push(`last_session: ${lastSession.date}`);
  if (tags.length) lines.push(`tags: ${tags.join(", ")}`);
  if (aliases.length) lines.push(`aliases: ${aliases.join(", ")}`);
  if (project.obsidian_link) lines.push(`obsidian_link: ${project.obsidian_link}`);
  if (project.archived_at) {
    lines.push(
      `archived_at: ${new Date(project.archived_at).toISOString().slice(0, 10)}`
    );
  }

  return lines.join("\n");
}
