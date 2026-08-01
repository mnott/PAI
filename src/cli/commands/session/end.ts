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
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { basename } from "node:path";
import chalk from "chalk";
import type { ProjectRow } from "./types.js";
import { cmdPause, type PauseOptions } from "./pause.js";
import {
  findNotesDir,
  findLatestNote,
} from "../../../session/checkpoint-block.js";

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

export function cmdEnd(db: Database, opts: PauseOptions): void {
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
