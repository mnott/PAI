/**
 * pai pause [--body-file <path>] [--session-id <uuid>] [--no-body] [--dry-run]
 *
 * Writes a "## Continue" checkpoint to the project's TODO.md and appends the
 * same checkpoint to the current session note, then prints a prominent
 * reminder about HOW to exit Claude Code safely.
 *
 * THE BODY IS THE POINT
 * ---------------------
 * This command used to emit a fixed four-line block: session name, timestamp,
 * working directory. That is metadata, not a checkpoint — it tells the next
 * session nothing about what was decided, what is blocked, or what to do next.
 * The actual checkpoint was written by the model and printed to the terminal,
 * where it died. Recovering it required the user to copy it off the screen by
 * hand.
 *
 * So `--body-file` is now mandatory. Omitting it is an error rather than a
 * silent downgrade, because a silent downgrade is precisely the failure this
 * fixes: everything looked like it worked, and the state was gone.
 * `--no-body` remains available for deliberate metadata-only use.
 *
 * WHY Ctrl+C is dangerous:
 *   Claude Code's stop-hook fires only on a clean exit (e.g. /exit inside the
 *   Claude prompt, or claude process receiving SIGTERM). When you Ctrl+C from
 *   a terminal that's running claude, the stop-hook is bypassed, which means:
 *     - The top-level <project>/<uuid>.jsonl does NOT get its final system snapshot.
 *     - Claude Code's --resume cannot find the session (0 system lines).
 *     - The session becomes orphaned — transcript exists but is unresumable.
 */

import type { Database } from "better-sqlite3";
import { basename } from "node:path";
import { realpathSync } from "node:fs";
import chalk from "chalk";
import type { ProjectRow, SessionRow } from "./types.js";
import {
  applyContinue,
  appendCheckpointToNote,
  findNotesDir,
  findLatestNote,
  readBodyFile,
} from "../../../session/checkpoint-block.js";

export interface PauseOptions {
  dryRun?: boolean;
  /** Path to the model-authored checkpoint markdown, or "-" for stdin. */
  bodyFile?: string;
  /** Claude Code session UUID — becomes the `claude --resume` handle. */
  sessionId?: string;
  /** Deliberately write a metadata-only checkpoint. */
  noBody?: boolean;
}

/** Format a session row as "0003 - 2026-08-01 - Title". */
export function formatSessionLine(session: SessionRow | undefined): string {
  if (!session) return "Unknown session";
  const num = String(session.number).padStart(4, "0");
  const titlePart = session.title || session.slug || "Session";
  return `${num} - ${session.date} - ${titlePart}`;
}

/**
 * Resolve the string that identifies a session in a ## Continue block.
 *
 * THIS IS THE PRESERVATION KEY. It decides whether an authored checkpoint
 * belongs to the current session and must be left alone, so every writer must
 * derive it identically — `pai pause`, `pai session handover`, and the hooks'
 * updateTodoContinue. Deriving it in more than one place is how a checkpoint
 * gets clobbered: one writer says "0006 - …" and the other says
 * "Unknown session", the keys do not match, and the unattended writer replaces
 * work it should have preserved.
 *
 * The registry row is preferred. When the project has no session rows — which
 * happens whenever one codebase is registered under several paths — it falls
 * back to the session note's filename, which is what the hooks use.
 */
export function resolveSessionLine(
  project: ProjectRow,
  session: SessionRow | undefined,
  notePath: string | null
): string {
  if (session) return formatSessionLine(session);
  if (notePath) return basename(notePath).replace(/\.md$/, "");
  return "Unknown session";
}

/** Locate the latest session note for a project, or null. */
export function resolveNotePath(project: ProjectRow): string | null {
  const notesDir = findNotesDir(project.root_path, project.encoded_dir ?? "");
  return notesDir ? findLatestNote(notesDir) : null;
}

/**
 * Resolve the project containing cwd, or undefined.
 *
 * Tries the literal path first, then its resolved form. A symlinked path
 * prefix (`~/dev -> Cloud/Development`) makes one directory reachable under
 * two spellings; matching only the literal string means a session started from
 * the other spelling finds nothing, and the scanner then registers a second
 * project for the same directory — which splits session history in half.
 */
export function resolveProjectByCwd(
  db: Database,
  cwd: string
): ProjectRow | undefined {
  const stmt = db.prepare(
    `SELECT id, slug, display_name, root_path, encoded_dir
       FROM projects
      WHERE ? LIKE root_path || '%'
      ORDER BY length(root_path) DESC
      LIMIT 1`
  );

  const direct = stmt.get(cwd) as ProjectRow | undefined;
  if (direct) return direct;

  let resolved: string;
  try {
    resolved = realpathSync(cwd);
  } catch {
    return undefined;
  }
  if (resolved === cwd) return undefined;

  return stmt.get(resolved) as ProjectRow | undefined;
}

function printMissingBodyError(): void {
  console.error(
    "\n" +
      chalk.bgRed.white.bold(
        "  CHECKPOINT BODY MISSING — nothing was written                "
      ) +
      "\n\n" +
      chalk.yellow(
        "  A checkpoint without a body is just a timestamp. The next session\n" +
          "  would learn nothing about what was decided or what is blocked.\n"
      ) +
      "\n" +
      chalk.white("  Write your checkpoint markdown to a file, then re-run:\n") +
      "\n" +
      chalk.cyan("    pai pause --body-file /path/to/checkpoint.md \\\n") +
      chalk.cyan("              --session-id <claude-session-uuid>\n") +
      "\n" +
      chalk.dim("  Or pipe it:  ") +
      chalk.cyan("cat checkpoint.md | pai pause --body-file -\n") +
      "\n" +
      chalk.dim(
        "  If you genuinely want a metadata-only checkpoint, pass --no-body.\n"
      )
  );
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export function cmdPause(db: Database, opts: PauseOptions): void {
  // ---- 1. Body first — fail before touching anything ----
  let body = "";

  if (opts.bodyFile) {
    try {
      body = readBodyFile(opts.bodyFile).trim();
    } catch (err) {
      console.error(
        chalk.red("pai pause: ") +
          `Could not read checkpoint body from ${opts.bodyFile}: ${String(err)}`
      );
      process.exit(1);
    }
    if (!body) {
      console.error(
        chalk.red("pai pause: ") +
          `Checkpoint body at ${opts.bodyFile} is empty.`
      );
      process.exit(1);
    }
  } else if (!opts.noBody) {
    printMissingBodyError();
    process.exit(1);
  }

  // ---- 2. Resolve project by cwd ----
  const cwd = process.cwd();
  const project = resolveProjectByCwd(db, cwd);

  if (!project) {
    console.error(
      chalk.red("pai pause: ") +
        "Current directory is not within a registered PAI project.\n" +
        `  cwd: ${cwd}`
    );
    process.exit(1);
  }

  // ---- 3. Resolve latest session ----
  const session = db
    .prepare(
      "SELECT * FROM sessions WHERE project_id = ? ORDER BY number DESC LIMIT 1"
    )
    .get(project.id) as SessionRow | undefined;

  // ---- 3b. Agree with the hooks on how a session is identified ----
  //
  // The unattended writers (pre-compact hook, daemon work-queue worker) key a
  // session by its note filename. This command keys it by the registry row.
  // That string is the preservation key — it is what decides whether an
  // authored checkpoint belongs to the current session and must be left alone —
  // so the two must produce the same value or the hooks will clobber this
  // command's work.
  //
  // They diverge whenever the registry has no session row for the resolved
  // project, which happens when one codebase is registered under several paths.
  // Falling back to the note filename makes them agree, and incidentally
  // replaces a useless "Unknown session" label with the real one.
  const notePath = resolveNotePath(project);
  const sessionLine = resolveSessionLine(project, session, notePath);

  // A registered project with zero sessions almost always means split identity:
  // the same codebase registered under several paths (a dev copy and a synced
  // copy, say), with the session history filed under a different row. The
  // checkpoint still writes correctly, but "Unknown session" in TODO.md is a
  // symptom worth naming rather than shipping silently.
  if (!session) {
    const siblings = db
      .prepare(
        `SELECT p.slug, p.root_path, COUNT(s.id) AS n
           FROM projects p LEFT JOIN sessions s ON s.project_id = p.id
          WHERE p.id != ? AND (p.slug = ? OR p.slug LIKE ? || '-%' OR ? LIKE p.slug || '-%')
          GROUP BY p.id HAVING n > 0
          ORDER BY n DESC LIMIT 3`
      )
      .all(project.id, project.slug, project.slug, project.slug) as Array<{
      slug: string;
      root_path: string;
      n: number;
    }>;

    console.log(
      chalk.yellow(
        `  Note: project '${project.slug}' has no registered sessions; the ` +
          `checkpoint is labelled from the session note instead ("${sessionLine}").`
      )
    );
    for (const s of siblings) {
      console.log(
        chalk.dim(
          `        '${s.slug}' (${s.root_path}) has ${s.n} — likely the same project under another path.`
        )
      );
    }
  }

  // ---- 4. Write the ## Continue block ----
  const timestamp = new Date().toISOString();

  const result = applyContinue({
    rootPath: project.root_path,
    authored: body ? "model" : "auto",
    sessionLine,
    sessionId: opts.sessionId,
    cwd,
    body,
    timestamp,
    dryRun: opts.dryRun,
  });

  if (result.action === "failed") {
    console.error(
      chalk.red("pai pause: ") + `Failed to write TODO.md: ${result.error}`
    );
    process.exit(1);
  }

  if (opts.dryRun) {
    console.log(
      "\n" + chalk.bold("Dry run — would write to:") + " " + chalk.cyan(result.path ?? "?")
    );
    console.log(chalk.dim("─".repeat(60)));
    console.log(chalk.dim(result.block));
    console.log(chalk.dim("─".repeat(60)));
  } else {
    console.log(
      chalk.green("  ## Continue written to: ") + chalk.cyan(result.path ?? "?")
    );
  }

  // ---- 5. Mirror the body into the session note ----
  //
  // TODO.md's ## Continue is a single slot that the next checkpoint overwrites.
  // The session note is the durable record, so the body goes to both.
  if (body) {
    if (!notePath) {
      console.log(
        chalk.yellow(
          "  (No session note found — checkpoint saved to TODO.md only.)"
        )
      );
    } else if (opts.dryRun) {
      console.log(
        chalk.dim(`  Would append checkpoint to: ${basename(notePath)}`)
      );
    } else {
      const { appended, error } = appendCheckpointToNote(
        notePath,
        body,
        timestamp
      );
      if (appended) {
        console.log(
          chalk.green("  Checkpoint appended to note: ") +
            chalk.cyan(basename(notePath))
        );
      } else if (error) {
        console.log(
          chalk.yellow(`  (Could not append to session note: ${error})`)
        );
      }
    }
  }

  // ---- 6. Print the safety warning ----
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
    chalk.dim("  Ctrl+C bypasses PAI's stop-hook, which means:"),
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
