/**
 * pai session <sub-command>
 *
 * list       [project-slug]                          — list sessions
 * info       <project-slug> <number>               — show session detail
 * rename     <project-slug> <number> <new-slug>    — rename a session note
 * slug       <project-slug> <number|latest>        — generate/apply a slug
 * tag        <project-slug> <number> [tags...]     — set/show tags on a session
 * route      <session-slug> <target-project>       — create cross-reference link
 * auto-route [--cwd path] [--context text]         — auto-detect project for session
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
import {
  existsSync,
  readdirSync,
  renameSync,
  readFileSync,
  writeFileSync,
  statSync,
  mkdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
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
// Command: session checkpoint
// ---------------------------------------------------------------------------

/**
 * Find the Notes directory for the current working directory by scanning
 * ~/.claude/projects/ for a matching encoded-dir entry.
 *
 * Returns the Notes dir path if found, or null if the CWD has no Claude
 * project directory yet.
 */
function findNotesDirForCwd(): string | null {
  const cwd = process.cwd();
  const claudeProjectsDir = join(homedir(), ".claude", "projects");

  if (!existsSync(claudeProjectsDir)) return null;

  // Encode the cwd the same way Claude Code does: every /, space, dot,
  // and hyphen → single dash.
  const expectedEncoded = cwd.replace(/[/\s.\-]/g, "-");

  let encodedDir: string | null = null;

  try {
    const entries = readdirSync(claudeProjectsDir);

    // Exact match first
    if (entries.includes(expectedEncoded)) {
      encodedDir = expectedEncoded;
    } else {
      // Fallback: look for a CLAUDE.md that contains the cwd path, or a
      // session-registry.json that mentions it.  In practice the exact match
      // covers the common case; keep the fallback cheap (no DB needed here
      // since checkpoint is called from hooks where DB may not be available).
      for (const entry of entries) {
        const full = join(claudeProjectsDir, entry);
        try {
          if (!statSync(full).isDirectory()) continue;
        } catch {
          continue;
        }
        // Heuristic: the encoded dir for /a/b/c is "-a-b-c".  Compare after
        // stripping any trailing slashes from the candidate.
        const candidate = entry.replace(/-+$/, "");
        const expected = expectedEncoded.replace(/-+$/, "");
        if (candidate === expected) {
          encodedDir = entry;
          break;
        }
      }
    }
  } catch {
    return null;
  }

  if (!encodedDir) return null;

  const notesDir = join(claudeProjectsDir, encodedDir, "Notes");
  return existsSync(notesDir) ? notesDir : null;
}

/**
 * Find the most recently modified .md file in a directory.
 */
function findLatestNoteFile(notesDir: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(notesDir);
  } catch {
    return null;
  }

  const mdFiles = entries.filter((e) => e.endsWith(".md"));
  if (mdFiles.length === 0) return null;

  let latestPath: string | null = null;
  let latestMtime = 0;

  for (const file of mdFiles) {
    const full = join(notesDir, file);
    try {
      const { mtimeMs } = statSync(full);
      if (mtimeMs > latestMtime) {
        latestMtime = mtimeMs;
        latestPath = full;
      }
    } catch {
      // skip unreadable files
    }
  }

  return latestPath;
}

/**
 * Rate-limit guard: returns true if the last checkpoint was written less
 * than `minGapSeconds` ago, using a temp file keyed to the notes directory.
 */
function checkpointTooRecent(notesDir: string, minGapSeconds: number): boolean {
  // Key the temp file to the notes dir path so different projects don't
  // share a rate-limit bucket.
  const safeKey = notesDir.replace(/[^a-zA-Z0-9]/g, "-").slice(-80);
  const tmpFile = join(tmpdir(), `pai-checkpoint-${safeKey}`);

  if (!existsSync(tmpFile)) return false;

  try {
    const { mtimeMs } = statSync(tmpFile);
    const ageMs = Date.now() - mtimeMs;
    return ageMs < minGapSeconds * 1000;
  } catch {
    return false;
  }
}

/**
 * Touch the rate-limit sentinel file.
 */
function touchCheckpointSentinel(notesDir: string): void {
  const safeKey = notesDir.replace(/[^a-zA-Z0-9]/g, "-").slice(-80);
  const tmpFile = join(tmpdir(), `pai-checkpoint-${safeKey}`);
  try {
    // Write current timestamp as content (mtime is what matters)
    writeFileSync(tmpFile, String(Date.now()), "utf8");
  } catch {
    // Non-fatal — rate limiting is best-effort
  }
}

/**
 * Append a timestamped checkpoint block to the active session note.
 *
 * Designed to be called from Claude Code hooks (PostToolUse,
 * UserPromptSubmit).  Fast, silent, exit 0 on success or skip.
 */
function cmdCheckpoint(message: string, opts: { minGap?: string }): void {
  const minGapSeconds = parseInt(opts.minGap ?? "300", 10); // default: 5 min

  // 1. Locate the Notes directory for the CWD
  const notesDir = findNotesDirForCwd();
  if (!notesDir) {
    // No Claude project for this directory — silently exit
    process.exit(0);
  }

  // 2. Rate-limit check
  if (checkpointTooRecent(notesDir, minGapSeconds)) {
    process.exit(0);
  }

  // 3. Find the most recent session note
  const notePath = findLatestNoteFile(notesDir);
  if (!notePath) {
    process.exit(0);
  }

  // 4. Build the checkpoint block
  const timestamp = new Date().toISOString();
  const block = `\n## Checkpoint — ${timestamp}\n${message}\n`;

  // 5. Append atomically: write to .tmp then rename
  const tmpPath = `${notePath}.checkpoint.tmp`;
  try {
    const existing = readFileSync(notePath, "utf8");
    writeFileSync(tmpPath, existing + block, "utf8");
    renameSync(tmpPath, notePath);
  } catch {
    // Non-fatal: hooks must not crash the Claude Code session
    try {
      // Clean up tmp file if it exists
      if (existsSync(tmpPath)) {
        renameSync(tmpPath, tmpPath + ".dead");
      }
    } catch { /* ignore */ }
    process.exit(0);
  }

  // 6. Update rate-limit sentinel
  touchCheckpointSentinel(notesDir);

  // Silent success — hooks should not produce noise
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Command: session handover
// ---------------------------------------------------------------------------

/**
 * TODO candidate locations searched in priority order (mirrors toolProjectTodo).
 */
const HANDOVER_TODO_LOCATIONS = [
  "Notes/TODO.md",
  ".claude/Notes/TODO.md",
  "tasks/todo.md",
  "TODO.md",
];

/**
 * Find the TODO.md for a given project root path.
 * Returns { path, content } for the first location that exists, or null.
 */
function findProjectTodo(rootPath: string): { path: string; content: string } | null {
  for (const rel of HANDOVER_TODO_LOCATIONS) {
    const full = join(rootPath, rel);
    if (existsSync(full)) {
      try {
        return { path: full, content: readFileSync(full, "utf8") };
      } catch {
        // unreadable — try next
      }
    }
  }
  return null;
}

/**
 * Strip any existing `## Continue` section (up to but not including the
 * first `---` separator or next `##` heading that follows it).
 * Returns the content with that section removed.
 */
function stripContinueSection(content: string): string {
  const lines = content.split("\n");

  const startIdx = lines.findIndex((l) => l.trim() === "## Continue");
  if (startIdx === -1) return content;

  // Find where the section ends
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === "---" || (trimmed.startsWith("##") && trimmed !== "## Continue")) {
      // Keep the separator / next heading as part of the remaining content
      endIdx = i;
      break;
    }
  }

  // If the line right after the section is a `---` separator, skip it too
  // so we don't leave a dangling separator with nothing above it.
  let trailingEnd = endIdx;
  if (trailingEnd < lines.length && lines[trailingEnd].trim() === "---") {
    trailingEnd += 1;
  }

  const before = lines.slice(0, startIdx);
  const after = lines.slice(trailingEnd);

  // Collapse any leading blank lines in `after`
  while (after.length > 0 && after[0].trim() === "") {
    after.shift();
  }

  return [...before, ...after].join("\n");
}

/**
 * Write (or overwrite) the `## Continue` section at the TOP of the TODO file.
 *
 *   pai session handover [project-slug] [session-id|"latest"]
 *
 * Called from hooks (session-stop, pre-compact) with project-slug + "latest".
 * Falls back to auto-detecting the project from cwd when no slug is supplied.
 */
function cmdHandover(
  db: Database,
  projectSlug: string | undefined,
  numberOrLatest: string | undefined
): void {
  // ---- 1. Resolve project ----
  let project: ProjectRow | undefined;

  if (projectSlug) {
    project = getProject(db, projectSlug);
    if (!project) {
      // Graceful exit — called from hooks, must not crash
      process.exit(0);
    }
  } else {
    // Auto-detect from cwd: find a project whose root_path is a prefix of cwd
    const cwd = process.cwd();
    const row = db
      .prepare(
        `SELECT id, slug, display_name, root_path, encoded_dir
           FROM projects
          WHERE ? LIKE root_path || '%'
          ORDER BY length(root_path) DESC
          LIMIT 1`
      )
      .get(cwd) as ProjectRow | undefined;

    if (!row) {
      process.exit(0);
    }
    project = row;
  }

  // ---- 2. Resolve session ----
  let session: SessionRow | undefined;
  const nol = numberOrLatest ?? "latest";

  if (nol === "latest") {
    session = db
      .prepare(
        "SELECT * FROM sessions WHERE project_id = ? ORDER BY number DESC LIMIT 1"
      )
      .get(project.id) as SessionRow | undefined;
  } else {
    const num = parseInt(nol, 10);
    if (!isNaN(num)) {
      session = db
        .prepare("SELECT * FROM sessions WHERE project_id = ? AND number = ?")
        .get(project.id, num) as SessionRow | undefined;
    }
  }

  // ---- 3. Find the project TODO ----
  const todo = findProjectTodo(project.root_path);

  // If no TODO file exists at all, try to create one at the canonical location
  let todoPath: string;
  let existingContent: string;

  if (todo) {
    todoPath = todo.path;
    existingContent = todo.content;
  } else {
    // Create Notes/TODO.md as the canonical default
    const notesDir = join(project.root_path, "Notes");
    try {
      if (!existsSync(notesDir)) {
        mkdirSync(notesDir, { recursive: true });
      }
    } catch {
      process.exit(0);
    }
    todoPath = join(notesDir, "TODO.md");
    existingContent = "";
  }

  // ---- 4. Build the ## Continue block ----
  const timestamp = new Date().toISOString();
  const cwd = process.cwd();

  let sessionLine: string;
  if (session) {
    const num = String(session.number).padStart(4, "0");
    const titlePart = session.title || session.slug || "Session";
    sessionLine = `${num} - ${session.date} - ${titlePart}`;
  } else {
    sessionLine = "Unknown session";
  }

  const continueBlock = [
    "## Continue",
    "",
    `> **Last session:** ${sessionLine}`,
    `> **Paused at:** ${timestamp}`,
    ">",
    `> Working directory: ${cwd}. Check the latest session note for details.`,
    "",
    "---",
    "",
  ].join("\n");

  // ---- 5. Strip any old ## Continue section and prepend new one ----
  const stripped = stripContinueSection(existingContent).trimStart();
  const newContent = continueBlock + stripped;

  // ---- 6. Write atomically ----
  const tmpPath = `${todoPath}.handover.tmp`;
  try {
    writeFileSync(tmpPath, newContent, "utf8");
    renameSync(tmpPath, todoPath);
  } catch {
    try {
      if (existsSync(tmpPath)) {
        renameSync(tmpPath, `${tmpPath}.dead`);
      }
    } catch { /* ignore */ }
    process.exit(0);
  }

  // Silent success — hooks should not produce noise on stdout
  process.exit(0);
}

// ---------------------------------------------------------------------------
// cmd: auto-route
// ---------------------------------------------------------------------------

async function cmdAutoRoute(opts: {
  cwd?: string;
  context?: string;
  json?: boolean;
}): Promise<void> {
  const { autoRoute, formatAutoRoute, formatAutoRouteJson } = await import(
    "../../session/auto-route.js"
  );
  const { openRegistry } = await import("../../registry/db.js");
  const { createStorageBackend } = await import("../../storage/factory.js");
  const { loadConfig } = await import("../../daemon/config.js");

  const config = loadConfig();
  const registryDb = openRegistry();
  const federation = await createStorageBackend(config);

  const targetCwd = opts.cwd ?? process.cwd();
  const result = await autoRoute(registryDb, federation, targetCwd, opts.context);

  if (!result) {
    console.log();
    console.log(warn("  No project match found for: " + targetCwd));
    console.log();
    console.log(
      dim("  Tried: path match, PAI.md marker walk") +
        (opts.context ? dim(", topic detection") : "")
    );
    console.log();
    console.log(dim("  Run 'pai project add .' to register this directory."));
    console.log();
    return;
  }

  if (opts.json) {
    console.log(formatAutoRouteJson(result));
    return;
  }

  console.log();
  console.log(header("  PAI Auto-Route"));
  console.log();
  console.log(`  ${bold("Project:")}     ${result.display_name}`);
  console.log(`  ${bold("Slug:")}        ${result.slug}`);
  console.log(`  ${bold("Root path:")}   ${result.root_path}`);
  console.log(`  ${bold("Method:")}      ${result.method}`);
  console.log(
    `  ${bold("Confidence:")}  ${(result.confidence * 100).toFixed(0)}%`
  );
  console.log();
  console.log(ok("  Routed to: ") + bold(result.slug));
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

  // pai session handover [project-slug] [session-id]
  sessionCmd
    .command("handover [project-slug] [session-id]")
    .description(
      "Write a ## Continue section to the project's TODO.md.\n" +
      "Called automatically from session-stop and pre-compact hooks.\n" +
      "Records the last session identifier, timestamp, and working directory\n" +
      "so the next session can resume from the correct context."
    )
    .action((projectSlug: string | undefined, sessionId: string | undefined) => {
      cmdHandover(getDb(), projectSlug, sessionId);
    });

  // pai session checkpoint <message>
  sessionCmd
    .command("checkpoint <message>")
    .description(
      "Append a timestamped checkpoint to the active session note.\n" +
      "Designed for hooks (PostToolUse, UserPromptSubmit) — fast and silent.\n" +
      "Rate-limited: skips silently if last checkpoint was < --min-gap seconds ago."
    )
    .option(
      "--min-gap <seconds>",
      "Minimum seconds between checkpoints (default: 300 = 5 minutes)",
      "300"
    )
    .action((message: string, opts: { minGap?: string }) => {
      // Note: does NOT call getDb() — checkpoint must work without the registry
      cmdCheckpoint(message, opts);
    });

  // pai session auto-route [--cwd path] [--context "text"] [--json]
  sessionCmd
    .command("auto-route")
    .description(
      "Auto-detect which project this session belongs to.\n" +
      "Tries: (1) path match in registry, (2) Notes/PAI.md marker walk, (3) topic detection.\n" +
      "Designed for use in CLAUDE.md session-start hooks."
    )
    .option("--cwd <path>", "Working directory to detect from (default: process.cwd())")
    .option("--context <text>", "Conversation context for topic-based fallback routing")
    .option("--json", "Output raw JSON instead of formatted display")
    .action(
      async (opts: { cwd?: string; context?: string; json?: boolean }) => {
        await cmdAutoRoute(opts);
      }
    );
}
