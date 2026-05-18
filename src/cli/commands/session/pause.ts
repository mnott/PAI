/**
 * pai session pause [--dry-run]
 *
 * Writes a "## Continue" checkpoint to the project's TODO.md, then prints a
 * prominent reminder about HOW to exit Claude Code safely.
 *
 * The write logic mirrors cmdHandover exactly — it finds the project by cwd,
 * finds (or creates) TODO.md, and prepends a ## Continue block. The difference
 * is that we do NOT call process.exit() after writing, so the warning is shown.
 *
 * WHY Ctrl+C is dangerous:
 *   Claude Code's stop-hook fires only on a clean exit (e.g. /exit inside the
 *   Claude prompt, or claude process receiving SIGTERM). When you Ctrl+C from
 *   a terminal that's running claude, the stop-hook is bypassed, which means:
 *     - The top-level <project>/<uuid>.jsonl does NOT get its final system snapshot.
 *     - Claude Code's --resume cannot find the session (0 system lines).
 *     - The session becomes orphaned — transcript exists but is unresumable.
 *
 *   If the project TODO.md gets its ## Continue checkpoint (written by this
 *   command), the *content* can still be recovered. But the *session context*
 *   (conversation history) is lost unless you exit cleanly via /exit.
 */

import type { Database } from "better-sqlite3";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import type { ProjectRow, SessionRow } from "./types.js";

// ---------------------------------------------------------------------------
// TODO.md discovery (same locations as handover.ts)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export function cmdPause(
  db: Database,
  opts: { dryRun?: boolean }
): void {
  // ---- 1. Resolve project by cwd ----
  const cwd = process.cwd();
  const project = db
    .prepare(
      `SELECT id, slug, display_name, root_path, encoded_dir
         FROM projects
        WHERE ? LIKE root_path || '%'
        ORDER BY length(root_path) DESC
        LIMIT 1`
    )
    .get(cwd) as ProjectRow | undefined;

  if (!project) {
    console.error(
      chalk.red("pai session pause: ") +
        "Current directory is not within a registered PAI project.\n" +
        `  cwd: ${cwd}`
    );
    process.exit(1);
  }

  // ---- 2. Resolve latest session ----
  const session = db
    .prepare(
      "SELECT * FROM sessions WHERE project_id = ? ORDER BY number DESC LIMIT 1"
    )
    .get(project.id) as SessionRow | undefined;

  // ---- 3. Find or create TODO.md ----
  const todo = findProjectTodo(project.root_path);
  let todoPath: string;
  let existingContent: string;

  if (todo) {
    todoPath = todo.path;
    existingContent = todo.content;
  } else {
    const notesDir = join(project.root_path, "Notes");
    if (!opts.dryRun) {
      try {
        if (!existsSync(notesDir)) mkdirSync(notesDir, { recursive: true });
      } catch (mkdirErr) {
        console.error(
          chalk.red("pai session pause: ") +
            `Could not create Notes directory: ${String(mkdirErr)}`
        );
        process.exit(1);
      }
    }
    todoPath = join(notesDir, "TODO.md");
    existingContent = "";
  }

  // ---- 4. Build ## Continue block ----
  const timestamp = new Date().toISOString();

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

  // ---- 6. Write atomically (or dry-run preview) ----
  if (opts.dryRun) {
    console.log("\n" + chalk.bold("Dry run — would write to:") + " " + chalk.cyan(todoPath));
    console.log(chalk.dim("─".repeat(60)));
    // Show just the ## Continue block that would be prepended
    console.log(chalk.dim(continueBlock));
    console.log(chalk.dim("─".repeat(60)));
  } else {
    const tmpPath = `${todoPath}.pause.tmp`;
    try {
      writeFileSync(tmpPath, newContent, "utf8");
      renameSync(tmpPath, todoPath);
    } catch (writeErr) {
      try {
        if (existsSync(tmpPath)) renameSync(tmpPath, `${tmpPath}.dead`);
      } catch {
        /* ignore */
      }
      console.error(
        chalk.red("pai session pause: ") +
          `Failed to write TODO.md: ${String(writeErr)}`
      );
      process.exit(1);
    }
    console.log(
      chalk.green("  ## Continue written to: ") + chalk.cyan(todoPath)
    );
  }

  // ---- 7. Print the safety warning ----
  const box = [
    "",
    chalk.bgRed.white.bold(
      "  IMPORTANT: How to exit safely                               "
    ),
    "",
    chalk.yellow(
      "  Inside the Claude Code session, type:  " +
        chalk.white.bold("/exit") +
        chalk.yellow("  (then press Enter)")
    ),
    "",
    chalk.red.bold("  DO NOT press Ctrl+C."),
    "",
    chalk.dim(
      "  Ctrl+C bypasses PAI's stop-hook, which means:"
    ),
    chalk.dim("    - No project snapshot is written to the top-level jsonl"),
    chalk.dim("    - The session becomes orphaned (cannot --resume next time)"),
    chalk.dim(
      "    - pai session goto will launch a fresh session instead of resuming"
    ),
    "",
    chalk.dim("  The ## Continue checkpoint in TODO.md is already saved."),
    chalk.dim("  Use /exit to preserve full session resumability."),
    "",
  ].join("\n");

  console.log(box);
}
