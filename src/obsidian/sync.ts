/**
 * obsidian/sync.ts — Core vault synchronisation for PAI Phase 4
 *
 * Functions:
 *  - syncVault(vaultPath, db)          — symlink project Notes/ dirs into vault
 *  - generateIndex(vaultPath, db)      — write _index.md with project table
 *  - generateTopicPages(vaultPath, db) — write _topics/{tag}.md pages
 *  - defaultVaultPath()                — ~/.pai/obsidian-vault
 *
 * Vault structure (per project):
 *
 *   {vault}/{slug}/          ← real directory
 *     notes    → {root}/Notes/                           (project root notes, if any)
 *     sessions → ~/.claude/projects/{encoded}/Notes/     (Claude Code session notes, if any)
 *
 * Both sub-symlinks are optional; projects with only one source get only that link.
 * Archived projects get a stub .md file in {vault}/_archive/.
 */

import type { Database } from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  symlinkSync,
  readdirSync,
  lstatSync,
  unlinkSync,
  readlinkSync,
  writeFileSync,
  readFileSync,
  rmdirSync,
} from "node:fs";
import { join, relative, dirname } from "node:path";
import { homedir } from "node:os";
import { fmtDate } from "../cli/utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProjectRow {
  id: number;
  slug: string;
  display_name: string;
  root_path: string;
  encoded_dir: string;
  status: string;
  obsidian_link: string | null;
  claude_notes_dir: string | null;
}

interface SessionStats {
  session_count: number;
  last_active: number | null;
}

interface TagRow {
  name: string;
}

export interface SyncStats {
  created: number;
  updated: number;
  removed: number;
  stubbed: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Find the project-root Notes directory for a project.
 * Checks canonical location first, then .claude/Notes.
 */
function findNotesDir(rootPath: string): string | null {
  const canonical = join(rootPath, "Notes");
  if (existsSync(canonical)) return canonical;
  const alt = join(rootPath, ".claude", "Notes");
  if (existsSync(alt)) return alt;
  return null;
}

/**
 * Find the Claude Code session notes directory from the registry-stored value.
 * Returns null if not set or does not exist on disk.
 * Skips the dir if it is identical to the project-root notesDir (avoids double-linking).
 */
function findClaudeNotesDir(
  claudeNotesDirFromRegistry: string | null,
  notesDir: string | null
): string | null {
  if (!claudeNotesDirFromRegistry) return null;
  if (!existsSync(claudeNotesDirFromRegistry)) return null;
  // Avoid creating a duplicate link when claude_notes_dir IS the project notes dir
  if (notesDir && claudeNotesDirFromRegistry === notesDir) return null;
  return claudeNotesDirFromRegistry;
}

/**
 * Check whether a path exists via lstat (does not follow symlinks).
 */
function lstatExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve slug collisions by appending -2, -3, etc.
 */
function uniqueSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * Remove broken symlinks from a directory (one level deep).
 * Returns count of entries removed.
 */
function cleanBrokenSymlinks(dir: string): number {
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
 *
 * If the symlink already points to the right target, nothing changes.
 * If it points somewhere else, it is removed and recreated.
 * If the path is a non-symlink, it is left alone (data-loss prevention).
 *
 * @returns true if a new symlink was created, false otherwise.
 */
function ensureSubSymlink(
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
        // Real file or dir at this path — skip to avoid data loss
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
 *
 * The old structure was:  {vault}/{slug} → {notesDir}
 * The new structure is:   {vault}/{slug}/            (real dir)
 *                           notes    → {notesDir}
 *                           sessions → {claudeNotesDir}
 *
 * If `slugPath` is already a real directory, this is a no-op.
 * If it is a symlink (legacy), it is removed so `mkdirSync` can create the dir.
 */
function migrateToProjectDir(
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

    // Some other filesystem object (file, etc.) — cannot proceed
    errors.push(`${slug}: path exists as non-directory, non-symlink — skipped`);
    return false;
  } catch (e) {
    errors.push(`${slug}: error during migration — ${e}`);
    return false;
  }
}

/**
 * Remove a project directory from the vault if it is empty (all sub-symlinks gone).
 * Silently ignores errors (non-fatal cleanup).
 */
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
// Public API
// ---------------------------------------------------------------------------

/**
 * Sync all active project Notes directories into the Obsidian vault.
 *
 * For each active project that has at least one Notes source, creates:
 *
 *   {vault}/{slug}/           — real directory
 *     notes    → {root}/Notes/                       (if project root Notes exists)
 *     sessions → ~/.claude/projects/{enc}/Notes/     (if Claude Code session notes exist)
 *
 * Projects with neither source are skipped.
 * Archived projects get a stub markdown file in {vault}/_archive/.
 */
export function syncVault(vaultPath: string, db: Database): SyncStats {
  const stats: SyncStats = { created: 0, updated: 0, removed: 0, stubbed: 0, errors: [] };

  // Ensure vault root exists
  mkdirSync(vaultPath, { recursive: true });

  // Clean up broken symlinks at the vault root level (handles any leftover flat symlinks
  // that are now broken, e.g. from deleted projects or moved notes dirs)
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

      // Skip projects with no notes sources at all
      if (!notesDir && !claudeNotesDir) {
        continue;
      }

      const slug = uniqueSlug(project.slug, takenSlugs);
      takenSlugs.add(slug);
      const slugPath = join(vaultPath, slug);

      // Migrate from legacy flat symlink to real directory
      if (!migrateToProjectDir(slugPath, stats.errors, slug)) {
        continue;
      }

      // Ensure the project directory exists
      try {
        mkdirSync(slugPath, { recursive: true });
      } catch (e) {
        stats.errors.push(`${slug}: failed to create project directory — ${e}`);
        continue;
      }

      // Create/verify the `notes` sub-symlink
      if (notesDir) {
        const notesLink = join(slugPath, "notes");
        const created = ensureSubSymlink(notesLink, notesDir, stats.errors, `${slug}/notes`);
        if (created) {
          stats.created++;
        } else {
          stats.updated++;
        }
      }

      // Create/verify the `sessions` sub-symlink
      if (claudeNotesDir) {
        const sessionsLink = join(slugPath, "sessions");
        const created = ensureSubSymlink(
          sessionsLink,
          claudeNotesDir,
          stats.errors,
          `${slug}/sessions`
        );
        if (created) {
          stats.created++;
        } else {
          stats.updated++;
        }
      }

      // Update obsidian_link in registry to point to the project directory
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
      // Write stub file in _archive/
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

/**
 * Generate _index.md listing all projects with session counts, tags, and
 * indicators for which note sources are available (notes, sessions, or both).
 */
export function generateIndex(vaultPath: string, db: Database): void {
  mkdirSync(vaultPath, { recursive: true });

  const rows = db
    .prepare(
      `SELECT p.id, p.slug, p.display_name, p.status, p.root_path,
         p.encoded_dir, p.claude_notes_dir,
         (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id) AS session_count,
         (SELECT MAX(s.created_at) FROM sessions s WHERE s.project_id = p.id) AS last_active
       FROM projects p
       ORDER BY p.status ASC, p.updated_at DESC`
    )
    .all() as (ProjectRow & SessionStats)[];

  const getTagsForProject = db.prepare(
    `SELECT t.name FROM tags t
     JOIN project_tags pt ON pt.tag_id = t.id
     WHERE pt.project_id = ?
     ORDER BY t.name`
  );

  const active = rows.filter((r) => r.status === "active");
  const archived = rows.filter((r) => r.status !== "active");

  const lines: string[] = [
    "# PAI Project Index",
    "",
    `> Auto-generated by PAI Knowledge OS — ${new Date().toISOString()}`,
    "",
    "## Active Projects",
    "",
    "| Project | Sessions | Last Active | Sources | Tags |",
    "| ------- | -------- | ----------- | ------- | ---- |",
  ];

  for (const row of active) {
    const tags = (getTagsForProject.all(row.id) as TagRow[]).map((t) => `\`${t.name}\``).join(" ");
    const lastActive = fmtDate(row.last_active);

    // Determine which note sources are available
    const notesDir = findNotesDir(row.root_path);
    const claudeNotesDir = findClaudeNotesDir(row.claude_notes_dir, notesDir);
    const sources: string[] = [];
    if (notesDir) sources.push("notes");
    if (claudeNotesDir) sources.push("sessions");
    const sourcesLabel = sources.length > 0 ? sources.join(", ") : "—";

    lines.push(
      `| [[${row.slug}/|${row.display_name}]] | ${row.session_count} | ${lastActive} | ${sourcesLabel} | ${tags || "—"} |`
    );
  }

  if (archived.length > 0) {
    lines.push(
      "",
      "## Archived Projects",
      "",
      "| Project | Sessions | Tags |",
      "| ------- | -------- | ---- |"
    );
    for (const row of archived) {
      const tags = (getTagsForProject.all(row.id) as TagRow[]).map((t) => `\`${t.name}\``).join(" ");
      lines.push(
        `| [${row.display_name}](_archive/${row.slug}.md) | ${row.session_count} | ${tags || "—"} |`
      );
    }
  }

  lines.push(
    "",
    "---",
    `*${rows.length} projects total — ${active.length} active, ${archived.length} archived*`
  );

  writeFileSync(join(vaultPath, "_index.md"), lines.join("\n") + "\n", "utf-8");
}

/**
 * Generate per-tag topic pages at _topics/{tag}.md.
 * Returns count of pages written.
 */
export function generateTopicPages(vaultPath: string, db: Database): number {
  const topicsDir = join(vaultPath, "_topics");
  mkdirSync(topicsDir, { recursive: true });

  const allTags = db
    .prepare("SELECT id, name FROM tags ORDER BY name")
    .all() as { id: number; name: string }[];

  const getProjectsForTag = db.prepare(
    `SELECT p.id, p.slug, p.display_name, p.status,
       (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id) AS session_count,
       (SELECT MAX(s.created_at) FROM sessions s WHERE s.project_id = p.id) AS last_active
     FROM projects p
     JOIN project_tags pt ON pt.project_id = p.id
     WHERE pt.tag_id = ?
     ORDER BY p.status ASC, p.updated_at DESC`
  );

  let written = 0;
  for (const tag of allTags) {
    const projects = getProjectsForTag.all(tag.id) as (ProjectRow & SessionStats)[];
    if (!projects.length) continue;

    const lines: string[] = [
      `# Topic: ${tag.name}`,
      "",
      `> Auto-generated by PAI Knowledge OS — ${new Date().toISOString()}`,
      "",
      "## Projects",
      "",
      "| Project | Status | Sessions | Last Active |",
      "| ------- | ------ | -------- | ----------- |",
    ];

    for (const p of projects) {
      const link =
        p.status === "active"
          ? `[[${p.slug}/|${p.display_name}]]`
          : `[${p.display_name}](../_archive/${p.slug}.md)`;
      lines.push(`| ${link} | ${p.status} | ${p.session_count} | ${fmtDate(p.last_active)} |`);
    }

    lines.push("", "---", `*${projects.length} project(s) tagged \`${tag.name}\`*`);

    writeFileSync(join(topicsDir, `${tag.name}.md`), lines.join("\n") + "\n", "utf-8");
    written++;
  }

  return written;
}

/**
 * Default vault path: ~/.pai/obsidian-vault
 */
export function defaultVaultPath(): string {
  return join(homedir(), ".pai", "obsidian-vault");
}

// ---------------------------------------------------------------------------
// Master notes generation
// ---------------------------------------------------------------------------

interface SessionFile {
  /** Absolute path on disk (inside the symlink target, resolved). */
  absPath: string;
  /** Relative path from the vault project dir (e.g. "notes/2026/02/0001 - ..."). */
  vaultRelPath: string;
  /** Wikilink target — relative to the vault project dir, no .md extension. */
  wikilinkTarget: string;
  /** YYYY/MM extracted from path or filename. */
  yearMonth: string;
  /** Basename without .md. */
  basename: string;
}

const SESSION_FILENAME_RE = /^(\d{4}) - (\d{4}-\d{2})-\d{2} - .+\.md$/;

/** Build the per-project master note filename. */
function masterFilename(slug: string): string {
  return `_${slug}-master.md`;
}

/**
 * Walk a directory (non-recursive, then one level of YYYY/MM subdirs).
 * Returns absolute paths to all .md files found.
 */
function walkNotesDir(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    // Skip any master note file (pattern: _{slug}-master.md or legacy _master.md)
    if (entry === "_master.md" || /^_[^/]+-master\.md$/.test(entry)) continue;
    const full = join(dir, entry);
    let stat: ReturnType<typeof lstatSync>;
    try {
      // Use stat (follow symlinks) for the dir check
      stat = lstatSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      // Expect YYYY/MM pattern
      if (/^\d{4}$/.test(entry)) {
        // Year directory — go one deeper
        let monthEntries: string[];
        try {
          monthEntries = readdirSync(full);
        } catch {
          continue;
        }
        for (const month of monthEntries) {
          const monthPath = join(full, month);
          if (/^\d{2}$/.test(month) && existsSync(monthPath)) {
            let monthFiles: string[];
            try {
              monthFiles = readdirSync(monthPath);
            } catch {
              continue;
            }
            for (const f of monthFiles) {
              if (f.endsWith(".md") && !f.startsWith(".")) {
                results.push(join(monthPath, f));
              }
            }
          }
        }
      }
    } else if (entry.endsWith(".md")) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Extract YYYY/MM from a session file path.
 * Tries the path first (looks for /YYYY/MM/ pattern), then falls back to filename date.
 */
function extractYearMonth(filePath: string): string {
  const pathMatch = filePath.match(/\/(\d{4})\/(\d{2})\//);
  if (pathMatch) return `${pathMatch[1]}/${pathMatch[2]}`;

  const basename = filePath.split("/").pop() ?? "";
  const nameMatch = basename.match(/^\d{4} - (\d{4})-(\d{2})-\d{2}/);
  if (nameMatch) return `${nameMatch[1]}/${nameMatch[2]}`;

  return "unknown";
}

/**
 * Remove any old/broken backlink footer from a session file.
 * Matches the old [[../_master|...]] pattern as well as any [[_{slug}-master|...]] footer.
 * Returns true if the file was modified.
 */
function removeOldBacklink(filePath: string): boolean {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return false;
  }
  // Remove old broken pattern: \n---\n[[../_master|...]]
  const oldPattern = /\n---\n\[\[\.\.\/[^\]]+\]\]\n?$/;
  // Remove any existing PAI-generated master footer (new or old slug)
  const newPattern = /\n---\n\[\[_[^\]]*-master\|[^\]]*\]\]\n?$/;
  const cleaned = content.replace(oldPattern, "").replace(newPattern, "");
  if (cleaned === content) return false;
  try {
    writeFileSync(filePath, cleaned, "utf-8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Append the master note backlink footer to a session file, idempotently.
 * Uses Obsidian filename-based wikilink (resolves from anywhere in the vault).
 * Only writes if the sentinel string is not already present in the file.
 */
function appendBacklinkIfMissing(
  filePath: string,
  slug: string,
  displayName: string
): boolean {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return false;
  }
  const masterName = masterFilename(slug).replace(/\.md$/, "");
  const sentinel = `[[${masterName}|`;
  if (content.includes(sentinel)) return false;

  const footer = `\n---\n[[${masterName}|← ${displayName} Master]]\n`;
  try {
    writeFileSync(filePath, content + footer, "utf-8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate _master.md files for projects that have enough sessions.
 *
 * For each project directory in the vault that has >= threshold session files,
 * writes a {vaultPath}/{slug}/_master.md containing:
 *   - Project title
 *   - Session count + date range
 *   - Sessions grouped by YYYY/MM with Obsidian [[wikilinks]]
 *
 * Also appends a backlink footer to each session file (idempotently).
 *
 * @param vaultPath  Absolute path to the PAI Obsidian vault
 * @param db         Registry SQLite database
 * @param threshold  Minimum session count to generate a master note (default: 5)
 * @returns          Number of master notes written
 */
export function generateMasterNotes(
  vaultPath: string,
  db: Database,
  threshold = 5
): number {
  if (!existsSync(vaultPath)) return 0;

  const projects = db
    .prepare(
      `SELECT id, slug, display_name, root_path, encoded_dir, status, obsidian_link, claude_notes_dir
       FROM projects
       WHERE status = 'active'
       ORDER BY slug ASC`
    )
    .all() as ProjectRow[];

  let written = 0;

  for (const project of projects) {
    const slugPath = join(vaultPath, project.slug);
    if (!existsSync(slugPath)) continue;

    // Remove legacy _master.md if it exists (replaced by _{slug}-master.md)
    const legacyMaster = join(slugPath, "_master.md");
    if (existsSync(legacyMaster)) {
      try {
        unlinkSync(legacyMaster);
      } catch {
        // Non-fatal — leave it if we can't delete it
      }
    }

    // Collect all session .md files from both symlink sources
    const sessionFiles: SessionFile[] = [];

    // Sub-dirs to scan: "notes" and "sessions" symlinks inside the project dir
    const subLinks = ["notes", "sessions"];
    for (const subLink of subLinks) {
      const linkPath = join(slugPath, subLink);
      if (!existsSync(linkPath)) continue;

      // Resolve symlink target to get real path
      let realDir: string;
      try {
        const stat = lstatSync(linkPath);
        if (stat.isSymbolicLink()) {
          realDir = readlinkSync(linkPath);
        } else if (stat.isDirectory()) {
          realDir = linkPath;
        } else {
          continue;
        }
      } catch {
        continue;
      }

      const files = walkNotesDir(realDir);
      for (const absPath of files) {
        const basename = absPath.split("/").pop() ?? "";
        if (!SESSION_FILENAME_RE.test(basename)) continue;

        // Build the vault-relative wikilink path
        // The file lives under realDir; the link is at slugPath/subLink
        const relFromReal = relative(realDir, absPath);
        const vaultRelPath = `${subLink}/${relFromReal}`;
        // Wikilink: strip .md extension, use path relative to project dir
        const wikilinkTarget = vaultRelPath.replace(/\.md$/, "");

        sessionFiles.push({
          absPath,
          vaultRelPath,
          wikilinkTarget,
          yearMonth: extractYearMonth(absPath),
          basename: basename.replace(/\.md$/, ""),
        });
      }
    }

    if (sessionFiles.length < threshold) continue;

    // Sort by yearMonth then basename (filename order within month)
    sessionFiles.sort((a, b) => {
      if (a.yearMonth !== b.yearMonth) return a.yearMonth.localeCompare(b.yearMonth);
      return a.basename.localeCompare(b.basename);
    });

    // Group by yearMonth
    const byMonth = new Map<string, SessionFile[]>();
    for (const sf of sessionFiles) {
      if (!byMonth.has(sf.yearMonth)) byMonth.set(sf.yearMonth, []);
      byMonth.get(sf.yearMonth)!.push(sf);
    }

    // Determine date range
    const firstDate = sessionFiles[0]?.basename.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "unknown";
    const lastDate =
      sessionFiles[sessionFiles.length - 1]?.basename.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "unknown";

    // Build master note content
    const lines: string[] = [
      `# Project: ${project.display_name}`,
      "",
      `> Auto-generated by PAI Knowledge OS — ${new Date().toISOString()}`,
      "",
      "## Overview",
      "",
      `- **Sessions:** ${sessionFiles.length}`,
      `- **Date range:** ${firstDate} to ${lastDate}`,
      `- **Tags:** #${project.slug} #project`,
      "",
      "## Sessions by Month",
      "",
    ];

    for (const [ym, files] of byMonth) {
      lines.push(`### ${ym}`, "");
      for (const sf of files) {
        lines.push(`- [[${sf.wikilinkTarget}|${sf.basename}]]`);
      }
      lines.push("");
    }

    lines.push("## Topics", "", `#${project.slug} #project`, "");

    const masterPath = join(slugPath, masterFilename(project.slug));
    try {
      writeFileSync(masterPath, lines.join("\n"), "utf-8");
      written++;
    } catch {
      continue;
    }

    // Remove old broken backlinks, then append correct ones (idempotent)
    for (const sf of sessionFiles) {
      removeOldBacklink(sf.absPath);
      appendBacklinkIfMissing(sf.absPath, project.slug, project.display_name);
    }
  }

  return written;
}

// ---------------------------------------------------------------------------
// Fix session tags
// ---------------------------------------------------------------------------

/**
 * Remove the generic #Session tag from session note files across all projects.
 *
 * Session notes are written with `**Tags:** #Session ...` but the generic #Session
 * tag is not useful — each note already belongs to a project. This function scans
 * all session and notes directories for every active project and removes #Session
 * (with or without a trailing space) from any `**Tags:**` line.
 *
 * The project-specific tags that follow #Session are preserved untouched.
 *
 * @param db  Registry SQLite database
 * @returns   Object with counts: { filesScanned, filesModified, errors }
 */
export function fixSessionTags(
  db: Database
): { filesScanned: number; filesModified: number; errors: string[] } {
  const results = { filesScanned: 0, filesModified: 0, errors: [] as string[] };

  const projects = db
    .prepare(
      `SELECT id, slug, display_name, root_path, encoded_dir, status, obsidian_link, claude_notes_dir
       FROM projects
       WHERE status = 'active'
       ORDER BY slug ASC`
    )
    .all() as ProjectRow[];

  for (const project of projects) {
    // Collect all directories to scan for this project
    const dirsToScan: string[] = [];

    const notesDir = findNotesDir(project.root_path);
    if (notesDir) dirsToScan.push(notesDir);

    if (
      project.claude_notes_dir &&
      existsSync(project.claude_notes_dir) &&
      project.claude_notes_dir !== notesDir
    ) {
      dirsToScan.push(project.claude_notes_dir);
    }

    for (const dir of dirsToScan) {
      const files = walkNotesDir(dir);
      for (const filePath of files) {
        results.filesScanned++;
        let content: string;
        try {
          content = readFileSync(filePath, "utf-8");
        } catch (e) {
          results.errors.push(`${filePath}: read error — ${e}`);
          continue;
        }

        if (!content.includes("#Session")) continue;

        // Remove #Session followed by optional space on any **Tags:** line
        const updated = content.replace(
          /(\*\*Tags:\*\*[^\n]*)#Session ?/g,
          "$1"
        );

        if (updated === content) continue;

        // Clean up trailing whitespace on Tags lines that may be left empty
        const cleaned = updated.replace(/(\*\*Tags:\*\*) *\n/g, "$1\n");

        try {
          writeFileSync(filePath, cleaned, "utf-8");
          results.filesModified++;
        } catch (e) {
          results.errors.push(`${filePath}: write error — ${e}`);
        }
      }
    }
  }

  return results;
}
