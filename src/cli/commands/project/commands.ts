/**
 * Core project CRUD commands: add, list, info, archive, unarchive, move, tag,
 * alias, edit, detect, consolidate, go — plus private helpers levenshtein,
 * containsIgnoreCase, and findProjectNotesDirs.
 */

import type { Database } from "better-sqlite3";
import {
  existsSync,
  readdirSync,
  statSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import chalk from "chalk";
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
} from "../../utils.js";
import {
  detectProject,
  formatDetection,
  formatDetectionJson,
} from "../detect.js";
import { ensurePaiMarker } from "../../../registry/pai-marker.js";
import type { ProjectRow, SessionRow } from "./types.js";
import {
  requireProject,
  resolveIdentifier,
  getProject,
  getProjectTags,
  getProjectAliases,
  getSessionCount,
  getLastSessionDate,
  upsertTag,
} from "./helpers.js";

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function containsIgnoreCase(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function findProjectNotesDirs(project: ProjectRow): {
  encodedDir: string;
  fullPath: string;
  notesPath: string;
  noteCount: number;
}[] {
  const claudeProjects = join(homedir(), ".claude", "projects");
  if (!existsSync(claudeProjects)) return [];

  const results: {
    encodedDir: string;
    fullPath: string;
    notesPath: string;
    noteCount: number;
  }[] = [];
  const rootEncoded = encodeDir(project.root_path);

  try {
    for (const entry of readdirSync(claudeProjects)) {
      const full = join(claudeProjects, entry);
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }

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

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

export function cmdAdd(
  db: Database,
  rawPath: string,
  opts: { slug?: string; type?: string; displayName?: string }
): void {
  const rootPath = resolvePath(rawPath);
  const slug = opts.slug ?? slugFromPath(rootPath);
  const encodedDir = encodeDir(rootPath);
  const displayName = opts.displayName ?? slug;
  const type = opts.type ?? "local";

  const validTypes = ["local", "central", "obsidian-linked", "external"];
  if (!validTypes.includes(type)) {
    console.error(err(`Invalid type "${type}". Valid: ${validTypes.join(", ")}`));
    process.exit(1);
  }

  const existing = db
    .prepare("SELECT id FROM projects WHERE slug = ? OR root_path = ?")
    .get(slug, rootPath);
  if (existing) {
    console.error(
      err(`Project already registered (slug: ${slug} or path: ${rootPath})`)
    );
    process.exit(1);
  }

  const dirName = basename(rootPath).toLowerCase();
  const similar = db
    .prepare(
      `SELECT slug, root_path FROM projects WHERE status = 'active' AND slug != ?`
    )
    .all(slug) as { slug: string; root_path: string }[];
  const matches = similar.filter(
    (s) =>
      basename(s.root_path).toLowerCase() === dirName ||
      s.slug.replace(/-\d+$/, "") === slug.replace(/-\d+$/, "")
  );
  if (matches.length > 0) {
    console.log(warn(`Similar project(s) already registered:`));
    for (const m of matches) {
      console.log(dim(`  ${bold(m.slug)}  ${shortenPath(m.root_path, 50)}`));
    }
    console.log(
      dim(
        `  Consider: pai project alias ${matches[0].slug} <name> (to link them)`
      )
    );
    console.log(
      dim(`  Or: pai project archive ${slug} (if this is a duplicate)`)
    );
    console.log();
  }

  const ts = now();
  db.prepare(
    `INSERT INTO projects
       (slug, display_name, root_path, encoded_dir, type, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`
  ).run(slug, displayName, rootPath, encodedDir, type, ts, ts);

  scaffoldProjectDirs(rootPath);

  try {
    ensurePaiMarker(rootPath, slug, displayName);
  } catch {
    // Non-fatal — warn but don't fail the add command.
  }

  console.log(ok(`Project added: ${bold(slug)}`));
  console.log(dim(`  Path:         ${rootPath}`));
  console.log(dim(`  Encoded dir:  ${encodedDir}`));
  console.log(dim(`  Type:         ${type}`));
}

export function cmdList(
  db: Database,
  opts: { status?: string; tag?: string; type?: string }
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

  if (where.length) query += " WHERE " + where.join(" AND ");
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

export function cmdInfo(db: Database, identifier: string): void {
  const project =
    resolveIdentifier(db, identifier) ?? requireProject(db, identifier);
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
    `  ${bold("Status:")}       ${
      project.status === "active"
        ? chalk.green(project.status)
        : chalk.yellow(project.status)
    }`
  );
  console.log(
    `  ${bold("Tags:")}         ${
      tags.length ? tags.map((t) => chalk.cyan(t)).join(", ") : dim("none")
    }`
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

export function cmdArchive(db: Database, slug: string): void {
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

export function cmdUnarchive(db: Database, slug: string): void {
  const project = requireProject(db, slug);
  if (project.status !== "archived") {
    console.log(
      warn(`Project ${slug} is not archived (status: ${project.status}).`)
    );
    return;
  }
  const ts = now();
  db.prepare(
    "UPDATE projects SET status = 'active', archived_at = NULL, updated_at = ? WHERE id = ?"
  ).run(ts, project.id);
  console.log(ok(`Unarchived: ${bold(slug)}`));
}

export function cmdMove(db: Database, slug: string, newPath: string): void {
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

export function cmdTag(
  db: Database,
  slug: string,
  tags: string[]
): void {
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
    console.log(
      ok(
        `Tagged ${bold(slug)}: ${added.map((t) => chalk.cyan(t)).join(", ")}`
      )
    );
  }
  if (skipped.length) {
    console.log(dim(`  Already present: ${skipped.join(", ")}`));
  }
}

export function cmdAlias(
  db: Database,
  slug: string,
  alias: string
): void {
  requireProject(db, slug);

  const conflict = db
    .prepare("SELECT id FROM projects WHERE slug = ?")
    .get(alias);
  if (conflict) {
    console.error(
      err(`"${alias}" is already a project slug — cannot use as alias.`)
    );
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

export function cmdEdit(
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
    console.error(
      err(`Invalid type "${opts.type}". Valid: ${validTypes.join(", ")}`)
    );
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

export function cmdDetect(
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

export function cmdConsolidate(
  db: Database,
  identifier: string,
  opts: { yes?: boolean; dryRun?: boolean }
): void {
  const project =
    resolveIdentifier(db, identifier) ?? requireProject(db, identifier);

  console.log();
  console.log(header(`  Consolidate: ${project.slug}`));
  console.log(`  Target:  ${project.root_path}`);
  console.log();

  const dirs = findProjectNotesDirs(project);

  if (dirs.length === 0) {
    console.log(warn("  No scattered notes directories found for this project."));
    return;
  }

  const canonicalNotes = join(project.root_path, "Notes");
  const toMerge = dirs.filter((d) => d.notesPath !== canonicalNotes);

  if (toMerge.length === 0) {
    console.log(ok("  All notes are already in the canonical location."));
    console.log(dim(`  ${canonicalNotes}`));
    return;
  }

  console.log(
    `  Found ${toMerge.length} scattered Notes directory(ies) to consolidate:`
  );
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

export function cmdGo(db: Database, query: string): void {
  const all = db
    .prepare(
      "SELECT * FROM projects WHERE status = 'active' ORDER BY updated_at DESC"
    )
    .all() as ProjectRow[];

  if (!all.length) {
    console.error(
      err("No active projects registered. Run: pai project add <path>")
    );
    process.exit(1);
  }

  const q = query.trim().toLowerCase();

  // 1. Exact slug or alias match
  const exact = getProject(db, query);
  if (exact) {
    process.stdout.write(exact.root_path + "\n");
    return;
  }

  // 2. Substring match against slug, display_name, or root_path basename
  const partial = all.filter(
    (p) =>
      containsIgnoreCase(p.slug, q) ||
      containsIgnoreCase(p.display_name, q) ||
      containsIgnoreCase(basename(p.root_path), q)
  );

  if (partial.length === 1) {
    process.stdout.write(partial[0].root_path + "\n");
    return;
  }

  if (partial.length > 1) {
    console.error(
      err(`Ambiguous: "${query}" matches ${partial.length} projects:\n`)
    );
    partial.forEach((p, i) => {
      console.error(
        `  ${dim(String(i + 1).padStart(2))}  ${bold(p.slug.padEnd(30))}  ${dim(
          shortenPath(p.root_path, 50)
        )}`
      );
    });
    console.error();
    console.error(dim("  Use a more specific name or the exact slug."));
    process.exit(1);
  }

  // 3. No match — Levenshtein suggestions
  const scored = all
    .map((p) => {
      const distSlug = levenshtein(q, p.slug.toLowerCase());
      const distName = levenshtein(q, p.display_name.toLowerCase());
      return { project: p, dist: Math.min(distSlug, distName) };
    })
    .sort((a, b) => a.dist - b.dist);

  const threshold = 4;
  const suggestions =
    scored.filter((s) => s.dist <= threshold).length > 0
      ? scored.filter((s) => s.dist <= threshold).slice(0, 3)
      : scored.slice(0, 3);

  console.error(err(`Project not found: "${query}"\n`));
  if (suggestions.length) {
    console.error(warn("  Did you mean?"));
    for (const s of suggestions) {
      console.error(
        `    ${bold(s.project.slug.padEnd(30))}  ${dim(
          shortenPath(s.project.root_path, 50)
        )}`
      );
    }
    console.error();
    console.error(dim("  Run: pai project list  (to see all projects)"));
  }
  process.exit(1);
}
