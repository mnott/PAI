/**
 * pai registry dedupe [--execute]
 *
 * Merges registry rows that describe the same project.
 *
 * WHY THIS HAPPENS
 * ----------------
 * `projects.root_path` is UNIQUE, so two spellings of the same directory
 * register as two projects. On a machine with symlinked path prefixes
 * (`~/dev -> Cloud/Development`, say) the same repo is reachable as
 * `~/dev/ai/PAI` and `~/Daten/Cloud/Development/ai/PAI`, and the scanner
 * registers both. Every session then lands under whichever spelling the shell
 * happened to be using, so history splits: one row accumulates 95 sessions and
 * the other has none, while both claim to be the same project.
 *
 * The symptom that surfaces it is a checkpoint labelled "Unknown session" —
 * the row matching the current directory genuinely has no session rows.
 *
 * WHY realpath IS THE RIGHT KEY
 * -----------------------------
 * It removes the judgement call. Two rows whose `root_path` resolves to the
 * same inode are the same project — not "probably", definitively — so the
 * merge is mechanical. Rows that merely look similar (same display name, one
 * path a prefix of another) are left alone: deciding those is the user's call,
 * not this command's.
 *
 * NO DATA LOSS
 * ------------
 * Everything referencing a merged row is repointed, never deleted:
 * sessions (renumbered only on collision), compaction_log, aliases, links,
 * project_tags, and any child project's parent_id. The DB is backed up before
 * anything is written, and the whole merge runs in one transaction.
 */

import type { Database } from "better-sqlite3";
import { realpathSync, copyFileSync, existsSync } from "node:fs";
import { ok, warn, err, dim, bold } from "../../utils.js";

interface ProjectRow {
  id: number;
  slug: string;
  display_name: string;
  root_path: string;
  encoded_dir: string;
  status: string;
  claude_notes_dir: string | null;
  session_config: string | null;
  created_at: number;
}

interface MergeGroup {
  realPath: string;
  canonical: ProjectRow;
  duplicates: ProjectRow[];
}

interface Counts {
  sessions: number;
  compaction: number;
  aliases: number;
  links: number;
  tags: number;
  children: number;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/** Resolve a path to its canonical form, or null when it no longer exists. */
function safeRealPath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

function countRefs(db: Database, projectId: number): Counts {
  const one = (sql: string): number =>
    (db.prepare(sql).get(projectId) as { n: number }).n;

  return {
    sessions: one("SELECT COUNT(*) AS n FROM sessions WHERE project_id = ?"),
    compaction: one("SELECT COUNT(*) AS n FROM compaction_log WHERE project_id = ?"),
    aliases: one("SELECT COUNT(*) AS n FROM aliases WHERE project_id = ?"),
    links: one("SELECT COUNT(*) AS n FROM links WHERE target_project_id = ?"),
    tags: one("SELECT COUNT(*) AS n FROM project_tags WHERE project_id = ?"),
    children: one("SELECT COUNT(*) AS n FROM projects WHERE parent_id = ?"),
  };
}

/**
 * Choose which row survives.
 *
 * The row whose stored path already IS the canonical filesystem path wins:
 * keeping it means `root_path` ends up correct without rewriting it, and any
 * external reference to that path keeps resolving. Failing that, the row with
 * the most sessions wins, then the oldest.
 */
function pickCanonical(rows: ProjectRow[], realPath: string, db: Database): ProjectRow {
  const exact = rows.filter((r) => r.root_path === realPath);
  const pool = exact.length > 0 ? exact : rows;

  return [...pool].sort((a, b) => {
    const sa = countRefs(db, a.id).sessions;
    const sb = countRefs(db, b.id).sessions;
    if (sa !== sb) return sb - sa;
    return a.created_at - b.created_at;
  })[0];
}

export function analyzeDuplicates(db: Database): {
  groups: MergeGroup[];
  stalePaths: ProjectRow[];
} {
  const rows = db
    .prepare(
      `SELECT id, slug, display_name, root_path, encoded_dir, status,
              claude_notes_dir, session_config, created_at
         FROM projects ORDER BY id`
    )
    .all() as ProjectRow[];

  const byRealPath = new Map<string, ProjectRow[]>();
  const stalePaths: ProjectRow[] = [];

  for (const row of rows) {
    const rp = safeRealPath(row.root_path);
    if (!rp) {
      // The directory is gone. It cannot be proven identical to anything, so
      // it is never merged automatically — only reported.
      stalePaths.push(row);
      continue;
    }
    const bucket = byRealPath.get(rp);
    if (bucket) bucket.push(row);
    else byRealPath.set(rp, [row]);
  }

  const groups: MergeGroup[] = [];
  for (const [realPath, members] of byRealPath) {
    if (members.length < 2) continue;
    const canonical = pickCanonical(members, realPath, db);
    groups.push({
      realPath,
      canonical,
      duplicates: members.filter((m) => m.id !== canonical.id),
    });
  }

  return { groups, stalePaths };
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

interface MergeReport {
  movedSessions: number;
  foldedSessions: number;
  renumbered: Array<{ from: number; to: number; title: string }>;
  movedCompaction: number;
  movedAliases: number;
  movedLinks: number;
  movedTags: number;
  movedChildren: number;
  deletedRows: number;
  reclaimedSlugs: Array<{ from: string; to: string }>;
}

/**
 * Fold a duplicate session row into the one the canonical project already has
 * for the same note file.
 *
 * Both rows describe one file on disk — the double registration produced two
 * registry rows for it, often identical and created milliseconds apart. Moving
 * both would leave the merged project with two entries per note and force one
 * of them to a number that no longer matches its own filename.
 *
 * Nothing is discarded: tags and links are repointed at the surviving row, and
 * any field the survivor is missing is backfilled from the duplicate before it
 * is deleted.
 */
function foldSession(db: Database, keepId: number, dropId: number): void {
  // session_tags PK is (session_id, tag_id) — skip tags the survivor has.
  const tags = db
    .prepare("SELECT tag_id FROM session_tags WHERE session_id = ?")
    .all(dropId) as Array<{ tag_id: number }>;
  for (const t of tags) {
    const clash = db
      .prepare(
        "SELECT 1 FROM session_tags WHERE session_id = ? AND tag_id = ? LIMIT 1"
      )
      .get(keepId, t.tag_id);
    if (clash) {
      db.prepare(
        "DELETE FROM session_tags WHERE session_id = ? AND tag_id = ?"
      ).run(dropId, t.tag_id);
    } else {
      db.prepare(
        "UPDATE session_tags SET session_id = ? WHERE session_id = ? AND tag_id = ?"
      ).run(keepId, dropId, t.tag_id);
    }
  }

  // links UNIQUE(session_id, target_project_id)
  const links = db
    .prepare("SELECT id, target_project_id FROM links WHERE session_id = ?")
    .all(dropId) as Array<{ id: number; target_project_id: number }>;
  for (const l of links) {
    const clash = db
      .prepare(
        "SELECT 1 FROM links WHERE session_id = ? AND target_project_id = ? LIMIT 1"
      )
      .get(keepId, l.target_project_id);
    if (clash) db.prepare("DELETE FROM links WHERE id = ?").run(l.id);
    else
      db.prepare("UPDATE links SET session_id = ? WHERE id = ?").run(
        keepId,
        l.id
      );
  }

  db.prepare("UPDATE compaction_log SET session_id = ? WHERE session_id = ?").run(
    keepId,
    dropId
  );

  // Backfill anything the survivor lacks, and prefer a finished status.
  db.prepare(
    `UPDATE sessions SET
       claude_session_id = COALESCE(claude_session_id,
                                    (SELECT claude_session_id FROM sessions WHERE id = ?)),
       token_count       = COALESCE(token_count,
                                    (SELECT token_count FROM sessions WHERE id = ?)),
       closed_at         = COALESCE(closed_at,
                                    (SELECT closed_at FROM sessions WHERE id = ?)),
       status            = CASE WHEN status = 'open'
                                 AND (SELECT status FROM sessions WHERE id = ?) != 'open'
                                THEN (SELECT status FROM sessions WHERE id = ?)
                                ELSE status END
     WHERE id = ?`
  ).run(dropId, dropId, dropId, dropId, dropId, keepId);

  db.prepare("DELETE FROM sessions WHERE id = ?").run(dropId);
}

function mergeGroup(db: Database, group: MergeGroup): MergeReport {
  const report: MergeReport = {
    movedSessions: 0,
    foldedSessions: 0,
    renumbered: [],
    movedCompaction: 0,
    movedAliases: 0,
    movedLinks: 0,
    movedTags: 0,
    movedChildren: 0,
    deletedRows: 0,
    reclaimedSlugs: [],
  };

  const canonicalId = group.canonical.id;

  // Highest session number already used on the canonical row — collisions are
  // appended above it so no existing number ever has to change.
  let nextNumber =
    ((
      db
        .prepare("SELECT MAX(number) AS n FROM sessions WHERE project_id = ?")
        .get(canonicalId) as { n: number | null }
    ).n ?? 0) + 1;

  for (const dup of group.duplicates) {
    const sessions = db
      .prepare(
        "SELECT id, number, title, filename FROM sessions WHERE project_id = ? ORDER BY number"
      )
      .all(dup.id) as Array<{
      id: number;
      number: number;
      title: string;
      filename: string;
    }>;

    for (const s of sessions) {
      // Same file already registered on the canonical row? Then this is the
      // same session recorded twice, not a second session. Fold, do not move.
      const twin = db
        .prepare(
          "SELECT id FROM sessions WHERE project_id = ? AND filename = ? LIMIT 1"
        )
        .get(canonicalId, s.filename) as { id: number } | undefined;

      if (twin) {
        foldSession(db, twin.id, s.id);
        report.foldedSessions++;
        continue;
      }

      const clash = db
        .prepare(
          "SELECT 1 FROM sessions WHERE project_id = ? AND number = ? LIMIT 1"
        )
        .get(canonicalId, s.number);

      if (clash) {
        const assigned = nextNumber++;
        db.prepare(
          "UPDATE sessions SET project_id = ?, number = ? WHERE id = ?"
        ).run(canonicalId, assigned, s.id);
        report.renumbered.push({
          from: s.number,
          to: assigned,
          title: s.title,
        });
      } else {
        db.prepare("UPDATE sessions SET project_id = ? WHERE id = ?").run(
          canonicalId,
          s.id
        );
        if (s.number >= nextNumber) nextNumber = s.number + 1;
      }
      report.movedSessions++;
    }

    report.movedCompaction += db
      .prepare("UPDATE compaction_log SET project_id = ? WHERE project_id = ?")
      .run(canonicalId, dup.id).changes;

    // aliases.alias is the PK, so an alias already pointing at the canonical
    // row would collide. Repoint what can move, drop only exact duplicates.
    const dupAliases = db
      .prepare("SELECT alias FROM aliases WHERE project_id = ?")
      .all(dup.id) as Array<{ alias: string }>;
    for (const a of dupAliases) {
      const existing = db
        .prepare("SELECT project_id FROM aliases WHERE alias = ?")
        .get(a.alias) as { project_id: number } | undefined;
      if (existing && existing.project_id === canonicalId) continue;
      db.prepare("UPDATE aliases SET project_id = ? WHERE alias = ?").run(
        canonicalId,
        a.alias
      );
      report.movedAliases++;
    }

    // links has UNIQUE(session_id, target_project_id).
    const dupLinks = db
      .prepare("SELECT id, session_id FROM links WHERE target_project_id = ?")
      .all(dup.id) as Array<{ id: number; session_id: number }>;
    for (const l of dupLinks) {
      const clash = db
        .prepare(
          "SELECT 1 FROM links WHERE session_id = ? AND target_project_id = ? LIMIT 1"
        )
        .get(l.session_id, canonicalId);
      if (clash) {
        db.prepare("DELETE FROM links WHERE id = ?").run(l.id);
        continue;
      }
      db.prepare("UPDATE links SET target_project_id = ? WHERE id = ?").run(
        canonicalId,
        l.id
      );
      report.movedLinks++;
    }

    // project_tags has PRIMARY KEY(project_id, tag_id).
    const dupTags = db
      .prepare("SELECT tag_id FROM project_tags WHERE project_id = ?")
      .all(dup.id) as Array<{ tag_id: number }>;
    for (const t of dupTags) {
      const clash = db
        .prepare(
          "SELECT 1 FROM project_tags WHERE project_id = ? AND tag_id = ? LIMIT 1"
        )
        .get(canonicalId, t.tag_id);
      if (clash) {
        db.prepare(
          "DELETE FROM project_tags WHERE project_id = ? AND tag_id = ?"
        ).run(dup.id, t.tag_id);
        continue;
      }
      db.prepare(
        "UPDATE project_tags SET project_id = ? WHERE project_id = ? AND tag_id = ?"
      ).run(canonicalId, dup.id, t.tag_id);
      report.movedTags++;
    }

    report.movedChildren += db
      .prepare("UPDATE projects SET parent_id = ? WHERE parent_id = ?")
      .run(canonicalId, dup.id).changes;

    // Carry over settings the canonical row is missing rather than losing them.
    if (!group.canonical.claude_notes_dir && dup.claude_notes_dir) {
      db.prepare("UPDATE projects SET claude_notes_dir = ? WHERE id = ?").run(
        dup.claude_notes_dir,
        canonicalId
      );
    }
    if (!group.canonical.session_config && dup.session_config) {
      db.prepare("UPDATE projects SET session_config = ? WHERE id = ?").run(
        dup.session_config,
        canonicalId
      );
    }

    db.prepare("DELETE FROM projects WHERE id = ?").run(dup.id);
    report.deletedRows++;
  }

  // An active duplicate means the project is active, whatever the canonical
  // row happened to say.
  const anyActive =
    group.canonical.status === "active" ||
    group.duplicates.some((d) => d.status === "active");
  if (anyActive && group.canonical.status !== "active") {
    db.prepare("UPDATE projects SET status = 'active' WHERE id = ?").run(
      canonicalId
    );
  }

  // Reclaim the good slug.
  //
  // The duplicate rows were created in path order, so the plain slug ("pai")
  // usually went to whichever spelling was seen first and the canonical row —
  // chosen by filesystem path, not by name — ended up with the suffixed one
  // ("pai-2"). Now that the duplicates are gone their names are free, so take
  // the best one back rather than leaving the merged project called "pai-2".
  const suffixed = /^(.*)-\d+$/.exec(group.canonical.slug);
  if (suffixed) {
    const candidates = [
      suffixed[1],
      ...group.duplicates.map((d) => d.slug).filter((s) => !/-\d+$/.test(s)),
    ];
    for (const candidate of candidates) {
      const taken = db
        .prepare("SELECT 1 FROM projects WHERE slug = ? LIMIT 1")
        .get(candidate);
      if (taken) continue;
      db.prepare("UPDATE projects SET slug = ?, updated_at = ? WHERE id = ?").run(
        candidate,
        Date.now(),
        canonicalId
      );
      report.reclaimedSlugs.push({
        from: group.canonical.slug,
        to: candidate,
      });
      break;
    }
  }

  // Point the surviving row at the canonical filesystem path.
  if (group.canonical.root_path !== group.realPath) {
    const taken = db
      .prepare("SELECT id FROM projects WHERE root_path = ? AND id != ?")
      .get(group.realPath, canonicalId);
    if (!taken) {
      db.prepare(
        "UPDATE projects SET root_path = ?, updated_at = ? WHERE id = ?"
      ).run(group.realPath, Date.now(), canonicalId);
    }
  }

  return report;
}

/**
 * Rewrite any remaining root_path that is not already its canonical form.
 *
 * Merging fixes the rows that already split. This stops the rest from
 * splitting later: a project registered only as `~/dev/ai/PAILot` still has a
 * non-canonical path, so the first session started from the other spelling
 * would create a second row and the whole problem recurs.
 *
 * Only rows whose canonical path is free are touched — a collision would mean
 * a duplicate, and those have already been merged.
 */
function canonicalizePaths(
  db: Database,
  dryRun: boolean
): Array<{ slug: string; from: string; to: string }> {
  const rows = db
    .prepare("SELECT id, slug, root_path FROM projects")
    .all() as Array<{ id: number; slug: string; root_path: string }>;

  const changed: Array<{ slug: string; from: string; to: string }> = [];

  for (const row of rows) {
    const rp = safeRealPath(row.root_path);
    if (!rp || rp === row.root_path) continue;

    const taken = db
      .prepare("SELECT 1 FROM projects WHERE root_path = ? AND id != ? LIMIT 1")
      .get(rp, row.id);
    if (taken) continue;

    changed.push({ slug: row.slug, from: row.root_path, to: rp });
    if (!dryRun) {
      db.prepare(
        "UPDATE projects SET root_path = ?, updated_at = ? WHERE id = ?"
      ).run(rp, Date.now(), row.id);
    }
  }

  return changed;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

function backupDb(dbPath: string): string | null {
  if (!existsSync(dbPath)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = `${dbPath}.bak-${stamp}`;
  try {
    copyFileSync(dbPath, dest);
    // Copy the WAL too — without it the backup can miss committed pages.
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(dbPath + suffix)) {
        copyFileSync(dbPath + suffix, dest + suffix);
      }
    }
    return dest;
  } catch {
    return null;
  }
}

export function cmdDedupe(
  db: Database,
  opts: { execute?: boolean; dbPath?: string }
): void {
  const { groups, stalePaths } = analyzeDuplicates(db);

  console.log();
  console.log(
    bold(
      opts.execute
        ? "  pai registry dedupe"
        : "  pai registry dedupe — DRY RUN (no changes will be made)"
    )
  );
  console.log();

  if (groups.length === 0) {
    console.log(ok("No duplicate projects found — every root_path resolves uniquely."));
  }

  for (const g of groups) {
    console.log(`  ${bold(g.realPath)}`);
    const cCounts = countRefs(db, g.canonical.id);
    console.log(
      `    ${ok("keep")}  #${g.canonical.id} ${bold(g.canonical.slug)} ` +
        dim(`(${g.canonical.root_path}) — ${cCounts.sessions} sessions, ${g.canonical.status}`)
    );
    for (const d of g.duplicates) {
      const dc = countRefs(db, d.id);
      const moving = [
        dc.sessions ? `${dc.sessions} sessions` : null,
        dc.compaction ? `${dc.compaction} compaction rows` : null,
        dc.aliases ? `${dc.aliases} aliases` : null,
        dc.links ? `${dc.links} links` : null,
        dc.tags ? `${dc.tags} tags` : null,
        dc.children ? `${dc.children} child projects` : null,
      ]
        .filter(Boolean)
        .join(", ");
      console.log(
        `    ${warn("merge")} #${d.id} ${bold(d.slug)} ` +
          dim(`(${d.root_path}) — ${moving || "nothing to move"}`)
      );
    }
    console.log();
  }

  if (stalePaths.length > 0) {
    console.log(
      dim(
        `  ${stalePaths.length} project(s) point at a path that no longer exists.`
      )
    );
    console.log(
      dim(
        "  These are never merged automatically — a missing directory cannot be"
      )
    );
    console.log(dim("  proven identical to anything else. Listed for review:"));
    for (const s of stalePaths) {
      const sc = countRefs(db, s.id);
      if (sc.sessions === 0 && sc.compaction === 0) continue;
      console.log(
        dim(
          `    #${s.id} ${s.slug} (${s.root_path}) — ${sc.sessions} sessions, ${sc.compaction} compaction rows`
        )
      );
    }
    console.log();
  }

  const pathFixes = canonicalizePaths(db, true);
  if (pathFixes.length > 0) {
    console.log(
      dim(
        `  ${pathFixes.length} project(s) stored under a non-canonical path — these would`
      )
    );
    console.log(
      dim(
        "  split into a second row the first time a session runs from the other"
      )
    );
    console.log(dim("  spelling. They will be rewritten to their resolved path:"));
    for (const p of pathFixes.slice(0, 8)) {
      console.log(dim(`    ${p.slug}: ${p.from} -> ${p.to}`));
    }
    if (pathFixes.length > 8) {
      console.log(dim(`    ... and ${pathFixes.length - 8} more`));
    }
    console.log();
  }

  if (!opts.execute) {
    if (groups.length > 0 || pathFixes.length > 0) {
      console.log(dim("  Re-run with --execute to apply. The registry is backed up first."));
      console.log();
    }
    return;
  }

  if (groups.length === 0 && pathFixes.length === 0) return;

  // ---- Back up before touching anything ----
  const dbPath = opts.dbPath;
  if (dbPath) {
    const backup = backupDb(dbPath);
    if (backup) {
      console.log(ok(`Registry backed up to ${bold(backup)}`));
    } else {
      console.error(
        err("Could not back up the registry — refusing to merge without one.")
      );
      process.exit(1);
    }
  }

  // ---- Merge, all-or-nothing ----
  const totals: MergeReport = {
    movedSessions: 0,
    foldedSessions: 0,
    renumbered: [],
    movedCompaction: 0,
    movedAliases: 0,
    movedLinks: 0,
    movedTags: 0,
    movedChildren: 0,
    deletedRows: 0,
    reclaimedSlugs: [],
  };

  let canonicalized = 0;

  const run = db.transaction(() => {
    for (const g of groups) {
      const r = mergeGroup(db, g);
      totals.movedSessions += r.movedSessions;
      totals.foldedSessions += r.foldedSessions;
      totals.renumbered.push(...r.renumbered);
      totals.movedCompaction += r.movedCompaction;
      totals.movedAliases += r.movedAliases;
      totals.movedLinks += r.movedLinks;
      totals.movedTags += r.movedTags;
      totals.movedChildren += r.movedChildren;
      totals.deletedRows += r.deletedRows;
      totals.reclaimedSlugs.push(...r.reclaimedSlugs);
    }
    // After merging, the remaining collisions are gone, so the rest of the
    // registry can be moved onto canonical paths safely.
    canonicalized = canonicalizePaths(db, false).length;
  });

  try {
    run();
  } catch (e) {
    console.error(err(`Merge failed and was rolled back: ${String(e)}`));
    process.exit(1);
  }

  console.log();
  console.log(ok(`Merged ${totals.deletedRows} duplicate row(s).`));
  console.log(`    sessions moved:        ${totals.movedSessions}`);
  console.log(
    `    sessions folded:       ${totals.foldedSessions} ` +
      dim("(same note file registered twice)")
  );
  console.log(`    compaction rows moved: ${totals.movedCompaction}`);
  console.log(`    aliases moved:         ${totals.movedAliases}`);
  console.log(`    links moved:           ${totals.movedLinks}`);
  console.log(`    tags moved:            ${totals.movedTags}`);
  console.log(`    child projects moved:  ${totals.movedChildren}`);
  console.log(`    paths canonicalized:   ${canonicalized}`);

  if (totals.reclaimedSlugs.length > 0) {
    console.log();
    console.log(ok("Slugs reclaimed from the merged rows:"));
    for (const s of totals.reclaimedSlugs) {
      console.log(dim(`    ${s.from} -> ${s.to}`));
    }
  }

  if (totals.renumbered.length > 0) {
    console.log();
    console.log(
      warn(`${totals.renumbered.length} session(s) renumbered to avoid collisions:`)
    );
    for (const r of totals.renumbered) {
      console.log(dim(`    ${r.from} -> ${r.to}  ${r.title}`));
    }
    console.log(
      dim("    Session note filenames on disk are unchanged — only the registry number moved.")
    );
    console.log();
    console.log(
      warn(
        "    A renumbered session's registry number no longer matches the number in its"
      )
    );
    console.log(
      dim(
        "    filename. The scanner keys sessions by (project, number), so a note whose\n" +
          "    number is now occupied cannot be re-registered until numbering is reconciled.\n" +
          "    Run `pai session cleanup <slug> --execute` on the affected projects to renumber\n" +
          "    notes and registry together."
      )
    );
  }
  console.log();
}
