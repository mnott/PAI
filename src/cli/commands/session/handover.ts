/**
 * Session handover command — writes a ## Continue section to the project's
 * TODO.md. Called from session-stop and pre-compact hooks.
 */

import type { Database } from "better-sqlite3";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SessionRow, ProjectRow } from "./types.js";

const HANDOVER_TODO_LOCATIONS = [
  "Notes/TODO.md",
  ".claude/Notes/TODO.md",
  "tasks/todo.md",
  "TODO.md",
];

function findProjectTodo(
  rootPath: string
): { path: string; content: string } | null {
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

function stripContinueSection(content: string): string {
  const lines = content.split("\n");
  const startIdx = lines.findIndex((l) => l.trim() === "## Continue");
  if (startIdx === -1) return content;

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (
      trimmed === "---" ||
      (trimmed.startsWith("##") && trimmed !== "## Continue")
    ) {
      endIdx = i;
      break;
    }
  }

  let trailingEnd = endIdx;
  if (trailingEnd < lines.length && lines[trailingEnd].trim() === "---") {
    trailingEnd += 1;
  }

  const before = lines.slice(0, startIdx);
  const after = lines.slice(trailingEnd);
  while (after.length > 0 && after[0].trim() === "") after.shift();

  return [...before, ...after].join("\n");
}

export function cmdHandover(
  db: Database,
  projectSlug: string | undefined,
  numberOrLatest: string | undefined
): void {
  // ---- 1. Resolve project ----
  let project: ProjectRow | undefined;

  if (projectSlug) {
    project = db
      .prepare(
        "SELECT id, slug, display_name, root_path, encoded_dir FROM projects WHERE slug = ?"
      )
      .get(projectSlug) as ProjectRow | undefined;
    if (!project) process.exit(0);
  } else {
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
    if (!row) process.exit(0);
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
      .get(project!.id) as SessionRow | undefined;
  } else {
    const num = parseInt(nol, 10);
    if (!isNaN(num)) {
      session = db
        .prepare("SELECT * FROM sessions WHERE project_id = ? AND number = ?")
        .get(project!.id, num) as SessionRow | undefined;
    }
  }

  // ---- 3. Find or create TODO ----
  const todo = findProjectTodo(project!.root_path);
  let todoPath: string;
  let existingContent: string;

  if (todo) {
    todoPath = todo.path;
    existingContent = todo.content;
  } else {
    const notesDir = join(project!.root_path, "Notes");
    try {
      if (!existsSync(notesDir)) mkdirSync(notesDir, { recursive: true });
    } catch {
      process.exit(0);
    }
    todoPath = join(notesDir, "TODO.md");
    existingContent = "";
  }

  // ---- 4. Build ## Continue block ----
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

  // ---- 5. Prepend, stripping old ## Continue ----
  const stripped = stripContinueSection(existingContent).trimStart();
  const newContent = continueBlock + stripped;

  // ---- 6. Write atomically ----
  const tmpPath = `${todoPath}.handover.tmp`;
  try {
    writeFileSync(tmpPath, newContent, "utf8");
    renameSync(tmpPath, todoPath);
  } catch {
    try {
      if (existsSync(tmpPath)) renameSync(tmpPath, `${tmpPath}.dead`);
    } catch {
      /* ignore */
    }
    process.exit(0);
  }

  process.exit(0);
}
