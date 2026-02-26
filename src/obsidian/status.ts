/**
 * obsidian/status.ts — Vault health checking for PAI Phase 4
 *
 * Vault structure (per project):
 *
 *   {vault}/{slug}/           — real directory
 *     notes    → {root}/Notes/                       (project root notes, optional)
 *     sessions → ~/.claude/projects/{enc}/Notes/     (Claude Code session notes, optional)
 */

import type { Database } from "better-sqlite3";
import { existsSync, readdirSync, lstatSync, readlinkSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProjectRow {
  id: number;
  slug: string;
  display_name: string;
  root_path: string;
  status: string;
  claude_notes_dir: string | null;
  obsidian_link: string | null;
}

export interface SymlinkHealth {
  slug: string;
  linkPath: string;
  target: string | null;
  state: "healthy" | "broken" | "orphaned" | "missing";
  notes: string;
}

export interface VaultHealthReport {
  vaultPath: string;
  healthy: SymlinkHealth[];
  broken: SymlinkHealth[];
  orphaned: SymlinkHealth[];
  missing: SymlinkHealth[];
  totalProjects: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check the health of a sub-symlink inside a project directory.
 * Returns true if the symlink exists and its target exists on disk.
 */
function subSymlinkHealthy(dir: string, name: string): boolean {
  const linkPath = join(dir, name);
  try {
    const stat = lstatSync(linkPath);
    if (!stat.isSymbolicLink()) return false;
    const target = readlinkSync(linkPath);
    return existsSync(target);
  } catch {
    return false;
  }
}

/**
 * Check if a sub-symlink exists (regardless of target validity).
 */
function subSymlinkExists(dir: string, name: string): boolean {
  try {
    lstatSync(join(dir, name));
    return true;
  } catch {
    return false;
  }
}

/**
 * Find a project root Notes dir (checks canonical and .claude/Notes fallback).
 */
function findNotesDir(rootPath: string): string | null {
  const canonical = join(rootPath, "Notes");
  if (existsSync(canonical)) return canonical;
  const alt = join(rootPath, ".claude", "Notes");
  if (existsSync(alt)) return alt;
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check health of the Obsidian vault:
 *
 * Project entries are now real directories with sub-symlinks (`notes`, `sessions`).
 *
 * - healthy:  project dir exists; at least one sub-symlink is present and resolves
 * - broken:   project dir exists but all sub-symlinks have missing targets
 * - orphaned: directory entry in vault has no matching registry project
 * - missing:  active project with at least one Notes source but no vault dir
 */
export function checkHealth(vaultPath: string, db: Database): VaultHealthReport {
  const report: VaultHealthReport = {
    vaultPath,
    healthy: [],
    broken: [],
    orphaned: [],
    missing: [],
    totalProjects: 0,
  };

  if (!existsSync(vaultPath)) {
    return report;
  }

  const projects = db
    .prepare(
      `SELECT id, slug, display_name, root_path, status, claude_notes_dir, obsidian_link
       FROM projects WHERE status = 'active'`
    )
    .all() as ProjectRow[];

  report.totalProjects = projects.length;

  // Build a map of slug → project for quick lookup
  const projectsBySlug = new Map<string, ProjectRow>();
  for (const p of projects) {
    projectsBySlug.set(p.slug, p);
  }

  // Scan vault directory
  const seenSlugs = new Set<string>();
  let entries: string[] = [];
  try {
    entries = readdirSync(vaultPath);
  } catch {
    return report;
  }

  for (const entry of entries) {
    // Skip internal PAI-generated dirs/files
    if (entry.startsWith("_")) continue;

    const fullPath = join(vaultPath, entry);
    let stat;
    try {
      stat = lstatSync(fullPath);
    } catch {
      continue;
    }

    const project = projectsBySlug.get(entry);

    if (stat.isDirectory()) {
      // New-style project directory
      if (!project) {
        // Directory in vault with no matching registry project
        report.orphaned.push({
          slug: entry,
          linkPath: fullPath,
          target: null,
          state: "orphaned",
          notes: "No matching active project in registry (directory)",
        });
        continue;
      }

      seenSlugs.add(entry);

      const notesOk = subSymlinkHealthy(fullPath, "notes");
      const sessionsOk = subSymlinkHealthy(fullPath, "sessions");
      const notesExists = subSymlinkExists(fullPath, "notes");
      const sessionsExists = subSymlinkExists(fullPath, "sessions");

      if (notesOk || sessionsOk) {
        const parts: string[] = [];
        if (notesOk) parts.push("notes");
        if (sessionsOk) parts.push("sessions");
        report.healthy.push({
          slug: entry,
          linkPath: fullPath,
          target: null,
          state: "healthy",
          notes: `Sources: ${parts.join(", ")}`,
        });
      } else {
        // At least one sub-link exists but none resolves
        const broken: string[] = [];
        if (notesExists) broken.push("notes");
        if (sessionsExists) broken.push("sessions");
        report.broken.push({
          slug: entry,
          linkPath: fullPath,
          target: null,
          state: "broken",
          notes: `Broken sub-symlinks: ${broken.join(", ") || "(empty directory)"}`,
        });
      }
    } else if (stat.isSymbolicLink()) {
      // Legacy flat symlink — treat same as before
      let target: string | null = null;
      try {
        target = readlinkSync(fullPath);
      } catch {
        // Can't read symlink
      }

      const targetExists = target !== null && existsSync(target);

      if (!project) {
        report.orphaned.push({
          slug: entry,
          linkPath: fullPath,
          target,
          state: "orphaned",
          notes: "No matching active project in registry (legacy symlink)",
        });
        continue;
      }

      seenSlugs.add(entry);

      if (targetExists) {
        report.healthy.push({
          slug: entry,
          linkPath: fullPath,
          target,
          state: "healthy",
          notes: "(legacy flat symlink — run sync to upgrade)",
        });
      } else {
        report.broken.push({
          slug: entry,
          linkPath: fullPath,
          target,
          state: "broken",
          notes: `Target missing: ${target ?? "(unknown)"}`,
        });
      }
    }
    // Non-symlink, non-directory entries are ignored (e.g. stray files)
  }

  // Find active projects with Notes/ dirs that have no vault entry
  for (const project of projects) {
    if (seenSlugs.has(project.slug)) continue;

    const notesCanonical = join(project.root_path, "Notes");
    const notesAlt = join(project.root_path, ".claude", "Notes");
    const hasProjectNotes = existsSync(notesCanonical) || existsSync(notesAlt);
    const hasClaudeNotes =
      project.claude_notes_dir !== null && existsSync(project.claude_notes_dir);

    if (hasProjectNotes || hasClaudeNotes) {
      const sources: string[] = [];
      if (hasProjectNotes) sources.push("notes");
      if (hasClaudeNotes) sources.push("sessions");
      report.missing.push({
        slug: project.slug,
        linkPath: join(vaultPath, project.slug),
        target: null,
        state: "missing",
        notes: `Has sources (${sources.join(", ")}) but no vault entry — run 'pai obsidian sync'`,
      });
    }
  }

  return report;
}
