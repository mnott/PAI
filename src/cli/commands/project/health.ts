/**
 * Project health check command — audits registered projects for missing paths,
 * moved directories, and orphaned note directories.
 */

import type { Database } from "better-sqlite3";
import { existsSync, readdirSync, statSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import chalk from "chalk";
import { ok, warn, err, dim, bold, header, shortenPath, now, renderTable, encodeDir } from "../../utils.js";
import type {
  HealthRow,
  HealthCategory,
  HealthReason,
  ProjectHealth,
  ProjectRow,
} from "./types.js";
import { suggestMovedPath } from "./relocate.js";
import { unregistrableReason } from "../../../registry/registrable.js";

function findOrphanedNotesDirs(project: ProjectRow): string[] {
  const claudeProjects = join(homedir(), ".claude", "projects");
  if (!existsSync(claudeProjects)) return [];

  const expected = encodeDir(project.root_path);
  const results: string[] = [];

  try {
    for (const entry of readdirSync(claudeProjects)) {
      const full = join(claudeProjects, entry);
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      if (entry === expected || entry === project.encoded_dir) {
        const notesDir = join(full, "Notes");
        if (existsSync(notesDir)) {
          results.push(notesDir);
        }
      }
    }
  } catch {
    // Unreadable — ignore
  }
  return results;
}

/*
 * suggestMovedPath now lives in relocate.ts, which walks to the deepest surviving
 * ancestor and re-matches the rest by normalised name.
 *
 * What was here looked for the project's BASENAME in four hardcoded directories,
 * so it could only recognise "the leaf moved somewhere I already know about". It
 * could not see the failure that actually happened: renaming `Ideaverse` to
 * `🧠 Ideaverse` left 32 registered projects exactly where they were and made
 * every one of them unreachable, and this function reported them dead and offered
 * to archive them.
 *
 * The basename guess is kept, second, since it answers the other question.
 */

/**
 * Why a row is unhealthy, and what to do about it.
 *
 * `category` said only dead / stale / active, and "archive" was offered as the
 * remedy for everything. Four different situations were collapsed into that, and
 * archiving is right for exactly one of them:
 *
 *   EPHEMERAL   the path is a worktree or a temp dir — it should never have been
 *               registered. Checked FIRST, deliberately: a temp path whose
 *               directory has also vanished is both ephemeral and dead, and
 *               "should never have been registered" is the stronger and more
 *               actionable statement. Without a stated precedence the same row
 *               gets different labels depending on evaluation order.
 *   DUPLICATE   the path is gone and another project owns where it went. Its
 *               sessions are the only thing of value on it, so the remedy is
 *               merge — archiving strands them.
 *   MISNAMED    the path EXISTS and another project owns a subtree of it, under a
 *               slug that has nothing to do with it. `pferde` on `08 - Others/MDF`.
 *               health never reported this at all, because existsSync says yes.
 *   DEAD        the path is gone and nothing claims it. Archive is correct here.
 *
 * The action must never name a command that destroys a row holding sessions —
 * a wrong command in an action field reads as vetted.
 */
function diagnose(
  project: HealthRow,
  pathExists: boolean,
  others: HealthRow[]
): { reason?: HealthReason; owner?: string; action?: string } {
  const ephemeral = unregistrableReason(project.root_path);
  if (ephemeral) {
    return {
      reason: "ephemeral",
      action:
        project.session_count > 0
          ? `holds ${project.session_count} session(s) — pai project merge ${project.slug} <durable-project> --execute, then unregister`
          : `pai project unregister ${project.slug} --execute  (${ephemeral})`,
    };
  }

  if (pathExists) {
    // A live directory that another project owns a piece of, under an unrelated
    // slug. Only reported when the other project sits BENEATH this one, which is
    // the shape actually observed; two unrelated roots are not each other's problem.
    const nested = others.find(
      (o) =>
        o.status === "active" &&
        o.root_path.startsWith(project.root_path + "/") &&
        existsSync(o.root_path)
    );
    if (nested && project.status !== "active") {
      return {
        reason: "misnamed",
        owner: nested.slug,
        action: `live directory, but ${nested.slug} owns a subtree of it — rename, or pai project merge ${project.slug} ${nested.slug}`,
      };
    }
    return {};
  }

  // Path is gone. Does an active project already own where this one would go?
  const suggestion = suggestMovedPath(project.root_path, []);
  if (suggestion) {
    const owner = others.find(
      (o) => o.root_path === suggestion || realpathEq(o.root_path, suggestion)
    );
    if (owner) {
      return {
        reason: "duplicate",
        owner: owner.slug,
        action:
          project.session_count > 0
            ? `pai project merge ${project.slug} ${owner.slug}  (moves ${project.session_count} session(s))`
            : `pai project merge ${project.slug} ${owner.slug}  (no sessions — a plain drop)`,
      };
    }
  }

  return {
    reason: "dead",
    action:
      project.session_count > 0
        ? `holds ${project.session_count} session(s) — merge before archiving, or they become unreachable`
        : `pai project archive ${project.slug}`,
  };
}

/** Same directory under two spellings — symlinks, not string equality. */
function realpathEq(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

export function cmdHealth(
  db: Database,
  opts: { fix?: boolean; json?: boolean; status?: string }
): void {
  const rows = db
    .prepare(
      `SELECT p.*,
         (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id) AS session_count
       FROM projects p
       ORDER BY p.status ASC, p.updated_at DESC`
    )
    .all() as HealthRow[];

  const results: ProjectHealth[] = rows.map((project) => {
    const pathExists = existsSync(project.root_path);
    const orphaned = findOrphanedNotesDirs(project);

    const others = rows.filter((r) => r.id !== project.id);

    let category: HealthCategory;
    let suggestedPath: string | undefined;

    if (pathExists) {
      category = "active";
    } else {
      // Every OTHER project's root, so a repair cannot point this entry at a
      // directory another project already owns.
      suggestedPath = suggestMovedPath(
        project.root_path,
        others.map((r) => r.root_path)
      );
      category = suggestedPath ? "stale" : "dead";
    }

    const { reason, owner, action } = diagnose(project, pathExists, others);

    return {
      project,
      category,
      suggestedPath,
      claudeNotesExists: orphaned.length > 0,
      orphanedNotesDirs: orphaned,
      reason,
      owner,
      action,
    };
  });

  const filtered = opts.status ? results.filter((r) => r.category === opts.status) : results;

  if (opts.json) {
    console.log(JSON.stringify(
      filtered.map((r) => ({
        slug: r.project.slug,
        root_path: r.project.root_path,
        status: r.project.status,
        health: r.category,
        session_count: r.project.session_count,
        suggested_path: r.suggestedPath ?? null,
        claude_notes_exists: r.claudeNotesExists,
        orphaned_notes_dirs: r.orphanedNotesDirs,
        // Added fields, not renamed ones: `health` keeps its old values so any
        // existing consumer keeps working.
        reason: r.reason ?? null,
        owner: r.owner ?? null,
        action: r.action ?? null,
      })),
      null,
      2
    ));
    return;
  }

  const active = filtered.filter((r) => r.category === "active");
  const stale = filtered.filter((r) => r.category === "stale");
  const dead = filtered.filter((r) => r.category === "dead");

  console.log();
  console.log(header("  PAI Project Health Report"));
  console.log();
  console.log(
    `  ${chalk.green("Active:")} ${active.length}   ${chalk.yellow("Stale (moved?):")} ${stale.length}   ${chalk.red("Dead (missing):")} ${dead.length}`
  );
  console.log();

  if (active.length) {
    console.log(bold("  Active projects (path exists):"));
    const tableRows = active.map((r) => [
      bold(r.project.slug),
      dim(shortenPath(r.project.root_path, 50)),
      String(r.project.session_count),
      r.claudeNotesExists ? chalk.green("yes") : dim("no"),
    ]);
    console.log(
      renderTable(["Slug", "Path", "Sessions", "Claude Notes"], tableRows)
        .split("\n").map((l) => "  " + l).join("\n")
    );
    console.log();
  }

  if (stale.length) {
    console.log(warn("  Stale projects (path missing, possible new location found):"));
    for (const r of stale) {
      console.log(`    ${bold(r.project.slug)}`);
      console.log(dim(`      Old path:   ${r.project.root_path}`));
      console.log(chalk.cyan(`      Found at:   ${r.suggestedPath}`));
      if (r.claudeNotesExists) {
        console.log(chalk.green(`      Notes:      ${r.orphanedNotesDirs.join(", ")}`));
      }
      if (opts.fix && r.suggestedPath) {
        const ts = now();
        const newEncoded = encodeDir(r.suggestedPath);
        db.prepare("UPDATE projects SET root_path = ?, encoded_dir = ?, updated_at = ? WHERE id = ?")
          .run(r.suggestedPath, newEncoded, ts, r.project.id);
        console.log(ok(`      Auto-fixed: updated path to ${r.suggestedPath}`));
      } else if (r.suggestedPath) {
        console.log(dim(`      Fix:        pai project move ${r.project.slug} ${r.suggestedPath}`));
      }
    }
    console.log();
  }

  if (dead.length) {
    console.log(err("  Unreachable projects (path missing):"));
    for (const r of dead) {
      const label = r.reason && r.reason !== "dead" ? warn(`  [${r.reason}]`) : "";
      console.log(`    ${bold(r.project.slug)}   ${dim(r.project.root_path)}${label}`);
      if (r.claudeNotesExists) {
        console.log(chalk.yellow(`      Notes:  ${r.orphanedNotesDirs.join(", ")}`));
      }
      // Only archive rows that are genuinely dead. A duplicate's sessions are the
      // only thing of value on it, and an ephemeral row wants unregistering, not
      // filing away — auto-archiving either was the bug behind this whole item.
      if (r.project.session_count === 0 && opts.fix && r.reason === "dead") {
        db.prepare("UPDATE projects SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?")
          .run(now(), now(), r.project.id);
        console.log(ok("      Auto-fixed: archived (0 sessions, path gone, nothing claims it)"));
      } else if (r.action) {
        console.log(dim(`      Do:     ${r.action}`));
      }
    }
    console.log();
  }

  // "active" is the one word in this output that means something else elsewhere,
  // so say which thing it is.
  //
  // This command's "active" is "the path exists on disk". The registry's `status`
  // column also says active, meaning "not archived". They are different
  // predicates over the same rows and they disagree by a lot: measured
  // 2026-08-04, 124 paths present against 99 registry-active, because 29 ARCHIVED
  // projects still have their directory. A careful reader took the 124 as a
  // registry figure today and drew a wrong conclusion from it, which is a fair
  // reading of a line that just said "124 active".
  const archivedButPresent = results.filter(
    (r) => r.category === "active" && r.project.status !== "active"
  ).length;

  console.log(
    dim(
      `  ${rows.length} total: ${active.length} with the path present, ` +
        `${stale.length} stale, ${dead.length} dead`
    )
  );
  if (archivedButPresent > 0) {
    console.log(
      dim(
        `  ${archivedButPresent} of those ${active.length} are archived in the registry — ` +
          `"present" here is about the directory, not the registry status.`
      )
    );
  }

  if (!opts.fix && (stale.length > 0 || dead.length > 0)) {
    console.log();
    console.log(warn("  Run with --fix to auto-remediate where possible."));
  }
}
