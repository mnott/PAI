/**
 * Shared DB helpers, formatting, and path utilities for session sub-commands.
 */

import type { Database } from "better-sqlite3";
import { join } from "node:path";
import { homedir } from "node:os";
import chalk from "chalk";
import { err } from "../../utils.js";
import type { SessionRow, ProjectRow } from "./types.js";

export function getProject(db: Database, slug: string): ProjectRow | undefined {
  return db
    .prepare(
      "SELECT id, slug, display_name, root_path, encoded_dir FROM projects WHERE slug = ?"
    )
    .get(slug) as ProjectRow | undefined;
}

export function statusColor(status: string): string {
  switch (status) {
    case "completed":
      return chalk.green(status);
    case "compacted":
      return chalk.blue(status);
    default:
      return chalk.yellow(status);
  }
}

/** Convert a slug to title-cased display name: "memory-engine" → "Memory Engine" */
export function toTitleCase(slug: string): string {
  return slug
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Notes directory for a project: ~/.claude/projects/<encoded_dir>/Notes/ */
export function getNotesDir(project: ProjectRow): string {
  return join(homedir(), ".claude", "projects", project.encoded_dir, "Notes");
}

/** Format a session filename: number=27, date="2026-02-23" → "0027 - 2026-02-23 - Title.md" */
export function formatFilename(
  number: number,
  date: string,
  titleSlug: string
): string {
  const n = String(number).padStart(4, "0");
  return `${n} - ${date} - ${titleSlug}.md`;
}

/** Resolve a session by project + number or "latest". Exits on failure. */
export function resolveSession(
  db: Database,
  project: ProjectRow,
  numberOrLatest: string
): SessionRow {
  let session: SessionRow | undefined;

  if (numberOrLatest === "latest") {
    session = db
      .prepare(
        "SELECT * FROM sessions WHERE project_id = ? ORDER BY number DESC LIMIT 1"
      )
      .get(project.id) as SessionRow | undefined;
  } else {
    const num = parseInt(numberOrLatest, 10);
    if (isNaN(num)) {
      console.error(err(`Invalid session number: ${numberOrLatest}`));
      process.exit(1);
    }
    session = db
      .prepare("SELECT * FROM sessions WHERE project_id = ? AND number = ?")
      .get(project.id, num) as SessionRow | undefined;
  }

  if (!session) {
    console.error(
      err(`Session ${numberOrLatest} not found in project ${project.slug}`)
    );
    process.exit(1);
  }

  return session;
}

export function upsertTag(db: Database, tagName: string): number {
  db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)").run(tagName);
  const row = db
    .prepare("SELECT id FROM tags WHERE name = ?")
    .get(tagName) as { id: number };
  return row.id;
}

export function getSessionTags(db: Database, sessionId: number): string[] {
  const rows = db
    .prepare(
      `SELECT t.name FROM tags t
       JOIN session_tags st ON st.tag_id = t.id
       WHERE st.session_id = ?
       ORDER BY t.name`
    )
    .all(sessionId) as { name: string }[];
  return rows.map((r) => r.name);
}
