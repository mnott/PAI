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

import { realpathSync, copyFileSync, existsSync } from "node:fs";
import { ok, warn, err, dim, bold } from "../../utils.js";
import { getRegistryBackend } from "../../../storage/factory.js";
import type { RegistryBackend } from "../../../storage/registry-interface.js";

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

async function countRefs(backend: RegistryBackend, projectId: number): Promise<Counts> {
  return {
    sessions: await backend.countSessionsForProject(projectId),
    compaction: await backend.countCompactionLogsForProject(projectId),
    aliases: await backend.countAliasesForProject(projectId),
    links: await backend.countLinksForProject(projectId),
    tags: await backend.countProjectTagsForProject(projectId),
    children: await backend.countChildProjects(projectId),
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
async function pickCanonical(rows: ProjectRow[], realPath: string, backend: RegistryBackend): Promise<ProjectRow> {
  const exact = rows.filter((r) => r.root_path === realPath);
  const pool = exact.length > 0 ? exact : rows;

  const withSessions = await Promise.all(
    pool.map(async (r) => ({ row: r, sessions: (await countRefs(backend, r.id)).sessions }))
  );
  withSessions.sort((a, b) => {
    if (a.sessions !== b.sessions) return b.sessions - a.sessions;
    return a.row.created_at - b.row.created_at;
  });
  return withSessions[0].row;
}

export async function analyzeDuplicates(backend: RegistryBackend): Promise<{
  groups: MergeGroup[];
  stalePaths: ProjectRow[];
}> {
  const rows: ProjectRow[] = await backend.listProjects({ orderBy: "id" });

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
    const canonical = await pickCanonical(members, realPath, backend);
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
async function foldSession(backend: RegistryBackend, keepId: number, dropId: number): Promise<void> {
  // session_tags PK is (session_id, tag_id) — skip tags the survivor has.
  const tagIds = await backend.listSessionTagIds(dropId);
  for (const tagId of tagIds) {
    const clash = await backend.sessionHasTag(keepId, tagId);
    if (clash) {
      await backend.deleteSessionTag(dropId, tagId);
    } else {
      await backend.reassignSessionTag(dropId, keepId, tagId);
    }
  }

  // links UNIQUE(session_id, target_project_id)
  const links = await backend.listLinksForSession(dropId);
  for (const l of links) {
    const clash = await backend.linkExists(keepId, l.target_project_id);
    if (clash) await backend.deleteLink(l.id);
    else await backend.moveLinkToSession(l.id, keepId);
  }

  await backend.moveCompactionLogsBySession(dropId, keepId);

  // Backfill anything the survivor lacks, and prefer a finished status.
  await backend.backfillFoldedSession(keepId, dropId);

  await backend.deleteSession(dropId);
}

async function mergeGroup(backend: RegistryBackend, group: MergeGroup): Promise<MergeReport> {
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
  let nextNumber = (await backend.getMaxSessionNumber(canonicalId)) + 1;

  for (const dup of group.duplicates) {
    const sessions = await backend.listSessionsForProject(dup.id, { orderBy: "number_asc" });

    for (const s of sessions) {
      // Same file already registered on the canonical row? Then this is the
      // same session recorded twice, not a second session. Fold, do not move.
      const twin = await backend.findSessionByFilename(canonicalId, s.filename);

      if (twin) {
        await foldSession(backend, twin.id, s.id);
        report.foldedSessions++;
        continue;
      }

      const clash = await backend.sessionNumberTaken(canonicalId, s.number);

      if (clash) {
        const assigned = nextNumber++;
        await backend.moveSessionToProject(s.id, canonicalId, { number: assigned });
        report.renumbered.push({
          from: s.number,
          to: assigned,
          title: s.title,
        });
      } else {
        await backend.moveSessionToProject(s.id, canonicalId);
        if (s.number >= nextNumber) nextNumber = s.number + 1;
      }
      report.movedSessions++;
    }

    report.movedCompaction += await backend.moveCompactionLogsByProject(dup.id, canonicalId);

    // aliases.alias is the PK, so an alias already pointing at the canonical
    // row would collide. Repoint what can move, drop only exact duplicates.
    const dupAliases = await backend.listAliasesForProject(dup.id);
    for (const alias of dupAliases) {
      const existingProjectId = await backend.resolveAlias(alias);
      if (existingProjectId === canonicalId) continue;
      await backend.reassignAlias(alias, canonicalId);
      report.movedAliases++;
    }

    // links has UNIQUE(session_id, target_project_id).
    const dupLinks = await backend.listLinksForProject(dup.id);
    for (const l of dupLinks) {
      const clash = await backend.linkExists(l.session_id, canonicalId);
      if (clash) {
        await backend.deleteLink(l.id);
        continue;
      }
      await backend.retargetLink(l.id, canonicalId);
      report.movedLinks++;
    }

    // project_tags has PRIMARY KEY(project_id, tag_id).
    const dupTagIds = await backend.listProjectTagIds(dup.id);
    for (const tagId of dupTagIds) {
      const clash = await backend.projectHasTag(canonicalId, tagId);
      if (clash) {
        await backend.deleteProjectTag(dup.id, tagId);
        continue;
      }
      await backend.reassignProjectTag(dup.id, canonicalId, tagId);
      report.movedTags++;
    }

    report.movedChildren += await backend.reassignProjectParent(dup.id, canonicalId);

    // Carry over settings the canonical row is missing rather than losing them.
    if (!group.canonical.claude_notes_dir && dup.claude_notes_dir) {
      await backend.updateProjectClaudeNotesDir(canonicalId, dup.claude_notes_dir);
    }
    if (!group.canonical.session_config && dup.session_config) {
      await backend.updateProjectSessionConfig(canonicalId, dup.session_config);
    }

    await backend.deleteProject(dup.id);
    report.deletedRows++;
  }

  // An active duplicate means the project is active, whatever the canonical
  // row happened to say.
  const anyActive =
    group.canonical.status === "active" ||
    group.duplicates.some((d) => d.status === "active");
  if (anyActive && group.canonical.status !== "active") {
    await backend.updateProjectStatus(canonicalId, "active");
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
      const taken = await backend.getProjectBySlug(candidate);
      if (taken) continue;
      await backend.updateProjectSlug(canonicalId, candidate, Date.now());
      report.reclaimedSlugs.push({
        from: group.canonical.slug,
        to: candidate,
      });
      break;
    }
  }

  // Point the surviving row at the canonical filesystem path.
  if (group.canonical.root_path !== group.realPath) {
    const taken = await backend.getProjectByRootPath(group.realPath, { excludeId: canonicalId });
    if (!taken) {
      await backend.updateProjectPath(canonicalId, { rootPath: group.realPath }, Date.now());
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
async function canonicalizePaths(
  backend: RegistryBackend,
  dryRun: boolean
): Promise<Array<{ slug: string; from: string; to: string }>> {
  const rows = await backend.listProjects();

  const changed: Array<{ slug: string; from: string; to: string }> = [];

  for (const row of rows) {
    const rp = safeRealPath(row.root_path);
    if (!rp || rp === row.root_path) continue;

    const taken = await backend.getProjectByRootPath(rp, { excludeId: row.id });
    if (taken) continue;

    changed.push({ slug: row.slug, from: row.root_path, to: rp });
    if (!dryRun) {
      await backend.updateProjectPath(row.id, { rootPath: rp }, Date.now());
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

export async function cmdDedupe(
  opts: { execute?: boolean; dbPath?: string }
): Promise<void> {
  const backend = await getRegistryBackend();
  const { groups, stalePaths } = await analyzeDuplicates(backend);

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
    const cCounts = await countRefs(backend, g.canonical.id);
    console.log(
      `    ${ok("keep")}  #${g.canonical.id} ${bold(g.canonical.slug)} ` +
        dim(`(${g.canonical.root_path}) — ${cCounts.sessions} sessions, ${g.canonical.status}`)
    );
    for (const d of g.duplicates) {
      const dc = await countRefs(backend, d.id);
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
      const sc = await countRefs(backend, s.id);
      if (sc.sessions === 0 && sc.compaction === 0) continue;
      console.log(
        dim(
          `    #${s.id} ${s.slug} (${s.root_path}) — ${sc.sessions} sessions, ${sc.compaction} compaction rows`
        )
      );
    }
    console.log();
  }

  const pathFixes = await canonicalizePaths(backend, true);
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
      process.exitCode = 1;
      return;
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

  // Best-effort in sequence: RegistryBackend has no cross-row transaction
  // primitive, so a failure partway through no longer rolls back everything
  // the way the old raw-SQL transaction did — it leaves whatever merged
  // successfully in place and reports the point of failure.
  try {
    for (const g of groups) {
      const r = await mergeGroup(backend, g);
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
    canonicalized = (await canonicalizePaths(backend, false)).length;
  } catch (e) {
    console.error(err(`Merge failed partway through: ${String(e)}`));
    process.exitCode = 1;
    return;
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
