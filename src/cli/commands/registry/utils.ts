/** Shared database helpers for registry command operations. */

import type { Database } from "better-sqlite3";
import { now } from "../../utils.js";
import { basename, join } from "node:path";
import { transcriptFiles, claudeProjectsDir } from "../../../registry/moved.js";

/**
 * Would writing this encoded_dir replace a working one with a broken one?
 *
 * `encodeDir` is lossy: `~` and emoji do not survive it, so a value derived
 * from a project's path can name a folder Claude Code never created. Every
 * caller here derives its value that way, and this function is the single
 * point they all pass through.
 *
 * `pai registry reconnect` repairs those by reading the cwd recorded inside the
 * transcripts. Without this check the next scan silently reverts the repair —
 * and it reverts it in the most confusing possible way, because a read taken
 * straight after the repair still shows it. Observed twice on 2026-08-02:
 * three projects reconnected, verified, and rediscovered as broken within the
 * hour, with the repair command reporting success both times.
 *
 * Permits the write when the new value resolves to transcripts, or when the
 * existing one resolves to nothing — i.e. whenever it cannot make things worse.
 */
function worthWriting(db: Database, projectId: number, encodedDir: string): boolean {
  if (transcriptFiles(join(claudeProjectsDir(), encodedDir)).length > 0) return true;

  const row = db
    .prepare("SELECT encoded_dir FROM projects WHERE id = ?")
    .get(projectId) as { encoded_dir: string | null } | undefined;

  const current = row?.encoded_dir;
  if (!current) return true;

  return transcriptFiles(join(claudeProjectsDir(), current)).length === 0;
}

/**
 * Upsert a project row. Returns { id, isNew }.
 *
 * Matching priority:
 *  1. root_path  — most reliable; handles slug collisions
 *  2. encoded_dir — Claude project dirs are canonical
 *  3. Insert with suffix-deduplication on slug collision
 *
 * display_name is set to basename(rootPath) on INSERT so that the unified
 * listing always shows a human-readable name rather than the kebab-case slug.
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

    if (
      (!encodedOwner || encodedOwner.id === byPath.id) &&
      worthWriting(db, byPath.id, encodedDir)
    ) {
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

  // Use basename(rootPath) as the human display name. If rootPath is empty or
  // just "/" fall back to the slug so we always have something non-empty.
  const displayName = basename(rootPath) || finalSlug;

  const result = db
    .prepare(
      `INSERT OR IGNORE INTO projects
         (slug, display_name, root_path, encoded_dir, type, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'local', 'active', ?, ?)`
    )
    .run(finalSlug, displayName, rootPath, encodedDir, ts, ts);

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
