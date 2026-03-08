/**
 * Project health check command — audits registered projects for missing paths,
 * moved directories, and orphaned note directories.
 */

import type { Database } from "better-sqlite3";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import chalk from "chalk";
import { ok, warn, err, dim, bold, header, shortenPath, now, renderTable, encodeDir } from "../../utils.js";
import type { HealthRow, HealthCategory, ProjectHealth, ProjectRow } from "./types.js";

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

function suggestMovedPath(project: ProjectRow): string | undefined {
  const name = basename(project.root_path);
  const candidates = [
    join(homedir(), "dev", name),
    join(homedir(), "dev", "ai", name),
    join(homedir(), "Desktop", name),
    join(homedir(), "Projects", name),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
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

    let category: HealthCategory;
    let suggestedPath: string | undefined;

    if (pathExists) {
      category = "active";
    } else {
      suggestedPath = suggestMovedPath(project);
      category = suggestedPath ? "stale" : "dead";
    }

    return {
      project,
      category,
      suggestedPath,
      claudeNotesExists: orphaned.length > 0,
      orphanedNotesDirs: orphaned,
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
    console.log(err("  Dead projects (path missing, no match found):"));
    for (const r of dead) {
      console.log(`    ${bold(r.project.slug)}   ${dim(r.project.root_path)}`);
      if (r.claudeNotesExists) {
        console.log(chalk.yellow(`      Notes:  ${r.orphanedNotesDirs.join(", ")}`));
      }
      if (r.project.session_count === 0 && opts.fix) {
        db.prepare("UPDATE projects SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?")
          .run(now(), now(), r.project.id);
        console.log(ok("      Auto-fixed: archived (0 sessions, path gone)"));
      } else {
        console.log(dim(`      Fix:    pai project archive ${r.project.slug}  (or  pai project move ...)`));
      }
    }
    console.log();
  }

  console.log(dim(`  ${rows.length} total: ${active.length} active, ${stale.length} stale, ${dead.length} dead`));

  if (!opts.fix && (stale.length > 0 || dead.length > 0)) {
    console.log();
    console.log(warn("  Run with --fix to auto-remediate where possible."));
  }
}
