/**
 * pai project <sub-command>
 *
 * add, list, info, archive, unarchive, move, tag, alias, edit,
 * detect, health, consolidate, promote
 */

import type { Command } from "commander";
import type { Database } from "better-sqlite3";
import { existsSync, readdirSync, statSync, mkdirSync, renameSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir as _homedir } from "node:os";
import {
  ok,
  warn,
  err,
  dim,
  bold,
  header,
  slugFromPath,
  encodeDir,
  resolvePath,
  scaffoldProjectDirs,
  renderTable,
  shortenPath,
  fmtDate,
  now,
} from "../utils.js";
import {
  detectProject,
  formatDetection,
  formatDetectionJson,
} from "./detect.js";
import { cmdPromote } from "../../session/promote.js";
import chalk from "chalk";

// ---------------------------------------------------------------------------
// Row types (mirrors the SQLite schema)
// ---------------------------------------------------------------------------

interface ProjectRow {
  id: number;
  slug: string;
  display_name: string;
  root_path: string;
  encoded_dir: string;
  type: string;
  status: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

interface SessionRow {
  id: number;
  project_id: number;
  number: number;
  date: string;
  title: string;
  status: string;
  closed_at: number | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getProject(db: Database, slug: string): ProjectRow | undefined {
  // Check direct slug first, then aliases
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

function requireProject(db: Database, slug: string): ProjectRow {
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
function resolveIdentifier(db: Database, identifier: string): ProjectRow | undefined {
  const num = parseInt(identifier, 10);
  if (!isNaN(num) && num > 0 && String(num) === identifier) {
    const rows = db.prepare(
      "SELECT * FROM projects ORDER BY status ASC, updated_at DESC"
    ).all() as ProjectRow[];
    if (num <= rows.length) return rows[num - 1];
  }
  return getProject(db, identifier);
}

function getProjectTags(db: Database, projectId: number): string[] {
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

function getProjectAliases(db: Database, projectId: number): string[] {
  const rows = db
    .prepare("SELECT alias FROM aliases WHERE project_id = ? ORDER BY alias")
    .all(projectId) as { alias: string }[];
  return rows.map((r) => r.alias);
}

function getSessionCount(db: Database, projectId: number): number {
  const row = db
    .prepare("SELECT COUNT(*) AS cnt FROM sessions WHERE project_id = ?")
    .get(projectId) as { cnt: number };
  return row.cnt;
}

function getLastSessionDate(db: Database, projectId: number): number | null {
  const row = db
    .prepare(
      `SELECT created_at FROM sessions WHERE project_id = ?
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(projectId) as { created_at: number } | undefined;
  return row ? row.created_at : null;
}

function upsertTag(db: Database, tagName: string): number {
  db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)").run(tagName);
  const row = db.prepare("SELECT id FROM tags WHERE name = ?").get(tagName) as {
    id: number;
  };
  return row.id;
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

function cmdAdd(
  db: Database,
  rawPath: string,
  opts: {
    slug?: string;
    type?: string;
    displayName?: string;
  }
): void {
  const rootPath = resolvePath(rawPath);
  const slug = opts.slug ?? slugFromPath(rootPath);
  const encodedDir = encodeDir(rootPath);
  const displayName = opts.displayName ?? slug;
  const type = opts.type ?? "local";

  // Validate type
  const validTypes = ["local", "central", "obsidian-linked", "external"];
  if (!validTypes.includes(type)) {
    console.error(err(`Invalid type "${type}". Valid: ${validTypes.join(", ")}`));
    process.exit(1);
  }

  // Check for duplicate slug
  const existing = db
    .prepare("SELECT id FROM projects WHERE slug = ? OR root_path = ?")
    .get(slug, rootPath);
  if (existing) {
    console.error(err(`Project already registered (slug: ${slug} or path: ${rootPath})`));
    process.exit(1);
  }

  const ts = now();
  db.prepare(
    `INSERT INTO projects
       (slug, display_name, root_path, encoded_dir, type, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`
  ).run(slug, displayName, rootPath, encodedDir, type, ts, ts);

  // Create directory scaffolding
  scaffoldProjectDirs(rootPath);

  console.log(ok(`Project added: ${bold(slug)}`));
  console.log(dim(`  Path:         ${rootPath}`));
  console.log(dim(`  Encoded dir:  ${encodedDir}`));
  console.log(dim(`  Type:         ${type}`));
}

function cmdList(
  db: Database,
  opts: {
    status?: string;
    tag?: string;
    type?: string;
  }
): void {
  let query = `
    SELECT p.*,
      (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id) AS session_count,
      (SELECT MAX(s.created_at) FROM sessions s WHERE s.project_id = p.id) AS last_active
    FROM projects p
  `;
  const params: unknown[] = [];

  const where: string[] = [];
  if (opts.status) {
    where.push("p.status = ?");
    params.push(opts.status);
  }
  if (opts.type) {
    where.push("p.type = ?");
    params.push(opts.type);
  }
  if (opts.tag) {
    where.push(`p.id IN (
      SELECT pt.project_id FROM project_tags pt
      JOIN tags t ON t.id = pt.tag_id WHERE t.name = ?
    )`);
    params.push(opts.tag);
  }

  if (where.length) {
    query += " WHERE " + where.join(" AND ");
  }
  query += " ORDER BY p.status ASC, p.updated_at DESC";

  const rows = db.prepare(query).all(...params) as (ProjectRow & {
    session_count: number;
    last_active: number | null;
  })[];

  if (!rows.length) {
    console.log(warn("No projects found."));
    return;
  }

  const tableRows = rows.map((r, i) => [
    dim(String(i + 1)),
    bold(r.slug),
    dim(shortenPath(r.root_path, 50)),
    r.status === "active" ? chalk.green(r.status) : chalk.yellow(r.status),
    dim(r.type),
    String(r.session_count),
    fmtDate(r.last_active),
  ]);

  console.log(
    renderTable(
      ["#", "Slug", "Path", "Status", "Type", "Sessions", "Last Active"],
      tableRows
    )
  );
  console.log();
  console.log(dim(`  ${rows.length} project(s)`));
}

function cmdInfo(db: Database, identifier: string): void {
  const project = resolveIdentifier(db, identifier) ?? requireProject(db, identifier);
  const tags = getProjectTags(db, project.id);
  const aliases = getProjectAliases(db, project.id);
  const sessionCount = getSessionCount(db, project.id);
  const lastSession = getLastSessionDate(db, project.id);

  const recentSessions = db
    .prepare(
      `SELECT * FROM sessions WHERE project_id = ?
       ORDER BY created_at DESC LIMIT 5`
    )
    .all(project.id) as SessionRow[];

  console.log();
  console.log(header(`  ${project.display_name}`));
  console.log();
  console.log(`  ${bold("Slug:")}         ${project.slug}`);
  console.log(`  ${bold("Path:")}         ${project.root_path}`);
  console.log(`  ${bold("Encoded dir:")}  ${project.encoded_dir}`);
  console.log(`  ${bold("Type:")}         ${project.type}`);
  console.log(
    `  ${bold("Status:")}       ${project.status === "active" ? chalk.green(project.status) : chalk.yellow(project.status)}`
  );
  console.log(
    `  ${bold("Tags:")}         ${tags.length ? tags.map((t) => chalk.cyan(t)).join(", ") : dim("none")}`
  );
  console.log(
    `  ${bold("Aliases:")}      ${aliases.length ? aliases.join(", ") : dim("none")}`
  );
  console.log(`  ${bold("Sessions:")}     ${sessionCount}`);
  console.log(`  ${bold("Last active:")}  ${fmtDate(lastSession)}`);
  console.log(`  ${bold("Created:")}      ${fmtDate(project.created_at)}`);
  if (project.archived_at) {
    console.log(`  ${bold("Archived:")}     ${fmtDate(project.archived_at)}`);
  }

  if (recentSessions.length) {
    console.log();
    console.log(`  ${bold("Recent sessions:")}`);
    const sessionRows = recentSessions.map((s) => [
      dim(`#${s.number}`),
      s.date,
      s.title.length > 50 ? s.title.slice(0, 47) + "..." : s.title,
      s.status === "completed"
        ? chalk.green(s.status)
        : chalk.yellow(s.status),
    ]);
    console.log(
      renderTable(["#", "Date", "Title", "Status"], sessionRows)
        .split("\n")
        .map((l) => "  " + l)
        .join("\n")
    );
  }
  console.log();
}

function cmdArchive(db: Database, slug: string): void {
  const project = requireProject(db, slug);
  if (project.status === "archived") {
    console.log(warn(`Project ${slug} is already archived.`));
    return;
  }
  const ts = now();
  db.prepare(
    "UPDATE projects SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?"
  ).run(ts, ts, project.id);
  console.log(ok(`Archived: ${bold(slug)}`));
}

function cmdUnarchive(db: Database, slug: string): void {
  const project = requireProject(db, slug);
  if (project.status !== "archived") {
    console.log(warn(`Project ${slug} is not archived (status: ${project.status}).`));
    return;
  }
  const ts = now();
  db.prepare(
    "UPDATE projects SET status = 'active', archived_at = NULL, updated_at = ? WHERE id = ?"
  ).run(ts, project.id);
  console.log(ok(`Unarchived: ${bold(slug)}`));
}

function cmdMove(db: Database, slug: string, newPath: string): void {
  const project = requireProject(db, slug);
  const resolvedNew = resolvePath(newPath);
  const newEncoded = encodeDir(resolvedNew);
  const ts = now();

  db.prepare(
    "UPDATE projects SET root_path = ?, encoded_dir = ?, updated_at = ? WHERE id = ?"
  ).run(resolvedNew, newEncoded, ts, project.id);

  console.log(ok(`Moved: ${bold(slug)}`));
  console.log(dim(`  Old path: ${project.root_path}`));
  console.log(dim(`  New path: ${resolvedNew}`));
}

function cmdTag(db: Database, slug: string, tags: string[]): void {
  const project = requireProject(db, slug);

  const added: string[] = [];
  const skipped: string[] = [];

  for (const tagName of tags) {
    const tagId = upsertTag(db, tagName);
    const exists = db
      .prepare(
        "SELECT 1 FROM project_tags WHERE project_id = ? AND tag_id = ?"
      )
      .get(project.id, tagId);
    if (exists) {
      skipped.push(tagName);
    } else {
      db.prepare(
        "INSERT INTO project_tags (project_id, tag_id) VALUES (?, ?)"
      ).run(project.id, tagId);
      added.push(tagName);
    }
  }

  if (added.length) {
    console.log(ok(`Tagged ${bold(slug)}: ${added.map((t) => chalk.cyan(t)).join(", ")}`));
  }
  if (skipped.length) {
    console.log(dim(`  Already present: ${skipped.join(", ")}`));
  }
}

function cmdAlias(db: Database, slug: string, alias: string): void {
  requireProject(db, slug);

  // Make sure alias isn't already a slug for another project
  const conflict = db
    .prepare("SELECT id FROM projects WHERE slug = ?")
    .get(alias);
  if (conflict) {
    console.error(err(`"${alias}" is already a project slug — cannot use as alias.`));
    process.exit(1);
  }

  const project = getProject(db, slug)!;
  try {
    db.prepare(
      "INSERT INTO aliases (alias, project_id) VALUES (?, ?)"
    ).run(alias, project.id);
    console.log(ok(`Alias added: ${bold(alias)} → ${slug}`));
  } catch {
    console.error(err(`Alias "${alias}" is already registered.`));
    process.exit(1);
  }
}

function cmdEdit(
  db: Database,
  slug: string,
  opts: { displayName?: string; type?: string }
): void {
  const project = requireProject(db, slug);

  if (!opts.displayName && !opts.type) {
    console.log(warn("Nothing to update. Use --display-name or --type."));
    return;
  }

  const validTypes = ["local", "central", "obsidian-linked", "external"];
  if (opts.type && !validTypes.includes(opts.type)) {
    console.error(err(`Invalid type "${opts.type}". Valid: ${validTypes.join(", ")}`));
    process.exit(1);
  }

  const ts = now();
  if (opts.displayName) {
    db.prepare(
      "UPDATE projects SET display_name = ?, updated_at = ? WHERE id = ?"
    ).run(opts.displayName, ts, project.id);
    console.log(ok(`Display name updated: ${bold(opts.displayName)}`));
  }
  if (opts.type) {
    db.prepare(
      "UPDATE projects SET type = ?, updated_at = ? WHERE id = ?"
    ).run(opts.type, ts, project.id);
    console.log(ok(`Type updated: ${bold(opts.type)}`));
  }
}

// ---------------------------------------------------------------------------
// Health command
// ---------------------------------------------------------------------------

interface HealthRow extends ProjectRow {
  session_count: number;
}

type HealthCategory = "active" | "stale" | "dead";

interface ProjectHealth {
  project: HealthRow;
  category: HealthCategory;
  /** For stale: a similar directory found on disk near the recorded path */
  suggestedPath?: string;
  claudeNotesExists: boolean;
  orphanedNotesDirs: string[];
}

/**
 * Find Claude project dirs (~/.claude/projects/) that look like they belong
 * to a project based on encoded_dir prefix matching.
 */
function findOrphanedNotesDirs(project: ProjectRow): string[] {
  const claudeProjects = join(_homedir(), ".claude", "projects");
  if (!existsSync(claudeProjects)) return [];

  const expected = encodeDir(project.root_path);
  const results: string[] = [];

  try {
    for (const entry of readdirSync(claudeProjects)) {
      const full = join(claudeProjects, entry);
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      // Look for encoded dirs that match this project's encoded_dir
      if (entry === expected || entry === project.encoded_dir) {
        const notesDir = join(full, "Notes");
        if (existsSync(notesDir)) {
          results.push(notesDir);
        }
      }
    }
  } catch {
    // Unreadable — ignore
  }
  return results;
}

/**
 * Try to find a moved project by looking for a directory with the same name
 * as the last path component in common nearby locations.
 */
function suggestMovedPath(project: ProjectRow): string | undefined {
  const name = basename(project.root_path);
  // Common parent patterns to check
  const candidates = [
    join(_homedir(), "dev", name),
    join(_homedir(), "dev", "ai", name),
    join(_homedir(), "Desktop", name),
    join(_homedir(), "Projects", name),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return undefined;
}

function cmdHealth(
  db: Database,
  opts: { fix?: boolean; json?: boolean; status?: string }
): void {
  const rows = db
    .prepare(
      `SELECT p.*,
         (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id) AS session_count
       FROM projects p
       ORDER BY p.status ASC, p.updated_at DESC`
    )
    .all() as HealthRow[];

  const results: ProjectHealth[] = rows.map((project) => {
    const pathExists = existsSync(project.root_path);
    const orphaned = findOrphanedNotesDirs(project);

    let category: HealthCategory;
    let suggestedPath: string | undefined;

    if (pathExists) {
      category = "active";
    } else {
      suggestedPath = suggestMovedPath(project);
      category = suggestedPath ? "stale" : "dead";
    }

    const claudeNotesExists = orphaned.length > 0;

    return {
      project,
      category,
      suggestedPath,
      claudeNotesExists,
      orphanedNotesDirs: orphaned,
    };
  });

  // Filter by status if requested
  const filtered =
    opts.status
      ? results.filter((r) => r.category === opts.status)
      : results;

  if (opts.json) {
    console.log(
      JSON.stringify(
        filtered.map((r) => ({
          slug: r.project.slug,
          root_path: r.project.root_path,
          status: r.project.status,
          health: r.category,
          session_count: r.project.session_count,
          suggested_path: r.suggestedPath ?? null,
          claude_notes_exists: r.claudeNotesExists,
          orphaned_notes_dirs: r.orphanedNotesDirs,
        })),
        null,
        2
      )
    );
    return;
  }

  // Human-readable output
  const active = filtered.filter((r) => r.category === "active");
  const stale = filtered.filter((r) => r.category === "stale");
  const dead = filtered.filter((r) => r.category === "dead");

  console.log();
  console.log(header("  PAI Project Health Report"));
  console.log();
  console.log(
    `  ${chalk.green("Active:")} ${active.length}   ${chalk.yellow("Stale (moved?):")} ${stale.length}   ${chalk.red("Dead (missing):")} ${dead.length}`
  );
  console.log();

  if (active.length) {
    console.log(bold("  Active projects (path exists):"));
    const tableRows = active.map((r) => [
      bold(r.project.slug),
      dim(shortenPath(r.project.root_path, 50)),
      String(r.project.session_count),
      r.claudeNotesExists ? chalk.green("yes") : dim("no"),
    ]);
    console.log(
      renderTable(
        ["Slug", "Path", "Sessions", "Claude Notes"],
        tableRows
      )
        .split("\n")
        .map((l) => "  " + l)
        .join("\n")
    );
    console.log();
  }

  if (stale.length) {
    console.log(warn("  Stale projects (path missing, possible new location found):"));
    for (const r of stale) {
      console.log(`    ${bold(r.project.slug)}`);
      console.log(dim(`      Old path:   ${r.project.root_path}`));
      console.log(chalk.cyan(`      Found at:   ${r.suggestedPath}`));
      if (r.claudeNotesExists) {
        console.log(chalk.green(`      Notes:      ${r.orphanedNotesDirs.join(", ")}`));
      }
      if (opts.fix && r.suggestedPath) {
        const ts = now();
        const newEncoded = encodeDir(r.suggestedPath);
        db.prepare(
          "UPDATE projects SET root_path = ?, encoded_dir = ?, updated_at = ? WHERE id = ?"
        ).run(r.suggestedPath, newEncoded, ts, r.project.id);
        console.log(ok(`      Auto-fixed: updated path to ${r.suggestedPath}`));
      } else if (r.suggestedPath) {
        console.log(dim(`      Fix:        pai project move ${r.project.slug} ${r.suggestedPath}`));
      }
    }
    console.log();
  }

  if (dead.length) {
    console.log(err("  Dead projects (path missing, no match found):"));
    for (const r of dead) {
      console.log(`    ${bold(r.project.slug)}   ${dim(r.project.root_path)}`);
      if (r.claudeNotesExists) {
        console.log(
          chalk.yellow(`      Notes:  ${r.orphanedNotesDirs.join(", ")}`)
        );
      }
      if (r.project.session_count === 0 && opts.fix) {
        db.prepare(
          "UPDATE projects SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?"
        ).run(now(), now(), r.project.id);
        console.log(ok("      Auto-fixed: archived (0 sessions, path gone)"));
      } else {
        console.log(
          dim(
            `      Fix:    pai project archive ${r.project.slug}  (or  pai project move ...)`
          )
        );
      }
    }
    console.log();
  }

  const summary = `  ${rows.length} total: ${active.length} active, ${stale.length} stale, ${dead.length} dead`;
  console.log(dim(summary));

  if (!opts.fix && (stale.length > 0 || dead.length > 0)) {
    console.log();
    console.log(warn("  Run with --fix to auto-remediate where possible."));
  }
}

// ---------------------------------------------------------------------------
// Detect command
// ---------------------------------------------------------------------------

function cmdDetect(
  db: Database,
  pathArg: string | undefined,
  opts: { json?: boolean }
): void {
  const cwd = pathArg ? resolvePath(pathArg) : process.cwd();
  const detection = detectProject(db, cwd);

  if (!detection) {
    if (opts.json) {
      console.log(JSON.stringify({ error: "no_match", cwd }, null, 2));
    } else {
      console.log(warn(`No registered project found for: ${cwd}`));
      console.log(dim("  Run 'pai project add .' to register this directory."));
    }
    process.exit(0);
    return;
  }

  if (opts.json) {
    console.log(formatDetectionJson(detection));
    return;
  }

  console.log();
  console.log(header("  Project Detection Result"));
  console.log();
  console.log(
    formatDetection(detection)
      .split("\n")
      .map((l) => "  " + l)
      .join("\n")
  );
  console.log();
}

// ---------------------------------------------------------------------------
// Consolidate command
// ---------------------------------------------------------------------------

/**
 * Find all ~/.claude/projects/ encoded dirs whose name encodes to a path
 * that is a child-of or exact-match of the given project's root_path.
 */
function findProjectNotesDirs(project: ProjectRow): {
  encodedDir: string;
  fullPath: string;
  notesPath: string;
  noteCount: number;
}[] {
  const claudeProjects = join(_homedir(), ".claude", "projects");
  if (!existsSync(claudeProjects)) return [];

  const results: { encodedDir: string; fullPath: string; notesPath: string; noteCount: number }[] = [];
  const rootEncoded = encodeDir(project.root_path);

  try {
    for (const entry of readdirSync(claudeProjects)) {
      const full = join(claudeProjects, entry);
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }

      // Match exact or child (child encoded dirs start with project's encoded prefix)
      if (entry !== rootEncoded && !entry.startsWith(rootEncoded)) continue;

      const notesPath = join(full, "Notes");
      if (!existsSync(notesPath)) continue;

      let noteCount = 0;
      try {
        noteCount = readdirSync(notesPath).filter(
          (f) => f.endsWith(".md") || f.endsWith(".txt")
        ).length;
      } catch {
        // count stays 0
      }

      results.push({ encodedDir: entry, fullPath: full, notesPath, noteCount });
    }
  } catch {
    // Unreadable — ignore
  }

  return results;
}

function cmdConsolidate(
  db: Database,
  identifier: string,
  opts: { yes?: boolean; dryRun?: boolean }
): void {
  const project = resolveIdentifier(db, identifier) ?? requireProject(db, identifier);

  console.log();
  console.log(header(`  Consolidate: ${project.slug}`));
  console.log(`  Target:  ${project.root_path}`);
  console.log();

  const dirs = findProjectNotesDirs(project);

  if (dirs.length === 0) {
    console.log(warn("  No scattered notes directories found for this project."));
    return;
  }

  // Canonical notes location
  const canonicalNotes = join(project.root_path, "Notes");

  // Show what would be consolidated
  const toMerge = dirs.filter((d) => d.notesPath !== canonicalNotes);

  if (toMerge.length === 0) {
    console.log(ok("  All notes are already in the canonical location."));
    console.log(dim(`  ${canonicalNotes}`));
    return;
  }

  console.log(`  Found ${toMerge.length} scattered Notes directory(ies) to consolidate:`);
  console.log();

  for (const d of toMerge) {
    console.log(`    ${bold(d.encodedDir)}`);
    console.log(dim(`      Notes: ${d.notesPath} (${d.noteCount} file(s))`));
  }

  console.log();
  console.log(`  Destination: ${canonicalNotes}`);
  console.log();

  if (opts.dryRun) {
    console.log(warn("  Dry run — no changes made. Remove --dry-run to proceed."));
    return;
  }

  if (!opts.yes) {
    console.log(
      warn(
        "  Run with --yes to perform consolidation, or --dry-run to preview changes."
      )
    );
    return;
  }

  // Create canonical Notes dir
  mkdirSync(canonicalNotes, { recursive: true });

  let movedCount = 0;
  for (const d of toMerge) {
    try {
      const files = readdirSync(d.notesPath);
      for (const f of files) {
        if (!f.endsWith(".md") && !f.endsWith(".txt")) continue;
        const src = join(d.notesPath, f);
        const dest = join(canonicalNotes, f);
        if (!existsSync(dest)) {
          renameSync(src, dest);
          console.log(ok(`    Moved: ${f}`));
          movedCount++;
        } else {
          console.log(warn(`    Skipped (exists): ${f}`));
        }
      }
    } catch (e) {
      console.error(err(`    Error reading ${d.notesPath}: ${e}`));
    }
  }

  console.log();
  console.log(ok(`  Consolidated ${movedCount} file(s) into ${canonicalNotes}`));
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

export function registerProjectCommands(
  projectCmd: Command,
  getDb: () => Database
): void {
  // pai project add <path>
  projectCmd
    .command("add <path>")
    .description("Register a project directory in the PAI registry")
    .option("--slug <slug>", "Override auto-generated slug")
    .option(
      "--type <type>",
      "Project type: local | central | obsidian-linked | external",
      "local"
    )
    .option("--display-name <name>", "Human-readable display name")
    .action((rawPath: string, opts: { slug?: string; type?: string; displayName?: string }) => {
      cmdAdd(getDb(), rawPath, opts);
    });

  // pai project list
  projectCmd
    .command("list")
    .description("List registered projects")
    .option("--status <status>", "Filter by status: active | archived")
    .option("--tag <tag>", "Filter by tag")
    .option("--type <type>", "Filter by type")
    .action((opts: { status?: string; tag?: string; type?: string }) => {
      cmdList(getDb(), opts);
    });

  // pai project info <slug>
  projectCmd
    .command("info <slug>")
    .description("Show full details for a project")
    .action((slug: string) => {
      cmdInfo(getDb(), slug);
    });

  // pai project archive <slug>
  projectCmd
    .command("archive <slug>")
    .description("Archive a project")
    .action((slug: string) => {
      cmdArchive(getDb(), slug);
    });

  // pai project unarchive <slug>
  projectCmd
    .command("unarchive <slug>")
    .description("Restore an archived project to active status")
    .action((slug: string) => {
      cmdUnarchive(getDb(), slug);
    });

  // pai project move <slug> <new-path>
  projectCmd
    .command("move <slug> <new-path>")
    .description("Update the root path for a project")
    .action((slug: string, newPath: string) => {
      cmdMove(getDb(), slug, newPath);
    });

  // pai project tag <slug> <tags...>
  projectCmd
    .command("tag <slug> <tags...>")
    .description("Add one or more tags to a project")
    .action((slug: string, tags: string[]) => {
      cmdTag(getDb(), slug, tags);
    });

  // pai project alias <slug> <alias>
  projectCmd
    .command("alias <slug> <alias>")
    .description("Register an alternative slug for a project")
    .action((slug: string, alias: string) => {
      cmdAlias(getDb(), slug, alias);
    });

  // pai project edit <slug>
  projectCmd
    .command("edit <slug>")
    .description("Edit project metadata")
    .option("--display-name <name>", "New display name")
    .option("--type <type>", "New type")
    .action((slug: string, opts: { displayName?: string; type?: string }) => {
      cmdEdit(getDb(), slug, opts);
    });

  // pai project cd <slug-or-number>
  projectCmd
    .command("cd <identifier>")
    .description("Print the root path for a project (use with: cd $(pai project cd <id>))")
    .action((identifier: string) => {
      const project = resolveIdentifier(getDb(), identifier);
      if (!project) {
        console.error(`Project not found: ${identifier}`);
        process.exit(1);
      }
      process.stdout.write(project.root_path + "\n");
    });

  // pai project detect [path]
  projectCmd
    .command("detect [path]")
    .description(
      "Detect which registered project the given path (or CWD) belongs to"
    )
    .option("--json", "Output raw JSON instead of human-readable text")
    .action((pathArg: string | undefined, opts: { json?: boolean }) => {
      cmdDetect(getDb(), pathArg, opts);
    });

  // pai project health
  projectCmd
    .command("health")
    .description(
      "Audit all registered projects: check which paths still exist, find moved/dead projects"
    )
    .option(
      "--fix",
      "Auto-remediate where possible (update moved paths, archive dead zero-session projects)"
    )
    .option("--json", "Output raw JSON report")
    .option(
      "--status <category>",
      "Filter output to: active | stale | dead"
    )
    .action(
      (opts: { fix?: boolean; json?: boolean; status?: string }) => {
        cmdHealth(getDb(), opts);
      }
    );

  // pai project consolidate <slug-or-number>
  projectCmd
    .command("consolidate <identifier>")
    .description(
      "Consolidate scattered ~/.claude/projects/.../Notes/ directories for a project into its canonical Notes/ location"
    )
    .option("--yes", "Perform consolidation without confirmation prompt")
    .option("--dry-run", "Preview what would be moved without making changes")
    .action(
      (
        identifier: string,
        opts: { yes?: boolean; dryRun?: boolean }
      ) => {
        cmdConsolidate(getDb(), identifier, opts);
      }
    );

  // pai project promote
  projectCmd
    .command("promote")
    .description("Promote a session note into a new standalone project")
    .requiredOption("--from-session <path>", "Path to the session note markdown file")
    .requiredOption("--to <path>", "Directory path for the new project (must not exist)")
    .option("--name <name>", "Display name for the new project (derived from filename if omitted)")
    .action((opts: { fromSession: string; to: string; name?: string }) => {
      cmdPromote(getDb(), opts);
    });
}
