/**
 * Core project CRUD commands: add, list, info, archive, unarchive, move, tag,
 * alias, edit, detect, consolidate, go, rebind — plus private helpers levenshtein,
 * containsIgnoreCase, findProjectNotesDirs, and findMovedPath.
 */

import {
  existsSync,
  readdirSync,
  statSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { join, basename, resolve } from "node:path";
import { homedir } from "node:os";
import chalk from "chalk";
import { unregistrableReason } from "../../../registry/registrable.js";
import { getRegistryBackend } from "../../../storage/factory.js";
import type { Project } from "../../../storage/registry-interface.js";
import {
  ok,
  warn,
  err,
  dim,
  bold,
  header,
  slugFromPath,
  encodeDir,
  resolvePath,
  scaffoldProjectDirs,
  renderTable,
  shortenPath,
  fmtDate,
  now,
} from "../../utils.js";
import {
  detectProject,
  formatDetection,
  formatDetectionJson,
} from "../detect.js";
import { ensurePaiMarker } from "../../../registry/pai-marker.js";
import type { ProjectRow, SessionRow } from "./types.js";
import {
  requireProject,
  resolveIdentifier,
  getProject,
  getProjectTags,
  getProjectAliases,
  getSessionCount,
  getLastSessionDate,
  upsertTag,
} from "./helpers.js";
import { loadScanConfig, resolveHome } from "../registry/scan.js";

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function containsIgnoreCase(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function findProjectNotesDirs(project: ProjectRow): {
  encodedDir: string;
  fullPath: string;
  notesPath: string;
  noteCount: number;
}[] {
  const claudeProjects = join(homedir(), ".claude", "projects");
  if (!existsSync(claudeProjects)) return [];

  const results: {
    encodedDir: string;
    fullPath: string;
    notesPath: string;
    noteCount: number;
  }[] = [];
  const rootEncoded = encodeDir(project.root_path);

  try {
    for (const entry of readdirSync(claudeProjects)) {
      const full = join(claudeProjects, entry);
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }

      if (entry !== rootEncoded && !entry.startsWith(rootEncoded)) continue;

      const notesPath = join(full, "Notes");
      if (!existsSync(notesPath)) continue;

      let noteCount = 0;
      try {
        noteCount = readdirSync(notesPath).filter(
          (f) => f.endsWith(".md") || f.endsWith(".txt")
        ).length;
      } catch {
        // count stays 0
      }

      results.push({ encodedDir: entry, fullPath: full, notesPath, noteCount });
    }
  } catch {
    // Unreadable — ignore
  }

  return results;
}

// ---------------------------------------------------------------------------
// Moved-project detection
// ---------------------------------------------------------------------------

// Directories to skip during filesystem walk
const SKIP_DIRS = new Set([
  ".git", "node_modules", ".next", ".nuxt", "dist", "build", "coverage",
  ".cache", "__pycache__", "vendor", ".svn", ".hg", "venv", ".venv",
  "target",  // Rust/Java build dir
  "Notes",   // PAI session notes — not project roots
]);

/**
 * Walk `dir` up to `maxDepth` levels deep, collecting all subdirectory paths
 * whose basename matches `targetBasename` (case-insensitive on macOS/case-sensitive
 * on Linux, whichever is appropriate — we use exact case matching to keep it
 * correct and fast).
 *
 * Skips hidden directories and known build/tool dirs.
 * Stops walking a branch if the deadline is exceeded (returns partial results).
 */
function walkForBasename(
  dir: string,
  targetBasename: string,
  maxDepth: number,
  deadline: number,
  results: string[]
): void {
  if (Date.now() > deadline) return;
  if (maxDepth <= 0) return;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (Date.now() > deadline) return;
    if (entry.startsWith(".")) continue;
    if (SKIP_DIRS.has(entry)) continue;

    const full = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;

    // Case-insensitive comparison for the target basename (handles macOS APFS)
    if (entry.toLowerCase() === targetBasename.toLowerCase()) {
      results.push(full);
      // Don't recurse into the match itself — we want the directory, not children
      continue;
    }

    walkForBasename(full, targetBasename, maxDepth - 1, deadline, results);
  }
}

/**
 * Try to find where a project has moved.
 *
 * Searches scan_dirs from config (plus a set of common fallback dirs) for a
 * directory whose basename matches the basename of the registered root_path.
 *
 * Returns:
 *   { found: string }   — exactly one match found
 *   { ambiguous: string[] }  — multiple matches found
 *   { found: undefined }     — no match found (or timed out)
 */
export function findMovedPath(registeredPath: string): { found?: string; ambiguous?: string[] } {
  const targetBasename = basename(registeredPath);
  const config = loadScanConfig();
  const deadline = Date.now() + 5_000; // 5-second max

  // Build the list of top-level directories to search
  const home = homedir();
  const configDirs = (config.scan_dirs ?? []).map((d) => resolveHome(d));

  // Walk UP the registered path to find the deepest existing ancestor.
  // This is the best search root when a project has moved within the same tree.
  // e.g. ~/Cloud/Ablage/2025/Project → ~/Cloud/Ablage/2026/Project
  //      Deepest existing ancestor: ~/Cloud/Ablage (if 2025 is gone but Ablage exists)
  function deepestExistingAncestor(p: string): string | null {
    let current = p;
    while (true) {
      const parent = join(current, "..");
      if (parent === current) return null; // filesystem root
      if (parent === home) return null;    // don't use home itself as search root
      if (existsSync(parent)) return parent;
      current = parent;
    }
  }

  const ancestorRoot = deepestExistingAncestor(registeredPath);

  const fallbackDirs = [
    join(home, "dev"),
    join(home, "Desktop"),
    join(home, "Projects"),
    join(home, "Documents"),
    // Common cloud-storage root folders (Synology Drive, iCloud, etc.)
    join(home, "Cloud"),
    join(home, "Daten", "Cloud"),
    join(home, "Daten"),
    join(home, "Library", "Mobile Documents", "com~apple~CloudDocs"),  // iCloud Drive
    // The deepest ancestor of the registered path that still exists on disk
    ...(ancestorRoot ? [ancestorRoot] : []),
  ];

  // Deduplicate and filter to existing directories
  const searchRoots = [...new Set([...configDirs, ...fallbackDirs])]
    .map((d) => {
      try { return resolve(d); } catch { return null; }
    })
    .filter((d): d is string => d !== null && existsSync(d));

  const results: string[] = [];
  for (const root of searchRoots) {
    if (Date.now() > deadline) break;
    walkForBasename(root, targetBasename, 6, deadline, results);
  }

  // Deduplicate results (different roots might overlap)
  const unique = [...new Set(results)];

  if (unique.length === 0) return {};
  if (unique.length === 1) return { found: unique[0] };
  return { ambiguous: unique };
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

export async function cmdAdd(
  rawPath: string,
  opts: { slug?: string; type?: string; displayName?: string }
): Promise<void> {
  const backend = await getRegistryBackend();
  const rootPath = resolvePath(rawPath);
  const slug = opts.slug ?? slugFromPath(rootPath);
  const encodedDir = encodeDir(rootPath);
  const displayName = opts.displayName ?? slug;
  const type = opts.type ?? "local";

  const validTypes = ["local", "central", "obsidian-linked", "external"];
  if (!validTypes.includes(type)) {
    console.error(err(`Invalid type "${type}". Valid: ${validTypes.join(", ")}`));
    process.exitCode = 1;
    return;
  }

  // Disposable directories must not become projects. Two agent worktrees and two
  // /private/tmp paths got in this way and between them carried 8 sessions
  // attributed to locations with no future — and `pai <name>` will happily route
  // someone into a worktree a cleanup can delete underneath them.
  const ephemeral = unregistrableReason(rootPath);
  if (ephemeral) {
    console.error(err(`Refusing to register ${shortenPath(rootPath, 60)}`));
    console.error(dim(`  That is ${ephemeral}.`));
    console.error(dim(`  A project needs a durable location — move it, then register.`));
    process.exitCode = 1;
    return;
  }

  const existing = (await backend.getProjectBySlug(slug)) ?? (await backend.getProjectByRootPath(rootPath));
  if (existing) {
    console.error(
      err(`Project already registered (slug: ${slug} or path: ${rootPath})`)
    );
    process.exitCode = 1;
    return;
  }

  const dirName = basename(rootPath).toLowerCase();
  const active = await backend.listProjects({ status: "active" });
  const similar = active.filter((p) => p.slug !== slug).map((p) => ({ slug: p.slug, root_path: p.root_path }));
  const matches = similar.filter(
    (s) =>
      basename(s.root_path).toLowerCase() === dirName ||
      s.slug.replace(/-\d+$/, "") === slug.replace(/-\d+$/, "")
  );
  if (matches.length > 0) {
    console.log(warn(`Similar project(s) already registered:`));
    for (const m of matches) {
      console.log(dim(`  ${bold(m.slug)}  ${shortenPath(m.root_path, 50)}`));
    }
    console.log(
      dim(
        `  Consider: pai project alias ${matches[0].slug} <name> (to link them)`
      )
    );
    console.log(
      dim(`  Or: pai project archive ${slug} (if this is a duplicate)`)
    );
    console.log();
  }

  const ts = now();
  await backend.createProject({
    slug,
    displayName,
    rootPath,
    encodedDir,
    type: type as Project["type"],
    status: "active",
    createdAt: ts,
    updatedAt: ts,
  });

  scaffoldProjectDirs(rootPath);

  try {
    ensurePaiMarker(rootPath, slug, displayName);
  } catch {
    // Non-fatal — warn but don't fail the add command.
  }

  console.log(ok(`Project added: ${bold(slug)}`));
  console.log(dim(`  Path:         ${rootPath}`));
  console.log(dim(`  Encoded dir:  ${encodedDir}`));
  console.log(dim(`  Type:         ${type}`));
}

export async function cmdList(
  opts: { status?: string; tag?: string; type?: string; all?: boolean }
): Promise<void> {
  const backend = await getRegistryBackend();

  let tagId: number | undefined;
  if (opts.tag) {
    const tags = await backend.listAllTags();
    tagId = tags.find((t) => t.name === opts.tag)?.id;
    if (tagId === undefined) {
      console.log(warn("No projects found."));
      return;
    }
  }

  const rows = (
    await backend.listProjectsWithSessionStats({
      status: opts.status ? (opts.status as Project["status"]) : opts.all ? undefined : "active",
      tagId,
      orderBy: "status_updated",
    })
  ).filter((p) => !opts.type || p.type === opts.type);

  if (!rows.length) {
    console.log(warn("No projects found."));
    return;
  }

  const tableRows = rows.map((r, i) => [
    dim(String(i + 1)),
    bold(r.display_name ?? r.slug),
    dim(r.slug),
    dim(shortenPath(r.root_path, 44)),
    r.status === "active" ? chalk.green(r.status) : chalk.yellow(r.status),
    dim(r.type),
    String(r.session_count),
    fmtDate(r.last_active),
  ]);

  console.log(
    renderTable(
      ["#", "Name", "Slug", "Path", "Status", "Type", "Sessions", "Last Active"],
      tableRows
    )
  );
  console.log();

  // When showing active-only, inform the user about hidden archived projects
  const total = await backend.countProjects();
  const hiddenCount = total - rows.length;
  if (!opts.all && !opts.status && hiddenCount > 0) {
    console.log(dim(`  ${rows.length} active project(s)  (${hiddenCount} archived — use --all to show)`));
  } else {
    console.log(dim(`  ${rows.length} project(s)`));
  }
}

export async function cmdInfo(identifier: string): Promise<void> {
  const project =
    (await resolveIdentifier(identifier)) ?? (await requireProject(identifier));
  const backend = await getRegistryBackend();
  const tags = await getProjectTags(project.id);
  const aliases = await getProjectAliases(project.id);
  const sessionCount = await getSessionCount(project.id);
  const lastSession = await getLastSessionDate(project.id);

  const recentSessions: SessionRow[] = await backend.listSessionsForProject(project.id, {
    orderBy: "created_desc",
    limit: 5,
  });

  console.log();
  console.log(header(`  ${project.display_name}`));
  console.log();
  console.log(`  ${bold("Slug:")}         ${project.slug}`);
  console.log(`  ${bold("Path:")}         ${project.root_path}`);
  console.log(`  ${bold("Encoded dir:")}  ${project.encoded_dir}`);
  console.log(`  ${bold("Type:")}         ${project.type}`);
  console.log(
    `  ${bold("Status:")}       ${
      project.status === "active"
        ? chalk.green(project.status)
        : chalk.yellow(project.status)
    }`
  );
  console.log(
    `  ${bold("Tags:")}         ${
      tags.length ? tags.map((t) => chalk.cyan(t)).join(", ") : dim("none")
    }`
  );
  console.log(
    `  ${bold("Aliases:")}      ${aliases.length ? aliases.join(", ") : dim("none")}`
  );
  console.log(`  ${bold("Sessions:")}     ${sessionCount}`);
  console.log(`  ${bold("Last active:")}  ${fmtDate(lastSession)}`);
  console.log(`  ${bold("Created:")}      ${fmtDate(project.created_at)}`);
  if (project.archived_at) {
    console.log(`  ${bold("Archived:")}     ${fmtDate(project.archived_at)}`);
  }

  if (recentSessions.length) {
    console.log();
    console.log(`  ${bold("Recent sessions:")}`);
    const sessionRows = recentSessions.map((s) => [
      dim(`#${s.number}`),
      s.date,
      s.title.length > 50 ? s.title.slice(0, 47) + "..." : s.title,
      s.status === "completed"
        ? chalk.green(s.status)
        : chalk.yellow(s.status),
    ]);
    console.log(
      renderTable(["#", "Date", "Title", "Status"], sessionRows)
        .split("\n")
        .map((l) => "  " + l)
        .join("\n")
    );
  }
  console.log();
}

export async function cmdArchive(slug: string): Promise<void> {
  const project = await requireProject(slug);
  if (project.status === "archived") {
    console.log(warn(`Project ${slug} is already archived.`));
    return;
  }
  const ts = now();
  const backend = await getRegistryBackend();
  await backend.updateProjectStatus(project.id, "archived", { archivedAt: ts, updatedAt: ts });
  console.log(ok(`Archived: ${bold(slug)}`));
}

export async function cmdUnarchive(slug: string): Promise<void> {
  const project = await requireProject(slug);
  if (project.status !== "archived") {
    console.log(
      warn(`Project ${slug} is not archived (status: ${project.status}).`)
    );
    return;
  }
  const ts = now();
  const backend = await getRegistryBackend();
  await backend.updateProjectStatus(project.id, "active", { archivedAt: null, updatedAt: ts });
  console.log(ok(`Unarchived: ${bold(slug)}`));
}

export async function cmdMove(slug: string, newPath: string): Promise<void> {
  const project = await requireProject(slug);
  const resolvedNew = resolvePath(newPath);
  const newEncoded = encodeDir(resolvedNew);
  const ts = now();

  const backend = await getRegistryBackend();
  await backend.updateProjectPath(project.id, { rootPath: resolvedNew, encodedDir: newEncoded }, ts);

  console.log(ok(`Moved: ${bold(slug)}`));
  console.log(dim(`  Old path: ${project.root_path}`));
  console.log(dim(`  New path: ${resolvedNew}`));
}

export async function cmdTag(
  slug: string,
  tags: string[]
): Promise<void> {
  const project = await requireProject(slug);
  const backend = await getRegistryBackend();
  const added: string[] = [];
  const skipped: string[] = [];

  for (const tagName of tags) {
    const tagId = await upsertTag(tagName);
    const exists = await backend.projectHasTag(project.id, tagId);
    if (exists) {
      skipped.push(tagName);
    } else {
      await backend.addProjectTag(project.id, tagId);
      added.push(tagName);
    }
  }

  if (added.length) {
    console.log(
      ok(
        `Tagged ${bold(slug)}: ${added.map((t) => chalk.cyan(t)).join(", ")}`
      )
    );
  }
  if (skipped.length) {
    console.log(dim(`  Already present: ${skipped.join(", ")}`));
  }
}

export async function cmdAlias(
  slug: string,
  alias: string
): Promise<void> {
  await requireProject(slug);
  const backend = await getRegistryBackend();

  const conflict = await backend.getProjectBySlug(alias);
  if (conflict) {
    console.error(
      err(`"${alias}" is already a project slug — cannot use as alias.`)
    );
    process.exitCode = 1;
    return;
  }

  const project = (await getProject(slug))!;
  try {
    await backend.addAlias(alias, project.id);
    console.log(ok(`Alias added: ${bold(alias)} → ${slug}`));
  } catch {
    console.error(err(`Alias "${alias}" is already registered.`));
    process.exitCode = 1;
  }
}

export async function cmdEdit(
  slug: string,
  opts: { displayName?: string; type?: string }
): Promise<void> {
  const project = await requireProject(slug);

  if (!opts.displayName && !opts.type) {
    console.log(warn("Nothing to update. Use --display-name or --type."));
    return;
  }

  const validTypes = ["local", "central", "obsidian-linked", "external"];
  if (opts.type && !validTypes.includes(opts.type)) {
    console.error(
      err(`Invalid type "${opts.type}". Valid: ${validTypes.join(", ")}`)
    );
    process.exitCode = 1;
    return;
  }

  const ts = now();
  const backend = await getRegistryBackend();
  if (opts.displayName) {
    await backend.updateProjectDisplayName(project.id, opts.displayName, ts);
    console.log(ok(`Display name updated: ${bold(opts.displayName)}`));
  }
  if (opts.type) {
    await backend.updateProjectType(project.id, opts.type as Project["type"], ts);
    console.log(ok(`Type updated: ${bold(opts.type)}`));
  }
}

export async function cmdDetect(
  pathArg: string | undefined,
  opts: { json?: boolean }
): Promise<void> {
  const cwd = pathArg ? resolvePath(pathArg) : process.cwd();
  const detection = await detectProject(cwd);

  if (!detection) {
    if (opts.json) {
      console.log(JSON.stringify({ error: "no_match", cwd }, null, 2));
    } else {
      console.log(warn(`No registered project found for: ${cwd}`));
      console.log(dim("  Run 'pai project add .' to register this directory."));
    }
    return;
  }

  if (opts.json) {
    console.log(formatDetectionJson(detection));
    return;
  }

  console.log();
  console.log(header("  Project Detection Result"));
  console.log();
  console.log(
    formatDetection(detection)
      .split("\n")
      .map((l) => "  " + l)
      .join("\n")
  );
  console.log();
}

export async function cmdConsolidate(
  identifier: string,
  opts: { yes?: boolean; dryRun?: boolean }
): Promise<void> {
  const project =
    (await resolveIdentifier(identifier)) ?? (await requireProject(identifier));

  console.log();
  console.log(header(`  Consolidate: ${project.slug}`));
  console.log(`  Target:  ${project.root_path}`);
  console.log();

  const dirs = findProjectNotesDirs(project);

  if (dirs.length === 0) {
    console.log(warn("  No scattered notes directories found for this project."));
    return;
  }

  const canonicalNotes = join(project.root_path, "Notes");
  const toMerge = dirs.filter((d) => d.notesPath !== canonicalNotes);

  if (toMerge.length === 0) {
    console.log(ok("  All notes are already in the canonical location."));
    console.log(dim(`  ${canonicalNotes}`));
    return;
  }

  console.log(
    `  Found ${toMerge.length} scattered Notes directory(ies) to consolidate:`
  );
  console.log();

  for (const d of toMerge) {
    console.log(`    ${bold(d.encodedDir)}`);
    console.log(dim(`      Notes: ${d.notesPath} (${d.noteCount} file(s))`));
  }

  console.log();
  console.log(`  Destination: ${canonicalNotes}`);
  console.log();

  if (opts.dryRun) {
    console.log(warn("  Dry run — no changes made. Remove --dry-run to proceed."));
    return;
  }

  if (!opts.yes) {
    console.log(
      warn(
        "  Run with --yes to perform consolidation, or --dry-run to preview changes."
      )
    );
    return;
  }

  mkdirSync(canonicalNotes, { recursive: true });

  let movedCount = 0;
  for (const d of toMerge) {
    try {
      const files = readdirSync(d.notesPath);
      for (const f of files) {
        if (!f.endsWith(".md") && !f.endsWith(".txt")) continue;
        const src = join(d.notesPath, f);
        const dest = join(canonicalNotes, f);
        if (!existsSync(dest)) {
          renameSync(src, dest);
          console.log(ok(`    Moved: ${f}`));
          movedCount++;
        } else {
          console.log(warn(`    Skipped (exists): ${f}`));
        }
      }
    } catch (e) {
      console.error(err(`    Error reading ${d.notesPath}: ${e}`));
    }
  }

  console.log();
  console.log(ok(`  Consolidated ${movedCount} file(s) into ${canonicalNotes}`));
}

/**
 * Attempt moved-path recovery for a project whose registered root_path is
 * missing. Updates the DB if exactly one candidate is found.
 *
 * Returns the new path on success, or undefined if ambiguous/not found.
 * Prints all messages to stderr (safe for shell-wrapper stdout capture).
 */
async function tryRecoverMovedProject(project: ProjectRow): Promise<string | undefined> {
  process.stderr.write(
    warn(`Path not found: ${project.root_path}\n`) +
    dim("  Searching for moved location...\n")
  );

  const result = findMovedPath(project.root_path);

  if (result.found) {
    const newPath = result.found;
    const newEncoded = encodeDir(newPath);
    const ts = now();
    const backend = await getRegistryBackend();
    await backend.updateProjectPath(project.id, { rootPath: newPath, encodedDir: newEncoded }, ts);
    process.stderr.write(
      ok(`Project moved: ${shortenPath(project.root_path, 50)}\n`) +
      dim(`  → ${newPath}\n`) +
      ok("Registry updated.\n")
    );
    return newPath;
  }

  if (result.ambiguous) {
    process.stderr.write(
      warn(`Multiple directories named "${basename(project.root_path)}" found:\n`)
    );
    for (const candidate of result.ambiguous) {
      process.stderr.write(dim(`  ${candidate}\n`));
    }
    process.stderr.write(
      dim(`\n  Disambiguate with: pai projects rebind ${project.slug} <path>\n`)
    );
    return undefined;
  }

  process.stderr.write(
    err(
      `Project "${project.slug}" root_path "${project.root_path}" does not exist on disk\n` +
      `  and no folder named "${basename(project.root_path)}" was found in scan dirs.\n`
    ) +
    dim(`  Fix with: pai projects rebind ${project.slug} <new-path>\n`)
  );
  return undefined;
}

export async function cmdGo(query: string): Promise<void> {
  const backend = await getRegistryBackend();
  const all: ProjectRow[] = await backend.listProjects({ status: "active", orderBy: "updated_desc" });

  if (!all.length) {
    console.error(
      err("No active projects registered. Run: pai project add <path>")
    );
    process.exitCode = 1;
    return;
  }

  const q = query.trim().toLowerCase();

  // 1. Exact slug or alias match
  const exact = await getProject(query);
  if (exact) {
    if (!existsSync(exact.root_path)) {
      const recovered = await tryRecoverMovedProject(exact);
      if (!recovered) { process.exitCode = 1; return; }
      process.stdout.write(recovered + "\n");
      return;
    }
    process.stdout.write(exact.root_path + "\n");
    return;
  }

  // 2. Substring match against slug, display_name, or root_path basename
  const partial = all.filter(
    (p) =>
      containsIgnoreCase(p.slug, q) ||
      containsIgnoreCase(p.display_name, q) ||
      containsIgnoreCase(basename(p.root_path), q)
  );

  if (partial.length === 1) {
    const p = partial[0];
    if (!existsSync(p.root_path)) {
      const recovered = await tryRecoverMovedProject(p);
      if (!recovered) { process.exitCode = 1; return; }
      process.stdout.write(recovered + "\n");
      return;
    }
    process.stdout.write(p.root_path + "\n");
    return;
  }

  if (partial.length > 1) {
    console.error(
      err(`Ambiguous: "${query}" matches ${partial.length} projects:\n`)
    );
    partial.forEach((p, i) => {
      console.error(
        `  ${dim(String(i + 1).padStart(2))}  ${bold(p.slug.padEnd(30))}  ${dim(
          shortenPath(p.root_path, 50)
        )}`
      );
    });
    console.error();
    console.error(dim("  Use a more specific name or the exact slug."));
    process.exitCode = 1;
    return;
  }

  // 3. No match — Levenshtein suggestions
  const scored = all
    .map((p) => {
      const distSlug = levenshtein(q, p.slug.toLowerCase());
      const distName = levenshtein(q, p.display_name.toLowerCase());
      return { project: p, dist: Math.min(distSlug, distName) };
    })
    .sort((a, b) => a.dist - b.dist);

  const threshold = 4;
  const suggestions =
    scored.filter((s) => s.dist <= threshold).length > 0
      ? scored.filter((s) => s.dist <= threshold).slice(0, 3)
      : scored.slice(0, 3);

  console.error(err(`Project not found: "${query}"\n`));
  if (suggestions.length) {
    console.error(warn("  Did you mean?"));
    for (const s of suggestions) {
      console.error(
        `    ${bold(s.project.slug.padEnd(30))}  ${dim(
          shortenPath(s.project.root_path, 50)
        )}`
      );
    }
    console.error();
    console.error(dim("  Run: pai project list  (to see all projects)"));
  }
  process.exitCode = 1;
}

export async function cmdRebind(
  slug: string,
  newPath: string
): Promise<void> {
  const project = await requireProject(slug);
  const resolved = resolve(newPath.startsWith("~/") ? join(homedir(), newPath.slice(2)) : newPath);

  if (!existsSync(resolved)) {
    console.error(err(`Path does not exist: ${resolved}`));
    process.exitCode = 1;
    return;
  }

  let isDir = false;
  try {
    isDir = statSync(resolved).isDirectory();
  } catch {
    // stat failed
  }
  if (!isDir) {
    console.error(err(`Path is not a directory: ${resolved}`));
    process.exitCode = 1;
    return;
  }

  const newEncoded = encodeDir(resolved);
  const backend = await getRegistryBackend();

  // Check if another project already owns this path
  const conflict = await backend.getProjectByEncodedDir(newEncoded, { excludeId: project.id });
  if (conflict) {
    console.error(
      err(`Path is already registered to project: ${bold(conflict.slug)}\n`) +
      dim(`  ${resolved}\n`) +
      dim(`  Archive or move that project first, or choose a different path.`)
    );
    process.exitCode = 1;
    return;
  }

  const ts = now();
  await backend.updateProjectPath(project.id, { rootPath: resolved, encodedDir: newEncoded }, ts);

  console.log(ok(`Rebound: ${bold(slug)}`));
  console.log(dim(`  Old path: ${project.root_path}`));
  console.log(dim(`  New path: ${resolved}`));
  console.log(dim(`  Encoded:  ${newEncoded}`));
}
