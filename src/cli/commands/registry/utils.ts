/** Shared database helpers for registry command operations. */

import type { Database } from "better-sqlite3";
import { now } from "../../utils.js";

/**
 * Upsert a project row. Returns { id, isNew }.
 *
 * Matching priority:
 *  1. root_path  — most reliable; handles slug collisions
 *  2. encoded_dir — Claude project dirs are canonical
 *  3. Insert with suffix-deduplication on slug collision
 */
export function upsertProject(
  db: Database,
  slug: string,
  rootPath: string,
  encodedDir: string
): { id: number; isNew: boolean } {
  const ts = now();

  const byPath = db
    .prepare("SELECT id FROM projects WHERE root_path = ?")
    .get(rootPath) as { id: number } | undefined;

  if (byPath) {
    const encodedOwner = db
      .prepare("SELECT id FROM projects WHERE encoded_dir = ?")
      .get(encodedDir) as { id: number } | undefined;

    if (!encodedOwner || encodedOwner.id === byPath.id) {
      db.prepare(
        "UPDATE projects SET encoded_dir = ?, updated_at = ? WHERE id = ?"
      ).run(encodedDir, ts, byPath.id);
    }
    return { id: byPath.id, isNew: false };
  }

  const byEncoded = db
    .prepare("SELECT id FROM projects WHERE encoded_dir = ?")
    .get(encodedDir) as { id: number } | undefined;

  if (byEncoded) {
    const pathOwner = db
      .prepare("SELECT id FROM projects WHERE root_path = ?")
      .get(rootPath) as { id: number } | undefined;

    if (!pathOwner || pathOwner.id === byEncoded.id) {
      db.prepare(
        "UPDATE projects SET root_path = ?, updated_at = ? WHERE id = ?"
      ).run(rootPath, ts, byEncoded.id);
    }
    return { id: byEncoded.id, isNew: false };
  }

  // Insert — deduplicate slug with numeric suffix if needed.
  let finalSlug = slug;
  let attempt = 0;
  while (true) {
    const conflict = db
      .prepare("SELECT id FROM projects WHERE slug = ?")
      .get(finalSlug) as { id: number } | undefined;
    if (!conflict) break;
    attempt++;
    finalSlug = `${slug}-${attempt}`;
  }

  const result = db
    .prepare(
      `INSERT OR IGNORE INTO projects
         (slug, display_name, root_path, encoded_dir, type, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'local', 'active', ?, ?)`
    )
    .run(finalSlug, finalSlug, rootPath, encodedDir, ts, ts);

  if (result.changes === 0) {
    const fallback =
      (db.prepare("SELECT id FROM projects WHERE encoded_dir = ?").get(encodedDir) as { id: number } | undefined) ??
      (db.prepare("SELECT id FROM projects WHERE root_path = ?").get(rootPath) as { id: number } | undefined);

    if (fallback) {
      return { id: fallback.id, isNew: false };
    }

    throw new Error(
      `upsertProject: INSERT OR IGNORE was suppressed but no matching row found ` +
      `for root_path=${rootPath} encoded_dir=${encodedDir}`
    );
  }

  return { id: result.lastInsertRowid as number, isNew: true };
}

/** Upsert a session note. Returns true if newly inserted. */
export function upsertSession(
  db: Database,
  projectId: number,
  number: number,
  date: string,
  slug: string,
  title: string,
  filename: string
): boolean {
  const existing = db
    .prepare("SELECT id FROM sessions WHERE project_id = ? AND number = ?")
    .get(projectId, number);

  if (existing) return false;

  const ts = now();
  db.prepare(
    `INSERT INTO sessions
       (project_id, number, date, slug, title, filename, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'completed', ?)`
  ).run(projectId, number, date, slug, title, filename, ts);

  return true;
}
