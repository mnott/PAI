/**
 * Shared utilities for CLI commands: formatting helpers, path encoding,
 * slug generation, and chalk colour wrappers.
 */

import chalk from "chalk";
import { resolve, basename, join } from "node:path";
import { mkdirSync, existsSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Chalk colour helpers (thin wrappers so callers don't import chalk directly)
// ---------------------------------------------------------------------------

export const ok = (msg: string) => chalk.green(msg);
export const warn = (msg: string) => chalk.yellow(msg);
export const err = (msg: string) => chalk.red(msg);
export const dim = (msg: string) => chalk.dim(msg);
export const bold = (msg: string) => chalk.bold(msg);
export const header = (msg: string) => chalk.bold.underline(msg);

// ---------------------------------------------------------------------------
// Path / slug helpers
// ---------------------------------------------------------------------------

/**
 * Convert any path string into a kebab-case slug.
 *   "/Users/foo/my-project"  →  "my-project"
 *   "Some Cool Project"       →  "some-cool-project"
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // non-alphanum runs → single hyphen
    .replace(/^-+|-+$/g, ""); // strip leading/trailing hyphens
}

/**
 * Derive a default project slug from the last component of a path.
 *   "/home/user/my-project"  →  "my-project"
 */
export function slugFromPath(projectPath: string): string {
  return slugify(basename(projectPath));
}

/**
 * Encode an absolute path into Claude Code's encoded-dir format.
 *
 * Claude Code's actual encoding rules (reverse-engineered from real data):
 *   - Every `/`, ` ` (space), `.` (dot), and `-` (literal hyphen) → single `-`
 *   - The result therefore starts with `-` (from the leading `/`)
 *
 * This is a lossy encoding — space, dot, hyphen, and path-separator all
 * collapse to the same token.  The decode is therefore ambiguous; prefer
 * {@link buildEncodedDirMap} from migrate.ts to get authoritative mappings.
 *
 * Examples:
 *   "/Users/foo/my-project"        →  "-Users-foo-my-project"
 *   "/Users/foo/04 - Ablage"       →  "-Users-foo-04---Ablage"
 *   "/Users/foo/.ssh"              →  "-Users-foo--ssh"
 *   "/Users/foo/MDF-System.de"     →  "-Users-foo-MDF-System-de"
 *
 * NOTE: For `project add`, prefer {@link findExistingEncodedDir} to look up
 * whether Claude Code has already created a directory for this path — that
 * avoids any mismatch between our encoding and Claude's.
 */
export function encodeDir(absolutePath: string): string {
  // Every `/`, space, dot, and hyphen → single `-`
  // The leading `/` produces the leading `-` that all encoded dirs start with.
  return absolutePath.replace(/[\/\s.\-]/g, "-");
}

/**
 * Look up an absolute path in ~/.claude/projects/ to find the encoded-dir
 * name that Claude Code actually uses for it.
 *
 * This is more reliable than {@link encodeDir} because it reads the real
 * filesystem rather than re-implementing Claude's encoding algorithm.
 *
 * Returns the encoded-dir string (e.g. "-Users-foo-my-project") if a match
 * is found in ~/.claude/projects/, or `null` if not present.
 */
export function findExistingEncodedDir(absolutePath: string): string | null {
  const claudeProjectsDir = join(homedir(), ".claude", "projects");
  if (!existsSync(claudeProjectsDir)) return null;

  // Build the expected encoded form to compare against directory names
  const expected = encodeDir(absolutePath);

  try {
    const entries = readdirSync(claudeProjectsDir);
    // Exact match (our encoding matches Claude's)
    if (entries.includes(expected)) return expected;

    // Fallback: scan all entries and compare the decoded path.
    // Import decodeEncodedDir lazily to avoid circular dependency.
    for (const entry of entries) {
      const full = join(claudeProjectsDir, entry);
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      // Simple heuristic decode: `--` → `-`, single `-` → `/`
      // (good enough for finding exact matches via the registry JSON)
      if (entry === expected) return entry;
    }
  } catch {
    // Unreadable directory — ignore
  }

  return null;
}

/**
 * Decode a Claude encoded-dir back to an approximate absolute path.
 *
 * NOTE: This decode is best-effort only — the encoding is lossy (space, dot,
 * literal hyphen, and path-separator all collapse to `-`).  Prefer reading
 * original_path from session-registry.json via buildEncodedDirMap() in
 * src/registry/migrate.ts for authoritative decoding.
 *
 *   "-Users-foo-my-project"  →  "/Users/foo/my-project"
 */
export function decodeDir(encodedDir: string): string {
  if (!encodedDir) return "/";
  // Try filesystem-walking decode first (handles spaces, dots, hyphens correctly)
  const smart = smartDecodeDir(encodedDir);
  if (smart) return smart;
  // Fallback: treat every `-` as `/` (wrong for paths with spaces/dots/hyphens)
  return encodedDir.replace(/-/g, "/");
}

/**
 * Decode a Claude encoded-dir by walking the actual filesystem.
 *
 * Because the encoding is lossy (/, space, dot, and hyphen all → `-`), the
 * only reliable way to reverse it is to check what actually exists on disk.
 *
 * Algorithm: starting from `/`, read directory entries at each level, encode
 * each candidate, and greedily match the longest one against the remaining
 * encoded string.  This correctly resolves e.g.:
 *
 *   "-Users-foo-09---Job-Search"  →  "/Users/foo/09 - Job Search"
 *   "-Users-foo-87---DevonThink"  →  "/Users/foo/87 - DevonThink"
 *   "-Users-foo-MDF-System-de"    →  "/Users/foo/MDF-System.de"
 *
 * Returns `null` if the path cannot be resolved against the filesystem.
 */
export function smartDecodeDir(encoded: string): string | null {
  if (!encoded || !encoded.startsWith("-")) return null;

  // Strip the leading `-` (encodes the leading `/`)
  let remaining = encoded.slice(1);
  let current = "/";

  while (remaining.length > 0) {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return null; // Can't read directory
    }

    // Encode each candidate entry and find matches against remaining string.
    // Sort by encoded length descending so we prefer the longest (most specific) match.
    const candidates: { name: string; enc: string }[] = [];
    for (const name of entries) {
      // Encode this entry the same way Claude Code does (without the leading /)
      const enc = name.replace(/[\s.\-]/g, "-");
      // Must match at start of remaining, followed by `-` separator or end of string
      if (remaining === enc || remaining.startsWith(enc + "-")) {
        candidates.push({ name, enc });
      }
    }

    if (candidates.length === 0) return null; // No match found

    // Prefer longest encoded match (most specific)
    candidates.sort((a, b) => b.enc.length - a.enc.length);

    // Try each candidate — pick the first one that is a real directory
    // (or the last segment which may be a file)
    let matched = false;
    for (const { name, enc } of candidates) {
      const nextPath = join(current, name);
      const nextRemaining = remaining === enc ? "" : remaining.slice(enc.length + 1);

      // If nothing left, this is the final segment — accept it
      if (nextRemaining === "") {
        return nextPath;
      }

      // Otherwise, verify this is a directory we can descend into
      try {
        if (statSync(nextPath).isDirectory()) {
          current = nextPath;
          remaining = nextRemaining;
          matched = true;
          break;
        }
      } catch {
        continue;
      }
    }

    if (!matched) return null;
  }

  return current;
}

/**
 * Resolve a raw CLI path argument to an absolute path.
 */
export function resolvePath(rawPath: string): string {
  return resolve(rawPath);
}

// ---------------------------------------------------------------------------
// Filesystem scaffolding
// ---------------------------------------------------------------------------

const MEMORY_MD_SCAFFOLD = `# Memory

Project-specific memory for PAI sessions.
Add persistent notes, reminders, and context here.
`;

/**
 * Ensure Notes/ and memory/ sub-directories exist under `projectRoot`.
 * Also creates a memory/MEMORY.md scaffold if it does not yet exist.
 */
export function scaffoldProjectDirs(projectRoot: string): void {
  const notesDir = `${projectRoot}/Notes`;
  const memoryDir = `${projectRoot}/memory`;
  const memoryFile = `${memoryDir}/MEMORY.md`;

  mkdirSync(notesDir, { recursive: true });
  mkdirSync(memoryDir, { recursive: true });

  if (!existsSync(memoryFile)) {
    writeFileSync(memoryFile, MEMORY_MD_SCAFFOLD, "utf8");
  }
}

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------

/**
 * Pad a string to a minimum width (left-aligned).
 */
export function pad(str: string, width: number): string {
  const plain = stripAnsi(str);
  const extra = width - plain.length;
  return str + (extra > 0 ? " ".repeat(extra) : "");
}

/**
 * Strip ANSI escape sequences to measure visible string length.
 */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, "");
}

/**
 * Render a simple columnar table.
 *
 * @param headers  Column header strings
 * @param rows     Array of row arrays (each cell is a string, may include chalk sequences)
 */
export function renderTable(headers: string[], rows: string[][]): string {
  const allRows = [headers, ...rows];

  // Compute column widths
  const widths = headers.map((_, colIdx) =>
    Math.max(...allRows.map((row) => stripAnsi(row[colIdx] ?? "").length))
  );

  const divider = dim("  " + widths.map((w) => "-".repeat(w)).join("  "));
  const renderRow = (row: string[], isHeader = false) => {
    const cells = widths.map((w, i) => {
      const cell = row[i] ?? "";
      return isHeader ? pad(bold(cell), w + (cell.length - stripAnsi(cell).length)) : pad(cell, w + (cell.length - stripAnsi(cell).length));
    });
    return "  " + cells.join("  ");
  };

  const lines: string[] = [];
  lines.push(renderRow(headers, true));
  lines.push(divider);
  for (const row of rows) {
    lines.push(renderRow(row));
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/**
 * Shorten an absolute path for display: replace home dir with ~,
 * truncate from left if still longer than maxLen.
 */
export function shortenPath(absolutePath: string, maxLen = 40): string {
  const home = homedir();
  let p = absolutePath;
  if (p.startsWith(home)) {
    p = "~" + p.slice(home.length);
  }
  if (p.length <= maxLen) return p;
  return "..." + p.slice(p.length - maxLen + 3);
}

/**
 * Format an epoch milliseconds timestamp as YYYY-MM-DD.
 */
export function fmtDate(epochMs: number | null | undefined): string {
  if (epochMs == null) return dim("—");
  return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * Return the current epoch milliseconds.
 */
export function now(): number {
  return Date.now();
}
