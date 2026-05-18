/**
 * pai session resume <name-or-id> [--no-name] [--dry-run]
 *
 * DEPRECATED — use `pai session goto` instead.
 *
 * This thin shim prints a deprecation notice then delegates to cmdGoto,
 * which implements both resume (when a resumable snapshot exists) and
 * fresh-start (when the project has no resumable snapshot) in one command.
 */

import type { Database } from "better-sqlite3";
import chalk from "chalk";
import { cmdGoto } from "./goto.js";

export function cmdResume(
  db: Database,
  query: string,
  opts: { noName?: boolean; dryRun?: boolean }
): void {
  console.error(
    chalk.yellow(
      "  pai session resume is deprecated — use: pai session goto <name-or-id>"
    )
  );
  cmdGoto(db, query, opts);
}
