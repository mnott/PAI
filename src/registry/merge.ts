/**
 * merge.ts — fold one registered project into another without losing anything.
 *
 * The registry accumulates rows that describe the same work twice: a project
 * registered under two spellings of one directory, a vault-notes twin of a code
 * project, a slug that collided and got a `-1`. Measured 2026-08-04 there were
 * six such rows, and between them they carried ten sessions.
 *
 * Those sessions are the only thing of value on the losing row, which is why
 * `archive` is the wrong remedy and a plain DELETE is worse. `pai project health`
 * suggested archiving for every unhealthy row, and archiving a duplicate leaves
 * the sessions attached to a row nobody will look at again.
 *
 * FIVE tables reference a project, and `PRAGMA foreign_keys` is 0 on this
 * database — so deleting a project row does not fail, it silently orphans rows in
 * sessions, project_tags, aliases, compaction_log and links. Anything that merges
 * by hand will miss at least one of them. Hence one function.
 *
 * Two constraints shape the implementation:
 *
 *   sessions UNIQUE (project_id, number)  — incoming sessions must be renumbered,
 *                                           or the insert collides with the
 *                                           target's own numbering
 *   links    UNIQUE (session_id, target_project_id)
 *   project_tags PRIMARY KEY (project_id, tag_id)
 *                                         — both can already hold the row we are
 *                                           about to point at the target
 */

import type { Database } from "better-sqlite3";

export interface MergePlan {
  fromId: number;
  fromSlug: string;
  intoId: number;
  intoSlug: string;
  /** Sessions to move, with the numbers they will be given. */
  sessions: { id: number; from: number; to: number }[];
  tags: number;
  aliases: number;
  compactions: number;
  links: number;
  /** The losing slug is kept as an alias, so `pai <old-name>` still resolves. */
  aliasToAdd?: string;
}

export class MergeError extends Error {}

/**
 * What a merge would do, without doing it.
 *
 * Built as a plan first because the session renumbering is the part a reader will
 * not predict, and printing "0001 -> 0016" is the difference between a command
 * that can be trusted and one that has to be taken on faith.
 */
export function planMerge(db: Database, fromSlug: string, intoSlug: string): MergePlan {
  if (fromSlug === intoSlug) {
    throw new MergeError(`Cannot merge ${fromSlug} into itself.`);
  }

  const from = db
    .prepare("SELECT id, slug FROM projects WHERE slug = ?")
    .get(fromSlug) as { id: number; slug: string } | undefined;
  const into = db
    .prepare("SELECT id, slug FROM projects WHERE slug = ?")
    .get(intoSlug) as { id: number; slug: string } | undefined;

  if (!from) throw new MergeError(`No project with slug "${fromSlug}".`);
  if (!into) throw new MergeError(`No project with slug "${intoSlug}".`);

  // Where the target's numbering currently ends. Incoming sessions continue from
  // there rather than keeping their own numbers, which would collide.
  const maxRow = db
    .prepare("SELECT COALESCE(MAX(number), 0) AS n FROM sessions WHERE project_id = ?")
    .get(into.id) as { n: number };
  let next = maxRow.n;

  const incoming = db
    .prepare("SELECT id, number FROM sessions WHERE project_id = ? ORDER BY number ASC")
    .all(from.id) as { id: number; number: number }[];

  const sessions = incoming.map((s) => ({ id: s.id, from: s.number, to: ++next }));

  const count = (sql: string, ...args: unknown[]): number =>
    (db.prepare(sql).get(...args) as { n: number }).n;

  // The losing slug becomes an alias of the winner, so anything that resolved by
  // that name keeps working — including a human who remembers the old name.
  const aliasTaken =
    count("SELECT COUNT(*) AS n FROM aliases WHERE alias = ?", from.slug) > 0 ||
    count("SELECT COUNT(*) AS n FROM projects WHERE slug = ?", from.slug) > 1;

  return {
    fromId: from.id,
    fromSlug: from.slug,
    intoId: into.id,
    intoSlug: into.slug,
    sessions,
    tags: count("SELECT COUNT(*) AS n FROM project_tags WHERE project_id = ?", from.id),
    aliases: count("SELECT COUNT(*) AS n FROM aliases WHERE project_id = ?", from.id),
    compactions: count(
      "SELECT COUNT(*) AS n FROM compaction_log WHERE project_id = ?",
      from.id
    ),
    links: count("SELECT COUNT(*) AS n FROM links WHERE target_project_id = ?", from.id),
    aliasToAdd: aliasTaken ? undefined : from.slug,
  };
}

/**
 * Apply a plan. One transaction: either the whole row is folded in or nothing is.
 *
 * A half-merged project is the worst outcome available here — sessions moved but
 * the row still present, or the row gone and its tags orphaned — and with foreign
 * keys off nothing would complain.
 */
export function applyMerge(db: Database, plan: MergePlan): void {
  const run = db.transaction(() => {
    // Sessions, one at a time because each gets its own new number.
    const move = db.prepare(
      "UPDATE sessions SET project_id = ?, number = ? WHERE id = ?"
    );
    for (const s of plan.sessions) move.run(plan.intoId, s.to, s.id);

    // Tags: OR IGNORE because (project_id, tag_id) is the primary key and the
    // target may already carry the same tag.
    db.prepare(
      `INSERT OR IGNORE INTO project_tags (project_id, tag_id)
       SELECT ?, tag_id FROM project_tags WHERE project_id = ?`
    ).run(plan.intoId, plan.fromId);
    db.prepare("DELETE FROM project_tags WHERE project_id = ?").run(plan.fromId);

    // Existing aliases of the loser now point at the winner.
    db.prepare("UPDATE aliases SET project_id = ? WHERE project_id = ?").run(
      plan.intoId,
      plan.fromId
    );

    db.prepare("UPDATE compaction_log SET project_id = ? WHERE project_id = ?").run(
      plan.intoId,
      plan.fromId
    );

    // Links: same collision shape as tags, plus one extra case — a session that
    // linked to the loser may now be linking to its own project, which is not a
    // relationship worth keeping.
    db.prepare(
      `UPDATE OR IGNORE links SET target_project_id = ? WHERE target_project_id = ?`
    ).run(plan.intoId, plan.fromId);
    db.prepare("DELETE FROM links WHERE target_project_id = ?").run(plan.fromId);
    db.prepare(
      `DELETE FROM links WHERE target_project_id = ?
         AND session_id IN (SELECT id FROM sessions WHERE project_id = ?)`
    ).run(plan.intoId, plan.intoId);

    // And keep the old name resolvable.
    if (plan.aliasToAdd) {
      db.prepare("INSERT OR IGNORE INTO aliases (alias, project_id) VALUES (?, ?)").run(
        plan.aliasToAdd,
        plan.intoId
      );
    }

    db.prepare("DELETE FROM projects WHERE id = ?").run(plan.fromId);
  });

  run();
}
