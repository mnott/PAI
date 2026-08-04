/**
 * pai project merge <from> <into> — fold a duplicate registry row into the real one.
 *
 * Exists because `health` had one remedy for every unhealthy row — archive — and
 * archiving a duplicate strands its sessions on a row nobody will open again. The
 * sessions are the only thing of value on a duplicate.
 *
 * Preview by default. This deletes a registry row, and the five-table fan-out
 * behind it is not something a caller can eyeball afterwards, so the plan is
 * printed first and `--execute` is what touches the database.
 */

import type { Database } from "better-sqlite3";
import { ok, warn, err, dim, bold, shortenPath } from "../../utils.js";
import { planMerge, applyMerge, MergeError } from "../../../registry/merge.js";

export function cmdMerge(
  db: Database,
  fromSlug: string,
  intoSlug: string,
  opts: { execute?: boolean } = {}
): void {
  let plan;
  try {
    plan = planMerge(db, fromSlug, intoSlug);
  } catch (e) {
    if (e instanceof MergeError) {
      console.error(err(`  ${e.message}`));
      process.exit(1);
    }
    throw e;
  }

  const path = (id: number): string => {
    const row = db.prepare("SELECT root_path FROM projects WHERE id = ?").get(id) as
      | { root_path: string }
      | undefined;
    return row ? shortenPath(row.root_path, 54) : "(unknown)";
  };

  console.log();
  console.log(bold(`  Merge ${plan.fromSlug} into ${plan.intoSlug}`));
  console.log();
  console.log(dim(`    from  ${plan.fromSlug.padEnd(22)} ${path(plan.fromId)}`));
  console.log(dim(`    into  ${plan.intoSlug.padEnd(22)} ${path(plan.intoId)}`));
  console.log();

  if (plan.sessions.length > 0) {
    // The renumbering is the part a reader cannot predict — sessions are UNIQUE
    // on (project_id, number), so incoming ones cannot keep their numbers.
    console.log(`    ${plan.sessions.length} session(s) move and are renumbered:`);
    for (const s of plan.sessions) {
      console.log(dim(`      ${String(s.from).padStart(4)}  ->  ${String(s.to).padStart(4)}`));
    }
  } else {
    console.log(dim(`    No sessions to move.`));
  }

  const extras: string[] = [];
  if (plan.tags) extras.push(`${plan.tags} tag(s)`);
  if (plan.aliases) extras.push(`${plan.aliases} existing alias(es)`);
  if (plan.compactions) extras.push(`${plan.compactions} compaction record(s)`);
  if (plan.links) extras.push(`${plan.links} inbound link(s)`);
  if (extras.length > 0) {
    console.log(dim(`    Also repointed: ${extras.join(", ")}.`));
  }

  if (plan.aliasToAdd) {
    console.log(
      dim(`    "${plan.aliasToAdd}" is kept as an alias, so the old name still resolves.`)
    );
  } else {
    console.log(
      warn(`    "${plan.fromSlug}" cannot be kept as an alias — the name is already taken.`)
    );
  }

  console.log(dim(`    Then the ${plan.fromSlug} row is deleted.`));
  console.log();

  if (!opts.execute) {
    console.log(dim("  Preview — nothing was changed. Re-run with --execute to merge."));
    console.log();
    return;
  }

  applyMerge(db, plan);
  console.log(
    ok(
      `  Merged. ${plan.sessions.length} session(s) now belong to ${plan.intoSlug}.`
    )
  );
  console.log();
}
