/**
 * Shared database helper functions for project sub-commands.
 * All functions accept a Database instance and are pure query wrappers.
 */

import type { Database } from "better-sqlite3";
import type { ProjectRow } from "./types.js";
import { err } from "../../utils.js";

export function getProject(db: Database, slug: string): ProjectRow | undefined {
  const direct = db
    .prepare("SELECT * FROM projects WHERE slug = ?")
    .get(slug) as ProjectRow | undefined;
  if (direct) return direct;

  const alias = db
    .prepare(
      `SELECT p.* FROM projects p
       JOIN aliases a ON a.project_id = p.id
       WHERE a.alias = ?`
    )
    .get(slug) as ProjectRow | undefined;
  return alias;
}

export function requireProject(db: Database, slug: string): ProjectRow {
  const project = getProject(db, slug);
  if (!project) {
    console.error(err(`Project not found: ${slug}`));
    process.exit(1);
  }
  return project;
}

/**
 * Resolve an identifier that may be a list index number or a slug.
 */
export function resolveIdentifier(db: Database, identifier: string): ProjectRow | undefined {
  const num = parseInt(identifier, 10);
  if (!isNaN(num) && num > 0 && String(num) === identifier) {
    const rows = db.prepare(
      "SELECT * FROM projects ORDER BY status ASC, updated_at DESC"
    ).all() as ProjectRow[];
    if (num <= rows.length) return rows[num - 1];
  }
  return getProject(db, identifier);
}

export function getProjectTags(db: Database, projectId: number): string[] {
  const rows = db
    .prepare(
      `SELECT t.name FROM tags t
       JOIN project_tags pt ON pt.tag_id = t.id
       WHERE pt.project_id = ?
       ORDER BY t.name`
    )
    .all(projectId) as { name: string }[];
  return rows.map((r) => r.name);
}

export function getProjectAliases(db: Database, projectId: number): string[] {
  const rows = db
    .prepare("SELECT alias FROM aliases WHERE project_id = ? ORDER BY alias")
    .all(projectId) as { alias: string }[];
  return rows.map((r) => r.alias);
}

export function getSessionCount(db: Database, projectId: number): number {
  const row = db
    .prepare("SELECT COUNT(*) AS cnt FROM sessions WHERE project_id = ?")
    .get(projectId) as { cnt: number };
  return row.cnt;
}

export function getLastSessionDate(db: Database, projectId: number): number | null {
  const row = db
    .prepare(
      `SELECT created_at FROM sessions WHERE project_id = ?
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(projectId) as { created_at: number } | undefined;
  return row ? row.created_at : null;
}

export function upsertTag(db: Database, tagName: string): number {
  db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)").run(tagName);
  const row = db.prepare("SELECT id FROM tags WHERE name = ?").get(tagName) as { id: number };
  return row.id;
}
