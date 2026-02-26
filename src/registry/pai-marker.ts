/**
 * PAI.md marker file management.
 *
 * Each registered project gets a `Notes/PAI.md` file with a YAML frontmatter
 * `pai:` block that PAI manages.  The rest of the file (body content, other
 * frontmatter keys) is user-owned and never modified by PAI.
 *
 * YAML parsing/updating is done with simple regex — no external dependency.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PaiMarker {
  /** Absolute path to the PAI.md file */
  path: string;
  /** The `slug` value from the `pai:` frontmatter block */
  slug: string;
  /** Absolute path to the project root (parent of Notes/) */
  projectRoot: string;
}

// ---------------------------------------------------------------------------
// Template content (mirrors templates/pai-project.template.md)
// ---------------------------------------------------------------------------

const TEMPLATE = `---
pai:
  slug: "\${SLUG}"
  registered: "\${DATE}"
  last_indexed: null
  status: active
---

# \${DISPLAY_NAME}

<!-- Everything below the YAML frontmatter is yours — PAI never modifies content here. -->
<!-- Use this file for project notes, decisions, preferences, or anything you want. -->
<!-- PAI only reads and updates the \`pai:\` block in the frontmatter above. -->
`;

function isoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function renderTemplate(slug: string, displayName: string): string {
  return TEMPLATE.replace(/\$\{SLUG\}/g, slug)
    .replace(/\$\{DATE\}/g, isoDate())
    .replace(/\$\{DISPLAY_NAME\}/g, displayName);
}

// ---------------------------------------------------------------------------
// YAML frontmatter helpers (regex-based, no external dependency)
// ---------------------------------------------------------------------------

/**
 * Split a markdown file with YAML frontmatter into its parts.
 *
 * Returns { frontmatter, body } where:
 *   frontmatter  — content between the opening and closing `---` delimiters
 *   body         — everything after the closing `---` line
 *
 * Returns null if the file does not begin with a `---` frontmatter block.
 */
function parseFrontmatter(
  content: string
): { frontmatter: string; body: string } | null {
  if (!content.startsWith("---")) return null;

  // Skip past the opening "---" and its line ending
  const afterOpen = content.slice(3);
  const eolMatch = afterOpen.match(/^\r?\n/);
  if (!eolMatch) return null;

  const rest = afterOpen.slice(eolMatch[0].length);

  // Find closing "---" on its own line
  const closeMatch = rest.match(/^([\s\S]*?)\n---[ \t]*(\r?\n|$)/m);
  if (!closeMatch) return null;

  const frontmatter = closeMatch[1];
  const body = rest.slice(closeMatch[0].length);

  return { frontmatter, body };
}

/**
 * Extract a simple scalar YAML value from a block of YAML text.
 *
 *   extractYamlValue('  slug: "my-proj"', "slug")  →  "my-proj"
 *   extractYamlValue('  slug: my-proj', "slug")     →  "my-proj"
 *   extractYamlValue('  last_indexed: null', "last_indexed")  →  "null"
 */
function extractYamlValue(yamlBlock: string, key: string): string | null {
  const re = new RegExp(
    `^[ \\t]*${key}[ \\t]*:[ \\t]*"?([^"\\n\\r]*?)"?[ \\t]*$`,
    "m"
  );
  const match = yamlBlock.match(re);
  if (!match) return null;
  return match[1].trim() || null;
}

/**
 * Replace the `pai:` mapping block inside a frontmatter string with
 * `newPaiBlock`.  If no `pai:` block is found, appends it at the end.
 *
 * The regex captures the `pai:` key and all immediately-following indented
 * lines (the mapping values), then replaces the whole group.
 *
 * Edge case: the last indented line may not have a trailing newline when it
 * is the final line of the frontmatter string.  We handle this by matching
 * lines that end with \n OR with end-of-string.
 */
function replacePaiBlock(frontmatter: string, newPaiBlock: string): string {
  // Normalise: ensure the frontmatter string ends with \n so the regex
  // always finds a clean boundary after the last indented line.
  const fm = frontmatter.endsWith("\n") ? frontmatter : frontmatter + "\n";

  // Match "pai:\n" followed by any number of indented lines (each ending \n).
  const paiRe = /^pai:[ \t]*\r?\n(?:[ \t]+[^\r\n]*\r?\n)*/m;
  if (paiRe.test(fm)) {
    // Replace and strip the extra trailing \n we may have added.
    const replaced = fm.replace(paiRe, newPaiBlock);
    return frontmatter.endsWith("\n") ? replaced : replaced.replace(/\n$/, "");
  }
  // pai: key not found — append it
  return fm + newPaiBlock;
}

/**
 * Build the canonical `pai:` YAML block (with a trailing newline).
 */
function buildPaiBlock(
  slug: string,
  registered: string,
  lastIndexed: string | null,
  status: string
): string {
  const lastIndexedStr =
    lastIndexed === null ? "null" : `"${lastIndexed}"`;
  return (
    `pai:\n` +
    `  slug: "${slug}"\n` +
    `  registered: "${registered}"\n` +
    `  last_indexed: ${lastIndexedStr}\n` +
    `  status: ${status}\n`
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create or update `<projectRoot>/Notes/PAI.md`.
 *
 * - File absent: creates `Notes/` if needed, writes from template.
 * - File present: updates only the `pai:` frontmatter block; body and all
 *   other frontmatter keys are preserved verbatim.
 *
 * @param projectRoot  Absolute path to the project root directory.
 * @param slug         PAI slug for this project.
 * @param displayName  Human-readable name (defaults to slug if omitted).
 */
export function ensurePaiMarker(
  projectRoot: string,
  slug: string,
  displayName?: string
): void {
  const notesDir = join(projectRoot, "Notes");
  const markerPath = join(notesDir, "PAI.md");
  const name = displayName ?? slug;

  // --- File does not exist — create from template ---
  if (!existsSync(markerPath)) {
    mkdirSync(notesDir, { recursive: true });
    writeFileSync(markerPath, renderTemplate(slug, name), "utf8");
    return;
  }

  // --- File exists — update only the `pai:` block ---
  const raw = readFileSync(markerPath, "utf8");
  const parsed = parseFrontmatter(raw);

  if (!parsed) {
    // No YAML frontmatter — prepend a fresh one, treat the whole file as body.
    const paiBlock = buildPaiBlock(slug, isoDate(), null, "active");
    const newContent = `---\n${paiBlock}---\n\n${raw}`;
    writeFileSync(markerPath, newContent, "utf8");
    return;
  }

  const { frontmatter, body } = parsed;

  // Preserve existing `registered` date so we don't reset it on re-scan.
  const existingRegistered =
    extractYamlValue(frontmatter, "registered") ?? isoDate();

  // Preserve existing `last_indexed` value (may be "null" string or a date).
  const rawLastIndexed = extractYamlValue(frontmatter, "last_indexed");
  const lastIndexed =
    rawLastIndexed === null || rawLastIndexed === "null"
      ? null
      : rawLastIndexed;

  // Preserve existing `status`.
  const existingStatus = extractYamlValue(frontmatter, "status") ?? "active";

  const newPaiBlock = buildPaiBlock(
    slug,
    existingRegistered,
    lastIndexed,
    existingStatus
  );

  const newFrontmatter = replacePaiBlock(frontmatter, newPaiBlock);

  // Ensure the frontmatter block ends with exactly one newline before the
  // closing --- delimiter.
  const fmWithNewline = newFrontmatter.endsWith("\n")
    ? newFrontmatter
    : newFrontmatter + "\n";

  // Reconstruct the full file.  Preserve whatever separator the body has.
  const newContent = `---\n${fmWithNewline}---\n${body}`;
  writeFileSync(markerPath, newContent, "utf8");
}

/**
 * Read PAI marker data from `<projectRoot>/Notes/PAI.md`.
 * Returns null if the file does not exist or contains no `pai:` block.
 */
export function readPaiMarker(
  projectRoot: string
): { slug: string; registered: string; status: string } | null {
  const markerPath = join(projectRoot, "Notes", "PAI.md");
  if (!existsSync(markerPath)) return null;

  const raw = readFileSync(markerPath, "utf8");
  const parsed = parseFrontmatter(raw);
  if (!parsed) return null;

  const slug = extractYamlValue(parsed.frontmatter, "slug");
  if (!slug) return null;

  const registered =
    extractYamlValue(parsed.frontmatter, "registered") ?? "";
  const status =
    extractYamlValue(parsed.frontmatter, "status") ?? "active";

  return { slug, registered, status };
}

/**
 * Scan a list of parent directories for `<child>/Notes/PAI.md` marker files.
 * Each directory in `searchDirs` is scanned one level deep — its immediate
 * child directories are checked for a `Notes/PAI.md` file.
 *
 * Returns an array of PaiMarker objects for every valid marker found.
 * Invalid or malformed markers are silently skipped.
 *
 * @param searchDirs  Absolute paths to parent directories.
 */
export function discoverPaiMarkers(searchDirs: string[]): PaiMarker[] {
  const results: PaiMarker[] = [];

  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;

    let children: string[];
    try {
      children = readdirSync(dir);
    } catch {
      continue;
    }

    for (const child of children) {
      if (child.startsWith(".")) continue;
      const childPath = join(dir, child);
      try {
        if (!statSync(childPath).isDirectory()) continue;
      } catch {
        continue;
      }

      const markerData = readPaiMarker(childPath);
      if (!markerData) continue;

      results.push({
        path: join(childPath, "Notes", "PAI.md"),
        slug: markerData.slug,
        projectRoot: childPath,
      });
    }
  }

  return results;
}
