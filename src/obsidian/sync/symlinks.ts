/** Symlink management: create, validate, migrate, and clean vault project symlinks. */

import {
  existsSync,
  mkdirSync,
  symlinkSync,
  readdirSync,
  lstatSync,
  unlinkSync,
  readlinkSync,
  writeFileSync,
  rmdirSync,
} from "node:fs";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import type { ProjectRow, SyncStats } from "./types.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Find the project-root Notes directory for a project. */
export function findNotesDir(rootPath: string): string | null {
  const canonical = join(rootPath, "Notes");
  if (existsSync(canonical)) return canonical;
  const alt = join(rootPath, ".claude", "Notes");
  if (existsSync(alt)) return alt;
  return null;
}

/**
 * Find the Claude Code session notes directory from the registry-stored value.
 * Returns null if not set, missing on disk, or identical to notesDir.
 */
export function findClaudeNotesDir(
  claudeNotesDirFromRegistry: string | null,
  notesDir: string | null
): string | null {
  if (!claudeNotesDirFromRegistry) return null;
  if (!existsSync(claudeNotesDirFromRegistry)) return null;
  if (notesDir && claudeNotesDirFromRegistry === notesDir) return null;
  return claudeNotesDirFromRegistry;
}

/** Check whether a path exists via lstat (does not follow symlinks). */
function lstatExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Resolve slug collisions by appending -2, -3, etc. */
export function uniqueSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * Remove broken symlinks from a directory (one level deep).
 * Returns count of entries removed.
 */
export function cleanBrokenSymlinks(dir: string): number {
  let removed = 0;
  if (!existsSync(dir)) return removed;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    try {
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(full);
        if (!existsSync(target)) {
          unlinkSync(full);
          removed++;
        }
      }
    } catch {
      // Skip unreadable entries
    }
  }
  return removed;
}

/**
 * Ensure a sub-symlink inside a project directory is correct.
 * Returns true if a new symlink was created, false otherwise.
 */
export function ensureSubSymlink(
  linkPath: string,
  target: string,
  errors: string[],
  label: string
): boolean {
  if (lstatExists(linkPath)) {
    try {
      const stat = lstatSync(linkPath);
      if (stat.isSymbolicLink()) {
        const current = readlinkSync(linkPath);
        if (current === target) {
          return false; // Already correct
        }
        unlinkSync(linkPath);
      } else {
        errors.push(`${label}: path exists but is not a symlink — skipped`);
        return false;
      }
    } catch (e) {
      errors.push(`${label}: error checking existing path — ${e}`);
      return false;
    }
  }

  try {
    symlinkSync(target, linkPath);
    return true;
  } catch (e) {
    errors.push(`${label}: symlink creation failed — ${e}`);
    return false;
  }
}

/**
 * Migrate a legacy flat symlink at `slugPath` to a real directory.
 * If `slugPath` is already a real directory, this is a no-op.
 * If it is a symlink (legacy), it is removed so mkdirSync can create the dir.
 */
export function migrateToProjectDir(
  slugPath: string,
  errors: string[],
  slug: string
): boolean {
  if (!lstatExists(slugPath)) {
    return true; // Does not exist yet — mkdirSync will create it
  }

  try {
    const stat = lstatSync(slugPath);

    if (stat.isDirectory()) {
      return true; // Already a real directory — nothing to migrate
    }

    if (stat.isSymbolicLink()) {
      unlinkSync(slugPath);
      return true; // Removed old symlink — now ready for mkdirSync
    }

    errors.push(`${slug}: path exists as non-directory, non-symlink — skipped`);
    return false;
  } catch (e) {
    errors.push(`${slug}: error during migration — ${e}`);
    return false;
  }
}

/** Remove a project directory from the vault if it is empty. */
function removeProjectDirIfEmpty(slugPath: string): void {
  try {
    const entries = readdirSync(slugPath);
    if (entries.length === 0) {
      rmdirSync(slugPath);
    }
  } catch {
    // Non-fatal
  }
}

// ---------------------------------------------------------------------------
// Public: syncVault
// ---------------------------------------------------------------------------

/**
 * Sync all active project Notes directories into the Obsidian vault.
 *
 * For each active project with at least one Notes source, creates:
 *   {vault}/{slug}/           — real directory
 *     notes    → {root}/Notes/
 *     sessions → ~/.claude/projects/{enc}/Notes/  (if different)
 *
 * Archived projects get a stub markdown file in {vault}/_archive/.
 */
export function syncVault(vaultPath: string, db: Database): SyncStats {
  const stats: SyncStats = { created: 0, updated: 0, removed: 0, stubbed: 0, errors: [] };

  mkdirSync(vaultPath, { recursive: true });
  stats.removed += cleanBrokenSymlinks(vaultPath);

  const projects = db
    .prepare(
      `SELECT id, slug, display_name, root_path, encoded_dir, status, obsidian_link, claude_notes_dir
       FROM projects
       ORDER BY status ASC, slug ASC`
    )
    .all() as ProjectRow[];

  const takenSlugs = new Set<string>();

  for (const project of projects) {
    if (project.status === "active") {
      const notesDir = findNotesDir(project.root_path);
      const claudeNotesDir = findClaudeNotesDir(project.claude_notes_dir, notesDir);

      if (!notesDir && !claudeNotesDir) {
        continue;
      }

      const slug = uniqueSlug(project.slug, takenSlugs);
      takenSlugs.add(slug);
      const slugPath = join(vaultPath, slug);

      if (!migrateToProjectDir(slugPath, stats.errors, slug)) {
        continue;
      }

      try {
        mkdirSync(slugPath, { recursive: true });
      } catch (e) {
        stats.errors.push(`${slug}: failed to create project directory — ${e}`);
        continue;
      }

      if (notesDir) {
        const notesLink = join(slugPath, "notes");
        const created = ensureSubSymlink(notesLink, notesDir, stats.errors, `${slug}/notes`);
        if (created) stats.created++;
        else stats.updated++;
      }

      if (claudeNotesDir) {
        const sessionsLink = join(slugPath, "sessions");
        const created = ensureSubSymlink(sessionsLink, claudeNotesDir, stats.errors, `${slug}/sessions`);
        if (created) stats.created++;
        else stats.updated++;
      }

      try {
        db.prepare("UPDATE projects SET obsidian_link = ?, updated_at = ? WHERE id = ?").run(
          slugPath,
          Date.now(),
          project.id
        );
      } catch {
        // Non-fatal
      }
    } else if (project.status === "archived") {
      const archiveDir = join(vaultPath, "_archive");
      mkdirSync(archiveDir, { recursive: true });
      const stubPath = join(archiveDir, `${project.slug}.md`);
      if (!existsSync(stubPath)) {
        const content = [
          `# ${project.display_name}`,
          "",
          "> Archived project — no live notes available.",
          "",
          `- **Slug:** ${project.slug}`,
          `- **Root:** ${project.root_path}`,
          "",
        ].join("\n");
        try {
          writeFileSync(stubPath, content, "utf-8");
          stats.stubbed++;
        } catch (e) {
          stats.errors.push(`${project.slug} (archive stub): ${e}`);
        }
      }
    }
  }

  return stats;
}
