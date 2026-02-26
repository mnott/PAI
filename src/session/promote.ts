/**
 * pai project promote --from-session <path> --to <new-project-path> [--name "Name"]
 *
 * Promotes a session note into a new standalone project:
 *   1. Validates inputs
 *   2. Scaffolds the new project directory
 *   3. Copies the session note and creates a MEMORY.md
 *   4. Registers the new project in the PAI registry
 *   5. Optionally backlinks from the source project's TODO.md
 */

import type { Database } from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  appendFileSync,
  writeFileSync,
} from "node:fs";
import { join, basename, dirname, resolve } from "node:path";
import {
  ok,
  warn,
  err,
  dim,
  bold,
  slugify,
  encodeDir,
  resolvePath,
  scaffoldProjectDirs,
  now,
} from "../cli/utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromoteOptions {
  fromSession: string;
  to: string;
  name?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive a human-readable project name from a session note filename.
 * "0042 - 2026-02-24 - Dark Mode Implementation.md" → "Dark Mode Implementation"
 */
function deriveNameFromFilename(filename: string): string {
  const base = basename(filename, ".md");
  // Strip leading "NNNN - YYYY-MM-DD - " prefix if present
  const match = base.match(/^\d+ - \d{4}-\d{2}-\d{2} - (.+)$/);
  return match ? match[1] : base;
}

/**
 * Extract the first N H2 (##) section headings from markdown content.
 */
function extractH2Headings(content: string, limit = 2): string[] {
  const headings: string[] = [];
  for (const m of content.matchAll(/^## .+$/gm)) {
    headings.push(m[0]);
    if (headings.length >= limit) break;
  }
  return headings;
}

/**
 * Find the source project root from the session note path.
 * Convention: session note lives at {project-root}/Notes/{filename}
 * So: dirname(dirname(sessionPath)) = project root.
 */
function findSourceProjectRoot(sessionPath: string): string {
  const notesDir = dirname(resolve(sessionPath));
  return dirname(notesDir);
}

// ---------------------------------------------------------------------------
// Main implementation
// ---------------------------------------------------------------------------

export function cmdPromote(db: Database, opts: PromoteOptions): void {
  const sessionPath = resolvePath(opts.fromSession);
  const targetPath = resolvePath(opts.to);

  // ---- Validate inputs ----

  if (!existsSync(sessionPath)) {
    console.error(err(`Session note not found: ${sessionPath}`));
    process.exit(1);
  }
  if (!sessionPath.endsWith(".md")) {
    console.error(err(`--from-session must be a markdown (.md) file: ${sessionPath}`));
    process.exit(1);
  }
  if (existsSync(targetPath)) {
    console.error(err(`Target path already exists: ${targetPath}`));
    process.exit(1);
  }

  // ---- Derive project name and slug ----

  const displayName = opts.name ?? deriveNameFromFilename(sessionPath);
  const slug = slugify(displayName);

  if (!slug) {
    console.error(err(`Could not derive a valid slug from name: "${displayName}"`));
    process.exit(1);
  }

  // ---- Check registry for conflicts ----

  const encodedDir = encodeDir(targetPath);
  const existing = db
    .prepare("SELECT id FROM projects WHERE slug = ? OR root_path = ? OR encoded_dir = ?")
    .get(slug, targetPath, encodedDir);
  if (existing) {
    console.error(
      err(`A project with slug "${slug}" or path "${targetPath}" is already registered.`)
    );
    process.exit(1);
  }

  // ---- Scaffold new project ----

  scaffoldProjectDirs(targetPath);

  // ---- Copy session note ----

  const today = new Date().toISOString().slice(0, 10);
  const sourceBasename = basename(sessionPath);
  const sourceProjectRoot = findSourceProjectRoot(sessionPath);
  const sourceProjectName = basename(sourceProjectRoot);

  const destNoteName = `0001 - ${today} - Promoted from ${sourceProjectName}.md`;
  const destNotePath = join(targetPath, "Notes", destNoteName);

  copyFileSync(sessionPath, destNotePath);

  // ---- Create MEMORY.md ----

  const sessionContent = readFileSync(sessionPath, "utf-8");
  const headings = extractH2Headings(sessionContent);

  const memoryContent = [
    `# Project Memory`,
    ``,
    `## Origin`,
    ``,
    `- **Promoted from:** ${sessionPath}`,
    `- **Source project:** ${sourceProjectRoot}`,
    `- **Date of promotion:** ${today}`,
    `- **Original session note:** ${sourceBasename}`,
    ``,
    `## Initial Context`,
    ``,
    headings.length > 0
      ? `Key topics from the source session:\n\n${headings.map((h) => `- ${h.replace(/^## /, "")}`).join("\n")}`
      : `(Extracted from session note — see ${destNoteName})`,
    ``,
  ].join("\n");

  writeFileSync(join(targetPath, "Notes", "MEMORY.md"), memoryContent, "utf-8");

  // ---- Register in PAI registry ----

  const ts = now();
  db.prepare(
    `INSERT INTO projects
       (slug, display_name, root_path, encoded_dir, type, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'local', 'active', ?, ?)`
  ).run(slug, displayName, targetPath, encodedDir, ts, ts);

  // ---- Backlink in source TODO.md ----

  const sourceTodoPath = join(sourceProjectRoot, "Notes", "TODO.md");
  if (existsSync(sourceTodoPath)) {
    const backlink = `\n- Promoted to project: [${slug}](${targetPath})\n`;
    appendFileSync(sourceTodoPath, backlink, "utf-8");
    console.log(dim(`  Backlink added to: ${sourceTodoPath}`));
  }

  // ---- Success output ----

  console.log();
  console.log(ok(`Project promoted: ${bold(slug)}`));
  console.log(dim(`  Display name: ${displayName}`));
  console.log(dim(`  Path:         ${targetPath}`));
  console.log(dim(`  Slug:         ${slug}`));
  console.log(dim(`  Session note: ${destNoteName}`));
  console.log(dim(`  Memory:       Notes/MEMORY.md created`));
  console.log();
  console.log(dim(`  Next: cd ${targetPath} && pai session list ${slug}`));
}
