/**
 * pai project unregister <slug> — remove a row that should never have existed.
 *
 * The remedy for an EPHEMERAL project: one rooted in a git worktree or a temp
 * directory. Archiving is wrong for those — archiving means "this was real and is
 * finished", and these were never projects. Measured 2026-08-04 there were five:
 * two agent worktrees, `/private/tmp/ops-webui`, a scratchpad under
 * `/private/tmp/claude-501/…`, and `tmp` rooted at `/private/tmp` itself, active
 * since February.
 *
 * Written because `health` started printing "unregister" as the suggested action
 * and the command did not exist. An action field naming something unavailable is
 * worse than no action field: it reads as vetted.
 *
 * Refuses by default when the row holds sessions. Those sessions are the only
 * thing of value on it, and deleting the row would strand them — merge is the
 * right verb there, so this points at it rather than offering --force as the
 * obvious path.
 */

import type { Database } from "better-sqlite3";
import { ok, warn, err, dim, bold } from "../../utils.js";

export function cmdUnregister(
  db: Database,
  slug: string,
  opts: { execute?: boolean; force?: boolean } = {}
): void {
  const row = db
    .prepare(
      `SELECT p.id, p.slug, p.root_path, p.status,
              (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id) AS session_count
       FROM projects p WHERE p.slug = ?`
    )
    .get(slug) as
    | { id: number; slug: string; root_path: string; status: string; session_count: number }
    | undefined;

  if (!row) {
    console.error(err(`  No project with slug "${slug}".`));
    process.exit(1);
  }

  console.log();
  console.log(bold(`  Unregister ${row.slug}`));
  console.log(dim(`    ${row.root_path}`));
  console.log(dim(`    status ${row.status}, ${row.session_count} session(s)`));
  console.log();

  if (row.session_count > 0 && !opts.force) {
    console.log(warn(`  Refusing: ${row.session_count} session(s) would be stranded.`));
    console.log(
      dim(`  Those sessions are the only thing of value on this row. Move them first:`)
    );
    console.log(dim(`      pai project merge ${row.slug} <into> --execute`));
    console.log(dim(`  Or pass --force if the sessions are genuinely worthless.`));
    console.log();
    process.exit(1);
  }

  if (!opts.execute) {
    console.log(
      dim("  Preview — nothing was changed. Re-run with --execute to unregister.")
    );
    if (row.session_count > 0) {
      console.log(warn(`  --force is set: ${row.session_count} session(s) WILL be deleted.`));
    }
    console.log();
    return;
  }

  // Same five tables as merge. With foreign keys off, deleting only the project
  // row would silently orphan the rest.
  const run = db.transaction(() => {
    db.prepare("DELETE FROM links WHERE target_project_id = ?").run(row.id);
    db.prepare(
      "DELETE FROM links WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ?)"
    ).run(row.id);
    db.prepare("DELETE FROM compaction_log WHERE project_id = ?").run(row.id);
    db.prepare("DELETE FROM project_tags WHERE project_id = ?").run(row.id);
    db.prepare("DELETE FROM aliases WHERE project_id = ?").run(row.id);
    db.prepare("DELETE FROM sessions WHERE project_id = ?").run(row.id);
    db.prepare("DELETE FROM projects WHERE id = ?").run(row.id);
  });
  run();

  console.log(ok(`  Unregistered ${row.slug}.`));
  console.log(dim(`  The directory itself was not touched.`));
  console.log();
}
