/**
 * `pai project here <name>` — "this directory is that project".
 *
 * Directories move. They get renamed, reorganised into an archive tree, reached
 * through a symlinked parent. Every existing way to fix the registry afterwards
 * asks for something the user has to look up — `rebind` and `move` want a slug
 * AND a path, `add` wants a path — which means the moment you are standing in
 * the directory and know perfectly well what it is, you still cannot just say so.
 *
 * This command is that sentence. Run it in the directory, name the project, and
 * the registry points here. If no project by that name exists, it is created.
 *
 * Two details that matter more than they look:
 *
 * 1. The path is canonicalised with realpath. `resolve()` keeps whichever
 *    spelling was typed, so a directory reachable through a symlinked parent
 *    encodes two different ways and can be registered TWICE as two unrelated
 *    projects — with sessions split across both. Storing the canonical path is
 *    what makes "this directory" mean one row.
 *
 * 2. Matching accepts the name a human uses. The display name, the slug, and
 *    all-query-words-present, in that order, so a project whose directory has
 *    since gained or lost a word is still reachable by the name its owner
 *    thinks of it by.
 */

import type { Database } from "better-sqlite3";
import { realpathSync } from "node:fs";
import { ok, err, dim, bold, encodeDir, now } from "../../utils.js";

interface ProjectRow {
  id: number;
  slug: string;
  display_name: string;
  root_path: string;
  status: string;
}

/** Normalise for name comparison: lowercase, collapse whitespace and hyphens. */
function norm(s: string): string {
  return s.toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Find the project a human means by `name`.
 *
 * Exact display-name or slug first. Only if that finds nothing do we fall back
 * to requiring every query word to appear, which is deliberately narrower than
 * a substring match: it reaches "Jobs Search Beta" from "jobs beta" without
 * also reaching a sibling project that merely shares the first word.
 */
export function findProjectsByName(db: Database, name: string): ProjectRow[] {
  const rows = db
    .prepare("SELECT id, slug, display_name, root_path, status FROM projects")
    .all() as ProjectRow[];

  const q = norm(name);
  const exact = rows.filter((r) => norm(r.display_name) === q || norm(r.slug) === q);
  if (exact.length > 0) return exact;

  const words = q.split(" ").filter(Boolean);
  if (words.length === 0) return [];
  return rows.filter((r) => {
    const hay = `${norm(r.display_name)} ${norm(r.slug)}`;
    return words.every((w) => hay.includes(w));
  });
}

/** Slug from a display name: lowercase, non-alphanumerics to hyphens. */
export function slugFromName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project"
  );
}

export function cmdHere(
  db: Database,
  name: string,
  opts: { cwd?: string; dryRun?: boolean } = {}
): void {
  // Canonicalise: see note 1 above. A symlinked parent must not create a second
  // identity for the same directory.
  let target: string;
  try {
    target = realpathSync(opts.cwd ?? process.cwd());
  } catch {
    console.error(err(`Cannot resolve the current directory.`));
    process.exit(1);
    return;
  }

  const encoded = encodeDir(target);
  const matches = findProjectsByName(db, name);

  if (matches.length > 1) {
    console.error(
      err(`"${name}" matches ${matches.length} projects — name one exactly:\n`) +
        matches.map((m) => dim(`  ${m.slug}  (${m.display_name})\n`)).join("")
    );
    process.exit(1);
    return;
  }

  // Another project already owns this directory: refuse rather than create a
  // duplicate row for a path that is already spoken for.
  const owner = db
    .prepare("SELECT id, slug, display_name FROM projects WHERE encoded_dir = ?")
    .get(encoded) as Pick<ProjectRow, "id" | "slug" | "display_name"> | undefined;

  if (matches.length === 1) {
    const p = matches[0];

    if (owner && owner.id !== p.id) {
      console.error(
        err(`This directory is already registered to ${bold(owner.slug)}.\n`) +
          dim(`  ${target}\n`) +
          dim(`  Merge them: pai project merge ${owner.slug} ${p.slug} --execute`)
      );
      process.exit(1);
      return;
    }

    // Already correct — say so instead of writing an identical row. Compared by
    // realpath, so a differently-spelled but equivalent path counts as correct.
    let sameAlready = false;
    try {
      sameAlready = realpathSync(p.root_path) === target;
    } catch {
      sameAlready = false;
    }
    if (sameAlready) {
      console.log(ok(`Already set: ${bold(p.display_name)}`));
      console.log(dim(`  ${target}`));
      return;
    }

    if (opts.dryRun) {
      console.log(dim(`Would repoint ${p.slug}:`));
      console.log(dim(`  from ${p.root_path}`));
      console.log(dim(`  to   ${target}`));
      return;
    }

    db.prepare(
      "UPDATE projects SET root_path = ?, encoded_dir = ?, updated_at = ? WHERE id = ?"
    ).run(target, encoded, now(), p.id);

    console.log(ok(`${bold(p.display_name)} is now here`));
    console.log(dim(`  was: ${p.root_path}`));
    console.log(dim(`  now: ${target}`));
    return;
  }

  // No project by that name — create it pointing here.
  if (owner) {
    console.error(
      err(`This directory is already registered as ${bold(owner.slug)} (${owner.display_name}).\n`) +
        dim(`  Rename it instead: pai project edit ${owner.slug} --display-name "${name}"`)
    );
    process.exit(1);
    return;
  }

  const slug = slugFromName(name);
  const taken = db.prepare("SELECT 1 FROM projects WHERE slug = ?").get(slug);
  const finalSlug = taken ? `${slug}-${encoded.slice(-6)}` : slug;

  if (opts.dryRun) {
    console.log(dim(`Would create ${finalSlug} (${name}) at ${target}`));
    return;
  }

  const ts = now();
  db.prepare(
    `INSERT INTO projects (slug, display_name, root_path, encoded_dir, type, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'local', 'active', ?, ?)`
  ).run(finalSlug, name, target, encoded, ts, ts);

  console.log(ok(`Created ${bold(name)}`));
  console.log(dim(`  slug: ${finalSlug}`));
  console.log(dim(`  path: ${target}`));
}
