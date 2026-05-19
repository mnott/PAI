/**
 * pai end [--dry-run]
 *
 * Extends `pai pause` with two additional steps:
 *   1. Marks the current session note **Status: Completed** and adds a
 *      Completed timestamp — mirrors what `finalizeSessionNote()` does in the
 *      hooks lib but without importing the hooks-only module.
 *   2. Prints a slightly more final safe-exit reminder.
 *
 * The TODO.md ## Continue checkpoint is written first (same as `pai pause`),
 * so if the user exits without the session note step succeeding the content
 * checkpoint is still intact.
 */

import type { Database } from "better-sqlite3";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import chalk from "chalk";
import type { ProjectRow, SessionRow } from "./types.js";
import { cmdPause } from "./pause.js";

// ---------------------------------------------------------------------------
// Notes-directory resolution (mirrors paths.ts without importing hooks lib)
// ---------------------------------------------------------------------------

/** Encode a path the same way Claude Code does. */
function encodePath(path: string): string {
  return path
    .replace(/\//g, "-")
    .replace(/\./g, "-")
    .replace(/ /g, "-");
}

/** PAI_DIR — mirrors pai-paths.ts resolution. */
function getPaiDir(): string {
  const envDir = process.env.PAI_DIR;
  if (envDir) {
    try {
      return realpathSync(envDir);
    } catch {
      return envDir;
    }
  }
  return join(homedir(), ".claude");
}

/**
 * Find the notes directory for a project — checks local first, then central.
 * Returns null if neither exists (dry-run safe: don't create).
 */
function findNotesDir(
  rootPath: string,
  encodedDir: string
): string | null {
  // Check local paths first
  for (const rel of ["Notes", "notes", ".claude/Notes"]) {
    const p = join(rootPath, rel);
    if (existsSync(p)) return p;
  }
  // Central fallback: ~/.claude/projects/<encoded>/Notes
  const central = join(getPaiDir(), "projects", encodedDir, "Notes");
  if (existsSync(central)) return central;
  return null;
}

/**
 * Find the current (latest) session note inside notesDir.
 * Searches YYYY/MM subdirectory (current month, then previous month),
 * then flat notesDir as legacy fallback.
 */
function findLatestNote(notesDir: string): string | null {
  const findIn = (dir: string): string | null => {
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir)
      .filter((f) => /^\d{3,4}[\s_-].*\.md$/.test(f))
      .sort((a, b) => {
        const na = parseInt(a.match(/^(\d+)/)?.[1] ?? "0", 10);
        const nb = parseInt(b.match(/^(\d+)/)?.[1] ?? "0", 10);
        return na - nb;
      });
    return files.length > 0 ? join(dir, files[files.length - 1]) : null;
  };

  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");

  const current = findIn(join(notesDir, year, month));
  if (current) return current;

  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const py = String(prev.getFullYear());
  const pm = String(prev.getMonth() + 1).padStart(2, "0");
  const prevFound = findIn(join(notesDir, py, pm));
  if (prevFound) return prevFound;

  return findIn(notesDir);
}

// ---------------------------------------------------------------------------
// Session-note finalization (mirrors finalizeSessionNote from session-notes.ts)
// ---------------------------------------------------------------------------

function finalizeNote(notePath: string): { finalized: boolean; path: string } {
  const content = readFileSync(notePath, "utf-8");

  if (content.includes("**Status:** Completed")) {
    return { finalized: false, path: notePath }; // already done
  }

  let updated = content.replace("**Status:** In Progress", "**Status:** Completed");

  if (!updated.includes("**Completed:**")) {
    const completionTime = new Date().toISOString();
    updated = updated.replace(
      "---\n\n## Work Done",
      `**Completed:** ${completionTime}\n\n---\n\n## Work Done`
    );
  }

  // Write atomically
  const tmp = `${notePath}.end.tmp`;
  writeFileSync(tmp, updated, "utf-8");
  renameSync(tmp, notePath);

  return { finalized: true, path: notePath };
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export function cmdEnd(db: Database, opts: { dryRun?: boolean }): void {
  // ---- Step 1: Run pause logic (writes ## Continue, prints warning) ----
  // We call cmdPause first; it prints the ## Continue block and the initial
  // safe-exit box. We'll print the end-specific reminder afterwards.
  cmdPause(db, opts);

  // ---- Step 2: Locate the project ----
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
    // cmdPause already printed an error. Nothing more to do.
    return;
  }

  // ---- Step 3: Find notes directory ----
  const notesDir = findNotesDir(project.root_path, project.encoded_dir ?? "");

  if (!notesDir) {
    console.log(
      chalk.dim("  (No session note found — notes directory does not exist yet.)")
    );
    printEndBox(opts.dryRun);
    return;
  }

  // ---- Step 4: Find latest session note ----
  const notePath = findLatestNote(notesDir);

  if (!notePath) {
    console.log(chalk.dim("  (No session note found in notes directory.)"));
    printEndBox(opts.dryRun);
    return;
  }

  // ---- Step 5: Mark as completed ----
  if (opts.dryRun) {
    console.log(
      "\n" +
        chalk.bold("Dry run — would finalize session note:") +
        " " +
        chalk.cyan(notePath)
    );
    console.log(
      chalk.dim(
        "  Would replace: **Status:** In Progress\n" +
          "            with: **Status:** Completed"
      )
    );
    console.log(
      chalk.dim("  Would add: **Completed:** <timestamp>")
    );
  } else {
    const { finalized, path } = finalizeNote(notePath);
    if (finalized) {
      console.log(
        chalk.green("  Session note finalized: ") + chalk.cyan(basename(path))
      );
    } else {
      console.log(
        chalk.dim(
          `  Session note already marked Completed: ${basename(notePath)}`
        )
      );
    }
  }

  // ---- Step 6: Print the more-final exit reminder ----
  printEndBox(opts.dryRun);
}

function printEndBox(dryRun?: boolean): void {
  const label = dryRun ? " (dry-run)" : "";
  const box = [
    "",
    chalk.bgRed.white.bold(
      `  SESSION ENDING${label}: How to exit safely                   `
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
    chalk.dim("  Ctrl+C bypasses PAI's stop-hook, which means:"),
    chalk.dim("    - The session note is NOT written to by the stop-hook"),
    chalk.dim("    - The session becomes orphaned (cannot --resume next time)"),
    chalk.dim("    - The final session summary is never generated"),
    "",
    chalk.dim(
      "  ## Continue checkpoint and session note status are already saved."
    ),
    chalk.dim("  Use /exit to let PAI's stop-hook finalize the session fully."),
    "",
  ].join("\n");

  console.log(box);
}
