/**
 * `pai registry reconnect` — point projects back at the transcripts they lost.
 *
 * A project's `encoded_dir` is written once and never updated when the project
 * moves, so every transcript lookup for a moved project quietly returns
 * nothing: no handover, no session digest, no checkpoint. The failure is
 * invisible because an empty result and an unasked question look identical.
 *
 * Repairs are derived from the transcripts themselves — each records the `cwd`
 * it ran in — rather than from a naming rule, because the naming rule is what
 * broke. Dry-run by default: this rewrites registry rows, and a repair that
 * guesses wrong reattaches a project to someone else's history.
 */

import type { Database } from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import {
  scanTranscriptFolders,
  findMovedProjects,
  transcriptFiles,
  claudeProjectsDir,
  type RegistryProjectRow,
} from "../../../registry/moved.js";
import { encodeDir } from "../../utils.js";
import { dim, ok, warn } from "../../utils.js";

export function cmdReconnect(db: Database, opts: { execute?: boolean }): void {
  const rows = db
    .prepare(
      `SELECT p.id, p.slug, p.root_path, p.encoded_dir,
              (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id) AS sessions
         FROM projects p
        WHERE p.status = 'active'`
    )
    .all() as RegistryProjectRow[];

  const base = claudeProjectsDir();
  const has = (name: string | null): boolean =>
    Boolean(name) && transcriptFiles(join(base, name!)).length > 0;

  // Mirrors resolveTranscriptDir: stored value first, derived from the current
  // root path second. A project either of those already handles is not broken,
  // and rewriting it would be churn dressed as a repair.
  const resolvesNow = (r: RegistryProjectRow): boolean =>
    has(r.encoded_dir) || has(encodeDir(r.root_path));

  const moved = findMovedProjects(rows, scanTranscriptFolders(base), resolvesNow);

  console.log();
  if (moved.length === 0) {
    console.log(ok("  Nothing to reconnect. "));
    console.log(dim("  Every active project resolves to a folder holding transcripts."));
    console.log();
    return;
  }

  console.log(
    chalk.bold(`  ${moved.length} project(s) point at the wrong transcript folder`)
  );
  console.log();
  for (const m of moved) {
    const cost = m.sessions > 0 ? chalk.yellow(`${m.sessions} sessions unreachable`) : dim("no sessions recorded");
    console.log(`  ${chalk.cyan(m.slug)}  ${cost}`);
    console.log(dim(`    stored:  ${m.storedDir ?? "(none)"}`));
    console.log(dim(`    correct: ${m.correctDir}  (${m.transcripts} transcripts)`));
  }
  console.log();

  if (!opts.execute) {
    console.log(dim("  Dry run. Re-run with --execute to write these."));
    console.log();
    return;
  }

  // One transaction: a partial repair would leave the registry in a state
  // nobody chose, and the whole point here is that stale rows are silent.
  const update = db.prepare("UPDATE projects SET encoded_dir = ? WHERE id = ?");
  const apply = db.transaction((list: typeof moved) => {
    for (const m of list) update.run(m.correctDir, m.id);
  });

  try {
    apply(moved);
    console.log(ok(`  Reconnected ${moved.length} project(s).`));
    const recovered = moved.reduce((n, m) => n + m.sessions, 0);
    if (recovered > 0) {
      console.log(dim(`  ${recovered} session(s) are reachable again.`));
    }
  } catch (e) {
    console.error(warn("  Nothing was written: ") + (e instanceof Error ? e.message : String(e)));
  }
  console.log();
}

/** Path to the registry, for callers that want to back it up first. */
export const REGISTRY_PATH = join(homedir(), ".pai", "registry.db");
