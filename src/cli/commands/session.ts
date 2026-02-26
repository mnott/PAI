/**
 * pai session <sub-command>
 *
 * list   [project-slug]                          — list sessions
 * info   <project-slug> <number>                 — show session detail
 * rename <project-slug> <number> <new-slug>      — rename a session note
 * slug   <project-slug> <number|latest>          — generate/apply a slug
 * tag    <project-slug> <number> [tags...]       — set/show tags on a session
 * route  <session-slug> <target-project>         — create cross-reference link
 */

import type { Command } from "commander";
import type { Database } from "better-sqlite3";
import {
  ok,
  warn,
  err,
  dim,
  bold,
  header,
  renderTable,
  fmtDate,
} from "../utils.js";
import chalk from "chalk";
import { existsSync, readdirSync, renameSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import {
  findLatestTranscript,
  readLastMessages,
  generateSlug,
} from "../../session/slug-generator.js";

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface SessionRow {
  id: number;
  project_id: number;
  number: number;
  date: string;
  slug: string;
  title: string;
  filename: string;
  status: string;
  claude_session_id: string | null;
  token_count: number | null;
  created_at: number;
  closed_at: number | null;
}

interface ProjectRow {
  id: number;
  slug: string;
  display_name: string;
  root_path: string;
  encoded_dir: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getProject(db: Database, slug: string): ProjectRow | undefined {
  return db
    .prepare(
      "SELECT id, slug, display_name, root_path, encoded_dir FROM projects WHERE slug = ?"
    )
    .get(slug) as ProjectRow | undefined;
}

function statusColor(status: string): string {
  switch (status) {
    case "completed":
      return chalk.green(status);
    case "compacted":
      return chalk.blue(status);
    default:
      return chalk.yellow(status);
  }
}

/**
 * Convert a slug to a title-cased display name suitable for filenames.
 *   "memory-engine"     → "Memory Engine"
 *   "slug-generator"    → "Slug Generator"
 *   "session-slug-fix"  → "Session Slug Fix"
 */
function toTitleCase(slug: string): string {
  return slug
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Find the Notes directory for a project.
 *
 * Notes live inside the Claude-managed project directory:
 *   ~/.claude/projects/<encoded_dir>/Notes/
 */
function getNotesDir(project: ProjectRow): string {
  return join(
    homedir(),
    ".claude",
    "projects",
    project.encoded_dir,
    "Notes"
  );
}

/**
 * Format a session filename from its parts.
 *   number=27, date="2026-02-23", titleSlug="Memory Engine"
 *   → "0027 - 2026-02-23 - Memory Engine.md"
 */
function formatFilename(number: number, date: string, titleSlug: string): string {
  const n = String(number).padStart(4, "0");
  return `${n} - ${date} - ${titleSlug}.md`;
}

/**
 * Look up a session by project + number OR "latest".
 * Returns the session row or exits with an error.
 */
function resolveSession(
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

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

function cmdList(
  db: Database,
  projectSlug: string | undefined,
  opts: { limit?: string; status?: string }
): void {
  const limit = parseInt(opts.limit ?? "20", 10);
  const params: unknown[] = [];

  let query = `
    SELECT s.*, p.slug AS project_slug, p.display_name AS project_name
    FROM sessions s
    JOIN projects p ON p.id = s.project_id
  `;

  const where: string[] = [];
  if (projectSlug) {
    const project = getProject(db, projectSlug);
    if (!project) {
      console.error(err(`Project not found: ${projectSlug}`));
      process.exit(1);
    }
    where.push("s.project_id = ?");
    params.push(project.id);
  }
  if (opts.status) {
    where.push("s.status = ?");
    params.push(opts.status);
  }

  if (where.length) {
    query += " WHERE " + where.join(" AND ");
  }
  query += " ORDER BY s.date DESC, s.number DESC";
  query += ` LIMIT ${limit}`;

  const rows = db.prepare(query).all(...params) as (SessionRow & {
    project_slug: string;
    project_name: string;
  })[];

  if (!rows.length) {
    console.log(warn("No sessions found."));
    return;
  }

  const showProject = !projectSlug;
  const headers = showProject
    ? ["#", "Project", "Date", "Title", "Status", "Tokens"]
    : ["#", "Date", "Title", "Status", "Tokens"];

  const tableRows = rows.map((r) => {
    const title =
      r.title.length > 45 ? r.title.slice(0, 42) + "..." : r.title;
    const tokens =
      r.token_count != null ? dim(r.token_count.toLocaleString()) : dim("—");
    if (showProject) {
      return [
        dim(`#${r.number}`),
        r.project_slug,
        r.date,
        title,
        statusColor(r.status),
        tokens,
      ];
    }
    return [dim(`#${r.number}`), r.date, title, statusColor(r.status), tokens];
  });

  console.log();
  if (projectSlug) {
    const project = getProject(db, projectSlug)!;
    console.log(`  ${bold(project.display_name)} sessions:`);
    console.log();
  }
  console.log(renderTable(headers, tableRows));
  console.log();
  console.log(dim(`  ${rows.length} session(s) shown (limit: ${limit})`));
}

function cmdInfo(
  db: Database,
  projectSlug: string,
  sessionNumber: string
): void {
  const project = getProject(db, projectSlug);
  if (!project) {
    console.error(err(`Project not found: ${projectSlug}`));
    process.exit(1);
  }

  const session = resolveSession(db, project, sessionNumber);

  console.log();
  console.log(header(`  Session #${session.number}: ${session.title}`));
  console.log();
  console.log(`  ${bold("Project:")}     ${project.display_name} (${project.slug})`);
  console.log(`  ${bold("Date:")}        ${session.date}`);
  console.log(`  ${bold("Status:")}      ${statusColor(session.status)}`);
  console.log(`  ${bold("Filename:")}    ${session.filename}`);
  console.log(`  ${bold("Slug:")}        ${session.slug}`);
  if (session.claude_session_id) {
    console.log(`  ${bold("Claude ID:")}   ${dim(session.claude_session_id)}`);
  }
  if (session.token_count != null) {
    console.log(`  ${bold("Tokens:")}      ${session.token_count.toLocaleString()}`);
  }
  console.log(`  ${bold("Created:")}     ${fmtDate(session.created_at)}`);
  if (session.closed_at) {
    console.log(`  ${bold("Closed:")}      ${fmtDate(session.closed_at)}`);
  }
  console.log();
}

/**
 * Rename a session note: updates the database (slug + title), renames the
 * file on disk, and updates the H1 title inside the Markdown file.
 */
function cmdRename(
  db: Database,
  projectSlug: string,
  numberOrLatest: string,
  newSlug: string
): void {
  const project = getProject(db, projectSlug);
  if (!project) {
    console.error(err(`Project not found: ${projectSlug}`));
    process.exit(1);
  }

  const session = resolveSession(db, project, numberOrLatest);
  const notesDir = getNotesDir(project);

  if (!existsSync(notesDir)) {
    console.error(err(`Notes directory not found: ${notesDir}`));
    process.exit(1);
  }

  // Title-case the slug for the filename and H1
  const titleSlug = toTitleCase(newSlug);
  const newFilename = formatFilename(session.number, session.date, titleSlug);
  const oldPath = join(notesDir, session.filename);
  const newPath = join(notesDir, newFilename);

  // Rename file on disk (only if it exists at expected location)
  if (existsSync(oldPath)) {
    if (oldPath !== newPath) {
      try {
        renameSync(oldPath, newPath);
      } catch (e) {
        console.error(err(`Failed to rename file: ${e}`));
        process.exit(1);
      }
    }
  } else {
    // File might already have a different name or be missing — warn but continue
    console.log(
      warn(`  Note: file not found at expected path: ${session.filename}`)
    );
    console.log(
      warn(`  Skipping disk rename. Database will still be updated.`)
    );
  }

  // Update H1 title inside the Markdown file if it exists
  if (existsSync(newPath)) {
    try {
      const content = readFileSync(newPath, "utf8");
      const lines = content.split("\n");
      let h1Updated = false;
      const updated = lines.map((line) => {
        if (!h1Updated && line.startsWith("# ")) {
          h1Updated = true;
          return `# ${titleSlug}`;
        }
        return line;
      });
      // If no H1 found, prepend one
      if (!h1Updated) {
        updated.unshift(`# ${titleSlug}`, "");
      }
      writeFileSync(newPath, updated.join("\n"), "utf8");
    } catch (e) {
      console.error(err(`Failed to update H1 in file: ${e}`));
      // Non-fatal: continue to update the database
    }
  }

  // Update the database
  const normalizedSlug = newSlug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  db.prepare(
    "UPDATE sessions SET slug = ?, title = ?, filename = ? WHERE id = ?"
  ).run(normalizedSlug, titleSlug, newFilename, session.id);

  console.log();
  console.log(ok(`  Session #${session.number} renamed.`));
  console.log(`  ${bold("Old:")}   ${session.filename}`);
  console.log(`  ${bold("New:")}   ${newFilename}`);
  console.log(`  ${bold("Slug:")}  ${normalizedSlug}`);
  console.log(`  ${bold("Title:")} ${titleSlug}`);
  console.log();
}

/**
 * Generate (and optionally apply) a slug for a session by analysing its
 * Claude Code JSONL transcript.
 */
function cmdSlug(
  db: Database,
  projectSlug: string,
  numberOrLatest: string,
  opts: { apply?: boolean }
): void {
  const project = getProject(db, projectSlug);
  if (!project) {
    console.error(err(`Project not found: ${projectSlug}`));
    process.exit(1);
  }

  const session = resolveSession(db, project, numberOrLatest);

  // Find the JSONL transcript
  const transcriptPath = findLatestTranscript(project.encoded_dir);

  if (!transcriptPath) {
    console.log(warn(`  No JSONL transcripts found for project ${projectSlug}`));
    console.log("unnamed-session");
    return;
  }

  // Read the last 15 message pairs
  const messages = readLastMessages(transcriptPath);

  if (messages.length < 2) {
    console.log(warn(`  Too few messages found (${messages.length}) in transcript`));
    console.log("unnamed-session");
    return;
  }

  // Generate the slug
  const generatedSlug = generateSlug(messages);

  console.log(generatedSlug);

  if (opts.apply) {
    console.log();
    console.log(dim(`  Applying slug to session #${session.number}...`));
    cmdRename(db, projectSlug, String(session.number), generatedSlug);
  }
}

// ---------------------------------------------------------------------------
// Tag helpers
// ---------------------------------------------------------------------------

function upsertTag(db: Database, tagName: string): number {
  db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)").run(tagName);
  const row = db.prepare("SELECT id FROM tags WHERE name = ?").get(tagName) as { id: number };
  return row.id;
}

function getSessionTags(db: Database, sessionId: number): string[] {
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

// ---------------------------------------------------------------------------
// Command: session tag
// ---------------------------------------------------------------------------

/**
 * Set or show tags on a session.
 *
 * With no tags supplied, prints the current tags.
 * Tags can be supplied as separate args or as a single comma-separated string.
 *   pai session tag 20-webseiten 81           — show current tags
 *   pai session tag 20-webseiten 81 docker migration server
 *   pai session tag 20-webseiten 81 docker,migration,server
 */
function cmdTag(
  db: Database,
  projectSlug: string,
  sessionNumber: string,
  rawTags: string[]
): void {
  const project = getProject(db, projectSlug);
  if (!project) {
    console.error(err(`Project not found: ${projectSlug}`));
    process.exit(1);
  }

  const session = resolveSession(db, project, sessionNumber);

  // No tags supplied — show current tags
  if (rawTags.length === 0) {
    const current = getSessionTags(db, session.id);
    console.log();
    if (current.length === 0) {
      console.log(dim(`  Session #${session.number} has no tags.`));
    } else {
      console.log(
        `  ${bold(`Session #${session.number}`)} tags: ${current.map((t) => chalk.cyan(t)).join(", ")}`
      );
    }
    console.log();
    return;
  }

  // Expand comma-separated tags within each arg
  const tags = rawTags
    .flatMap((t) => t.split(","))
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);

  if (tags.length === 0) {
    console.log(warn("No valid tags provided."));
    return;
  }

  const added: string[] = [];
  const skipped: string[] = [];

  for (const tagName of tags) {
    const tagId = upsertTag(db, tagName);
    const exists = db
      .prepare("SELECT 1 FROM session_tags WHERE session_id = ? AND tag_id = ?")
      .get(session.id, tagId);
    if (exists) {
      skipped.push(tagName);
    } else {
      db.prepare(
        "INSERT INTO session_tags (session_id, tag_id) VALUES (?, ?)"
      ).run(session.id, tagId);
      added.push(tagName);
    }
  }

  console.log();
  if (added.length) {
    console.log(
      ok(`  Tagged session #${session.number}: ${added.map((t) => chalk.cyan(t)).join(", ")}`)
    );
  }
  if (skipped.length) {
    console.log(dim(`  Already present: ${skipped.join(", ")}`));
  }

  const allTags = getSessionTags(db, session.id);
  console.log(
    `  ${bold("All tags:")} ${allTags.map((t) => chalk.cyan(t)).join(", ")}`
  );
  console.log();
}

// ---------------------------------------------------------------------------
// Command: session route
// ---------------------------------------------------------------------------

/**
 * Create a cross-reference link from a session to a target project.
 *
 *   pai session route <project-slug> <session-number> <target-project>
 *   pai session route <project-slug> <session-number> <target-project> --type follow-up
 */
function cmdRoute(
  db: Database,
  projectSlug: string,
  sessionNumber: string,
  targetProjectSlug: string,
  opts: { type?: string }
): void {
  const project = getProject(db, projectSlug);
  if (!project) {
    console.error(err(`Project not found: ${projectSlug}`));
    process.exit(1);
  }

  const session = resolveSession(db, project, sessionNumber);

  // Resolve target project
  const targetProject = db
    .prepare("SELECT id, slug, display_name FROM projects WHERE slug = ?")
    .get(targetProjectSlug) as { id: number; slug: string; display_name: string } | undefined;

  if (!targetProject) {
    console.error(err(`Target project not found: ${targetProjectSlug}`));
    process.exit(1);
  }

  const validTypes = ["related", "follow-up", "reference"];
  const linkType = opts.type ?? "related";
  if (!validTypes.includes(linkType)) {
    console.error(err(`Invalid link type "${linkType}". Valid: ${validTypes.join(", ")}`));
    process.exit(1);
  }

  try {
    db.prepare(
      `INSERT INTO links (session_id, target_project_id, link_type, created_at)
       VALUES (?, ?, ?, ?)`
    ).run(session.id, targetProject.id, linkType, Date.now());
  } catch {
    // UNIQUE constraint means this link already exists
    console.log(warn(`  Link already exists: session #${session.number} → ${targetProjectSlug}`));
    return;
  }

  console.log();
  console.log(
    ok(`  Linked session #${session.number} (${project.slug}) → ${targetProject.display_name} (${targetProjectSlug})`)
  );
  console.log(dim(`  Link type: ${linkType}`));
  console.log();
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

export function registerSessionCommands(
  sessionCmd: Command,
  getDb: () => Database
): void {
  // pai session list [project-slug]
  sessionCmd
    .command("list [project-slug]")
    .description("List sessions, optionally filtered to a single project")
    .option("--limit <n>", "Maximum number of sessions to show", "20")
    .option("--status <status>", "Filter by status: open | completed | compacted")
    .action(
      (
        projectSlug: string | undefined,
        opts: { limit?: string; status?: string }
      ) => {
        cmdList(getDb(), projectSlug, opts);
      }
    );

  // pai session info <project-slug> <number>
  sessionCmd
    .command("info <project-slug> <number>")
    .description("Show full details for a specific session")
    .action((projectSlug: string, number: string) => {
      cmdInfo(getDb(), projectSlug, number);
    });

  // pai session rename <project-slug> <number> <new-slug>
  sessionCmd
    .command("rename <project-slug> <number> <new-slug>")
    .description(
      "Rename a session note — updates file on disk, H1 title, and registry"
    )
    .action((projectSlug: string, number: string, newSlug: string) => {
      cmdRename(getDb(), projectSlug, number, newSlug);
    });

  // pai session slug <project-slug> <number|latest>
  sessionCmd
    .command("slug <project-slug> <number>")
    .description(
      "Generate a descriptive slug from the session JSONL transcript"
    )
    .option("--apply", "Rename the session note using the generated slug")
    .action((projectSlug: string, number: string, opts: { apply?: boolean }) => {
      cmdSlug(getDb(), projectSlug, number, opts);
    });

  // pai session tag <project-slug> <number> [tags...]
  sessionCmd
    .command("tag <project-slug> <number> [tags...]")
    .description(
      "Set or show tags on a session. Tags can be space-separated or comma-separated."
    )
    .action((projectSlug: string, number: string, tags: string[]) => {
      cmdTag(getDb(), projectSlug, number, tags);
    });

  // pai session route <project-slug> <number> <target-project>
  sessionCmd
    .command("route <project-slug> <number> <target-project>")
    .description(
      "Create a cross-reference link from a session to a target project"
    )
    .option(
      "--type <type>",
      "Link type: related | follow-up | reference",
      "related"
    )
    .action(
      (
        projectSlug: string,
        number: string,
        targetProject: string,
        opts: { type?: string }
      ) => {
        cmdRoute(getDb(), projectSlug, number, targetProject, opts);
      }
    );
}
