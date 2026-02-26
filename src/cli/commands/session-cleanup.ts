/**
 * pai session cleanup
 *
 * Cleans up session notes across all PAI projects:
 *
 *   1. Identify empty sessions (< 500 bytes OR just template content)
 *   2. Delete truly empty sessions (no real work content)
 *   3. Auto-name sessions still called "New Session" that have real content
 *   4. Reorganize flat Notes/ into Notes/YYYY/MM/ hierarchy
 *   5. Renumber sessions sequentially after removals
 *   6. Update the registry DB to reflect new filenames and paths
 *   7. Update pai_files and pai_chunks paths in Postgres to preserve embeddings
 *
 * Flags:
 *   --dry-run            Show what would change (DEFAULT)
 *   --execute            Actually perform the cleanup
 *   --project <slug>     Only clean one project
 *   --no-renumber        Skip renumbering step
 *   --no-reindex         Skip triggering memory re-index after moves
 */

import type { Command } from "commander";
import type { Database } from "better-sqlite3";
import {
  ok,
  warn,
  err,
  dim,
  bold,
  header,
} from "../utils.js";
import chalk from "chalk";
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProjectRow {
  id: number;
  slug: string;
  display_name: string;
  root_path: string;
  encoded_dir: string;
  claude_notes_dir: string | null;
}

interface SessionRow {
  id: number;
  project_id: number;
  number: number;
  date: string;
  slug: string;
  title: string;
  filename: string;
  status: string;
}

type SessionClassification = "EMPTY" | "UNNAMED" | "NAMED" | "LEGACY_FORMAT";

interface SessionCandidate {
  session: SessionRow | null; // null if file exists on disk but not in DB
  filename: string;
  filepath: string;
  sizeBytes: number;
  classification: SessionClassification;
  autoName?: string; // proposed name for UNNAMED sessions
  date: string;
  number: number;
}

interface NotesDirPlan {
  notesDir: string;
  toDelete: SessionCandidate[];
  toRename: SessionCandidate[];
  toMove: SessionCandidate[]; // survivors that need moving to YYYY/MM/ within this dir
}

interface CleanupPlan {
  project: ProjectRow;
  notesDirs: NotesDirPlan[]; // one entry per discovered Notes/ directory (up to 2)
  renumberMap: Map<number, number>; // old number → new number (global across both dirs)
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Template content indicators — if the file only contains these patterns,
// it has no real work content and can be deleted.
const TEMPLATE_INDICATORS = [
  "<!-- PAI will add completed work here during session -->",
  "<!-- PAI will add completed work here -->",
  "Session completed.",
  "Session started and ready for your instructions",
];

// Session filename patterns
// Modern: "0027 - 2026-02-23 - Meaningful Name.md"
const MODERN_PATTERN = /^(\d{4}) - (\d{4}-\d{2}-\d{2}) - (.+)\.md$/;
// Legacy: "0001_2025-12-24_session-started-and-ready-for-your-instructions.md"
const LEGACY_PATTERN = /^(\d{4})_(\d{4}-\d{2}-\d{2})_(.+)\.md$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getAllProjects(db: Database): ProjectRow[] {
  return db
    .prepare(
      "SELECT id, slug, display_name, root_path, encoded_dir, claude_notes_dir FROM projects WHERE status = 'active' ORDER BY slug"
    )
    .all() as ProjectRow[];
}

function getProject(db: Database, slug: string): ProjectRow | undefined {
  return db
    .prepare(
      "SELECT id, slug, display_name, root_path, encoded_dir, claude_notes_dir FROM projects WHERE slug = ?"
    )
    .get(slug) as ProjectRow | undefined;
}

function getProjectSessions(db: Database, projectId: number): SessionRow[] {
  return db
    .prepare("SELECT * FROM sessions WHERE project_id = ? ORDER BY number ASC")
    .all(projectId) as SessionRow[];
}

/**
 * Find the project-root Notes directory (e.g. {root}/Notes or {root}/.claude/Notes).
 * Returns null if neither exists on disk.
 */
function findRootNotesDir(rootPath: string): string | null {
  const canonical = join(rootPath, "Notes");
  if (existsSync(canonical)) return canonical;
  const alt = join(rootPath, ".claude", "Notes");
  if (existsSync(alt)) return alt;
  return null;
}

/**
 * Find the Claude Code session notes directory for a project.
 * Falls back to computing the path from encoded_dir if claude_notes_dir is not set.
 * Returns null if the directory does not exist on disk, or if it is identical to
 * rootNotesDir (to avoid processing the same directory twice).
 */
function findClaudeNotesDir(project: ProjectRow, rootNotesDir: string | null): string | null {
  // Prefer the registry-stored path; fall back to computing it from encoded_dir
  const candidate =
    project.claude_notes_dir ??
    join(homedir(), ".claude", "projects", project.encoded_dir, "Notes");

  if (!existsSync(candidate)) return null;
  // Avoid processing the same directory twice
  if (rootNotesDir && candidate === rootNotesDir) return null;
  return candidate;
}

/**
 * Collect up to two distinct Notes/ directories for a project.
 * Returns an array of existing, distinct paths in the order:
 *   1. Root Notes/ (from project root_path)
 *   2. Claude Code Notes/ (from claude_notes_dir or encoded_dir)
 */
function findAllNotesDirs(project: ProjectRow): string[] {
  const rootDir = findRootNotesDir(project.root_path);
  const claudeDir = findClaudeNotesDir(project, rootDir);
  const dirs: string[] = [];
  if (rootDir) dirs.push(rootDir);
  if (claudeDir) dirs.push(claudeDir);
  return dirs;
}

/**
 * Determine if a file's content is essentially empty (just the template).
 *
 * A file is template-only if:
 *   - It contains a template placeholder marker AND
 *   - The "Work Done" section has no real content after the placeholder
 *     (i.e., no lines with actual text beyond the placeholder comment itself)
 */
function isTemplateOnly(content: string): boolean {
  const hasTemplateMarker = TEMPLATE_INDICATORS.some((ind) => content.includes(ind));
  if (!hasTemplateMarker) return false;

  // Look for "Work Done" section and check if there's any real content in it.
  // Real content = non-empty lines that are not:
  //   - HTML comments (<!-- ... -->)
  //   - Section headers (## ...)
  //   - The placeholder text itself
  //   - "Session completed." alone
  //   - "#Session" tags

  const lines = content.split("\n");
  let inWorkDone = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "## Work Done") {
      inWorkDone = true;
      continue;
    }
    if (trimmed.startsWith("## ") && inWorkDone) {
      // Left the Work Done section
      break;
    }
    if (!inWorkDone) continue;

    // Skip empty lines, comment lines, section headers
    if (!trimmed) continue;
    if (trimmed.startsWith("<!--") && trimmed.endsWith("-->")) continue;
    if (trimmed.startsWith("<!--")) continue;
    if (trimmed === "-->") continue;
    if (trimmed === "Session completed.") continue;
    if (trimmed === "#Session" || trimmed === "**Tags:** #Session") continue;

    // Any other non-empty line = real content
    return false;
  }

  return true;
}

// Meta-phrases that indicate template / status text rather than real work descriptions.
// Lines matching any of these (case-insensitive) are skipped during auto-naming.
const META_PHRASE_PATTERNS: RegExp[] = [
  /session initialized and ready for your instructions/i,
  /fresh session with no pending tasks/i,
  /starting new session.*checking for pending work/i,
  /fresh session with empty todo/i,
  /session started and ready/i,
  /^session\b.*\bready\b/i,
  /^session\b.*\binitialized\b/i,
  /^session\b.*\bno pending\b/i,
  /^session\b.*\bno prior work\b/i,
  /^no pending tasks/i,
  /^no prior work/i,
];

// Articles and prepositions excluded from Title Case capitalisation.
const TITLE_CASE_MINOR_WORDS = new Set([
  "a", "an", "the", "in", "on", "at", "for", "to", "of", "and", "or",
  "but", "via", "with", "from", "by", "as", "nor",
]);

/**
 * Strip markdown checkbox syntax, bullets, and inline formatting from a line.
 * Returns the cleaned plain text, or null if the result is too short to be useful.
 */
function cleanMarkdownLine(raw: string): string | null {
  let s = raw.trim();

  // Strip leading bullets with optional checkboxes: "- [x]", "* [ ]", "- ", "* ", "+ "
  s = s.replace(/^[-*+]\s+\[[ xX]\]\s*/, "");  // bullet + checkbox
  s = s.replace(/^[-*+]\s+/, "");               // bullet only

  // Strip bare checkboxes at the start: "[x]", "[ ]", "[X]"
  s = s.replace(/^\[[ xX]\]\s*/, "");

  // Strip inline markdown formatting: **bold**, *italic*, `code`
  // Also handles malformed ** text** (leading space inside bold markers)
  s = s.replace(/\*\*\s*([^*]+?)\s*\*\*/g, "$1");
  s = s.replace(/\*\s*([^*]+?)\s*\*/g, "$1");
  s = s.replace(/`([^`]+)`/g, "$1");

  // Strip any leftover bare asterisks (e.g. "** Restored..." → "Restored...")
  s = s.replace(/^\*+\s*/, "");

  // Strip leading/trailing punctuation that doesn't belong in a title
  s = s.replace(/^[.,;:]+/, "").replace(/[.,;:]+$/, "");

  // Collapse multiple spaces
  s = s.replace(/\s+/g, " ").trim();

  return s.length >= 4 ? s : null;
}

/**
 * Return true if the line contains only meta-status text that should not
 * be used as a session title.
 */
function isMetaPhrase(text: string): boolean {
  return META_PHRASE_PATTERNS.some((re) => re.test(text));
}

/**
 * Convert a string to Title Case, skipping minor words (articles, prepositions)
 * except as the very first word.
 */
function toTitleCase(text: string): string {
  const words = text.split(" ");
  return words
    .map((word, i) => {
      const lower = word.toLowerCase();
      if (i !== 0 && TITLE_CASE_MINOR_WORDS.has(lower)) return lower;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

/**
 * Sanitize a string into a valid filename component.
 * Strips chars that don't belong in filenames, collapses spaces, trims to
 * 60 chars at a word boundary, then applies Title Case.
 */
function sanitizeName(raw: string): string {
  // Remove filesystem-unsafe characters (keep hyphens and apostrophes)
  let s = raw.replace(/[\/\\:*?"<>|#`]/g, "");
  s = s.replace(/\s+/g, " ").trim();

  // Truncate to 60 chars at a word boundary
  if (s.length > 60) {
    const truncated = s.slice(0, 60);
    const lastSpace = truncated.lastIndexOf(" ");
    s = lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated;
  }

  s = s.trim();

  // Apply Title Case
  return toTitleCase(s);
}

/**
 * Extract a meaningful auto-name from session content.
 *
 * Strategy (in priority order):
 *   1. H2 content sections (## Work Done, ## Summary, etc.):
 *      look at the CONTENT under them for the first real work bullet.
 *   2. Other descriptive H2 headings that aren't structural section names.
 *   3. H1 heading — only if it is not a plain session-number line.
 *   5. Fallback: "Unnamed Session".
 */
function extractAutoName(content: string): string {
  const lines = content.split("\n");

  // Section headings whose *content* we want to mine (not use as the title itself)
  const CONTENT_SECTION_HEADINGS = new Set([
    "Work Done", "Summary", "Completed", "What Was Done",
    "Results", "Outcomes", "Changes", "Progress",
  ]);

  // Section headings to skip entirely (structural, never useful as title)
  const SKIP_SECTION_HEADINGS = new Set([
    "Next Steps", "Tags", "TODO", "Blockers", "Notes",
    "Metadata", "Context", "Background",
  ]);

  let pastH1 = false;
  // After H1 there's usually metadata (Date, Status, etc.) before the first ---
  // We skip lines until we're past the first horizontal rule.
  let pastFirstHr = false;
  let currentSection: string | null = null;
  const contentSectionLines: string[] = [];
  const otherH2Headings: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Track H1
    if (trimmed.startsWith("# ")) {
      pastH1 = true;
      continue;
    }

    if (!pastH1) continue;

    // Skip the metadata block (Date, Status, Completed timestamp, etc.) before the first ---
    if (!pastFirstHr) {
      if (trimmed === "---") {
        pastFirstHr = true;
      }
      // Don't process any lines until we're past the first horizontal rule
      continue;
    }

    // H2 headings — classify the section
    if (trimmed.startsWith("## ")) {
      const headingText = trimmed.slice(3).trim();
      if (CONTENT_SECTION_HEADINGS.has(headingText)) {
        currentSection = "content";
      } else if (SKIP_SECTION_HEADINGS.has(headingText)) {
        currentSection = "skip";
      } else {
        // Potentially descriptive H2 — save as candidate title
        currentSection = null;
        otherH2Headings.push(headingText);
      }
      continue;
    }

    // H3+ — ignore
    if (trimmed.startsWith("#")) continue;

    // Skip pure HTML comment lines (nothing after the closing -->).
    // Do NOT skip lines that start with <!-- but have content after -->.
    if (trimmed === "-->") continue;
    // A line like "<!-- comment -->" with nothing after is pure comment
    if (trimmed.startsWith("<!--") && /^<!--.*-->$/.test(trimmed)) continue;

    if (currentSection === "content" && trimmed.length > 0) {
      // A line may start with an inline HTML comment followed by content.
      // Strip the comment prefix if present.
      // e.g. "<!-- PAI will add completed work here during session -->- [x] **Created wlctl...**"
      const withoutComment = trimmed.replace(/^<!--.*?-->\s*/, "");
      const effective = withoutComment.length > 0 ? withoutComment : trimmed;

      // Skip if stripping the comment left nothing (was a pure comment line)
      if (effective.length === 0) continue;

      contentSectionLines.push(effective);
    }

    // Nothing useful to collect from non-content sections here
  }

  // ---- Strategy 1: first real bullet / line under a content section ----
  for (const raw of contentSectionLines) {
    const cleaned = cleanMarkdownLine(raw);
    if (!cleaned) continue;
    if (isMetaPhrase(cleaned)) continue;
    if (cleaned.startsWith("<!--") || cleaned.includes("PAI will add")) continue;
    if (cleaned.length < 5) continue;
    return sanitizeName(cleaned);
  }

  // ---- Strategy 2: descriptive H2 headings ----
  for (const heading of otherH2Headings) {
    const cleaned = cleanMarkdownLine(heading);
    if (!cleaned) continue;
    if (isMetaPhrase(cleaned)) continue;
    if (cleaned.length > 3 && cleaned.length < 80) {
      return sanitizeName(cleaned);
    }
  }

  // ---- Strategy 3: H1 if it's not just "Session NNNN: project-name" ----
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("# ")) {
      const title = trimmed.slice(2).trim();
      // Skip bare session-number headers
      if (/^Session \d{4}/i.test(title)) continue;
      const cleaned = cleanMarkdownLine(title);
      if (cleaned && !isMetaPhrase(cleaned) && cleaned.length > 3) {
        return sanitizeName(cleaned);
      }
    }
  }

  return "Unnamed Session";
}

/**
 * Format a 4-digit padded session number.
 */
function padNum(n: number): string {
  return String(n).padStart(4, "0");
}

/**
 * Given the sessions still alive after deletion, build a renumber map.
 * Returns a Map of oldNumber → newNumber.
 */
function buildRenumberMap(survivors: SessionCandidate[]): Map<number, number> {
  const map = new Map<number, number>();
  // Sort by existing number to preserve chronological order
  const sorted = [...survivors].sort((a, b) => a.number - b.number);
  sorted.forEach((s, idx) => {
    const newNum = idx + 1;
    if (s.number !== newNum) {
      map.set(s.number, newNum);
    }
  });
  return map;
}

/**
 * Compute the target path in YYYY/MM/ hierarchy.
 */
function getTargetPath(notesDir: string, date: string, filename: string): string {
  // date is "YYYY-MM-DD"
  const [year, month] = date.split("-");
  return join(notesDir, year, month, filename);
}

// ---------------------------------------------------------------------------
// Analysis phase — build a CleanupPlan for one project
// ---------------------------------------------------------------------------

/**
 * Scan a single Notes/ directory and return all session candidates found in it.
 * Looks in both the flat top-level and any YYYY/MM/ sub-directories.
 */
function scanNotesDir(
  notesDir: string,
  dbByFilename: Map<string, SessionRow>
): SessionCandidate[] {
  const candidates: SessionCandidate[] = [];

  // Read flat .md files at the top level
  let flatFiles: string[] = [];
  try {
    flatFiles = readdirSync(notesDir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(".md"))
      .map((d) => d.name);
  } catch {
    // Directory unreadable
  }

  // Also find already-moved files in YYYY/MM/ sub-dirs
  const subDirFiles: { filename: string; filepath: string }[] = [];
  try {
    const topEntries = readdirSync(notesDir, { withFileTypes: true });
    for (const entry of topEntries) {
      if (!entry.isDirectory()) continue;
      if (!/^\d{4}$/.test(entry.name)) continue;
      const yearDir = join(notesDir, entry.name);
      const monthDirs = readdirSync(yearDir, { withFileTypes: true });
      for (const mEntry of monthDirs) {
        if (!mEntry.isDirectory()) continue;
        const monthDir = join(yearDir, mEntry.name);
        const files = readdirSync(monthDir).filter((f) => f.endsWith(".md"));
        for (const f of files) {
          subDirFiles.push({ filename: f, filepath: join(monthDir, f) });
        }
      }
    }
  } catch {
    // Ignore errors scanning sub-dirs
  }

  // Combine: flat files + already-moved files
  const allFiles: { filename: string; filepath: string }[] = [
    ...flatFiles.map((f) => ({ filename: f, filepath: join(notesDir, f) })),
    ...subDirFiles,
  ];

  for (const { filename, filepath } of allFiles) {
    let num: number;
    let date: string;
    let namepart: string;
    let classification: SessionClassification;

    const modernMatch = MODERN_PATTERN.exec(filename);
    const legacyMatch = LEGACY_PATTERN.exec(filename);

    if (modernMatch) {
      num = parseInt(modernMatch[1], 10);
      date = modernMatch[2];
      namepart = modernMatch[3];
      classification = "NAMED";
    } else if (legacyMatch) {
      num = parseInt(legacyMatch[1], 10);
      date = legacyMatch[2];
      namepart = legacyMatch[3];
      classification = "LEGACY_FORMAT";
    } else {
      // Not a session file — skip (e.g., TODO.md)
      continue;
    }

    let sizeBytes = 0;
    let content = "";
    try {
      const stat = statSync(filepath);
      sizeBytes = stat.size;
      content = readFileSync(filepath, "utf8");
    } catch {
      continue;
    }

    // Look up DB record — sessions table stores filename without YYYY/MM/ prefix
    // for flat files, or with it for already-moved files. Try both.
    const dbSession =
      dbByFilename.get(filename) ??
      dbByFilename.get(filepath.split(`${notesDir}/`)[1] ?? "") ??
      null;

    if (classification !== "LEGACY_FORMAT") {
      if (sizeBytes < 400 || isTemplateOnly(content)) {
        classification = "EMPTY";
      } else if (
        namepart === "New Session" ||
        namepart === (process.env.USER ?? "") ||
        namepart === "session-started-and-ready-for-your-instructions"
      ) {
        classification = "UNNAMED";
      }
    }

    const candidate: SessionCandidate = {
      session: dbSession,
      filename,
      filepath,
      sizeBytes,
      classification,
      date,
      number: num,
    };

    if (classification === "UNNAMED" || classification === "LEGACY_FORMAT") {
      candidate.autoName = extractAutoName(content);
    }

    candidates.push(candidate);
  }

  return candidates;
}

function analyzeProject(
  db: Database,
  project: ProjectRow
): CleanupPlan | null {
  const notesDirPaths = findAllNotesDirs(project);

  if (notesDirPaths.length === 0) return null;

  const dbSessions = getProjectSessions(db, project.id);
  const dbByFilename = new Map<string, SessionRow>();
  for (const s of dbSessions) {
    dbByFilename.set(s.filename, s);
  }

  // Scan each Notes/ directory independently, collecting per-dir plan info
  const notesDirPlans: NotesDirPlan[] = [];
  // All survivors across ALL dirs — used for global renumbering
  const allSurvivors: SessionCandidate[] = [];

  for (const notesDir of notesDirPaths) {
    const candidates = scanNotesDir(notesDir, dbByFilename);
    if (candidates.length === 0) continue;

    const toDelete = candidates.filter((c) => c.classification === "EMPTY");
    const toRename = candidates.filter(
      (c) => c.classification === "UNNAMED" || c.classification === "LEGACY_FORMAT"
    );
    const survivors = candidates.filter((c) => c.classification !== "EMPTY");

    notesDirPlans.push({ notesDir, toDelete, toRename, toMove: survivors });
    allSurvivors.push(...survivors);
  }

  if (notesDirPlans.length === 0) return null;

  // Global renumber map across both directories
  const renumberMap = buildRenumberMap(allSurvivors);

  return {
    project,
    notesDirs: notesDirPlans,
    renumberMap,
  };
}

// ---------------------------------------------------------------------------
// Dry-run display
// ---------------------------------------------------------------------------

async function displayDryRun(plans: CleanupPlan[]): Promise<void> {
  let totalDelete = 0;
  let totalRename = 0;
  let totalMove = 0;
  let totalRenumber = 0;

  for (const plan of plans) {
    const hasWork =
      plan.notesDirs.some(
        (d) => d.toDelete.length > 0 || d.toRename.length > 0 || d.toMove.length > 0
      ) || plan.renumberMap.size > 0;

    if (!hasWork) continue;

    console.log();
    console.log(header(`  Project: ${plan.project.display_name} (${plan.project.slug})`));

    for (const dirPlan of plan.notesDirs) {
      console.log(dim(`  Notes: ${dirPlan.notesDir}`));

      if (dirPlan.toDelete.length > 0) {
        console.log(bold("  DELETE (empty/template-only sessions):"));
        for (const c of dirPlan.toDelete) {
          console.log(
            `    ${chalk.red("DEL")}  ${dim(padNum(c.number))} - ${c.date} - ${c.filename.split(" - ").slice(2).join(" - ")} ${dim(`(${c.sizeBytes}b)`)}`
          );
          totalDelete++;
        }
        console.log();
      }

      if (dirPlan.toRename.length > 0) {
        console.log(bold("  RENAME (unnamed or legacy-format sessions):"));
        for (const c of dirPlan.toRename) {
          const autoName = c.autoName ?? "Unnamed Session";
          console.log(`    ${chalk.yellow("REN")}  ${c.filename}`);
          console.log(`         → ${padNum(c.number)} - ${c.date} - ${autoName}.md`);
          totalRename++;
        }
        console.log();
      }

      if (dirPlan.toMove.length > 0) {
        console.log(bold("  MOVE TO YYYY/MM/ hierarchy:"));
        for (const c of dirPlan.toMove) {
          const [year, month] = c.date.split("-");
          console.log(`    ${chalk.cyan("MOV")}  ${c.filename}`);
          console.log(`         → ${year}/${month}/${c.filename}`);
          totalMove++;
        }
        console.log();
      }
    }

    if (plan.renumberMap.size > 0) {
      console.log(bold("  RENUMBER (after deletions, global across all Notes/ dirs):"));
      for (const [oldN, newN] of plan.renumberMap) {
        console.log(`    ${chalk.blue("NUM")}  #${padNum(oldN)} → #${padNum(newN)}`);
        totalRenumber++;
      }
      console.log();
    }
  }

  // Collect absolute paths of all files that would be moved, to count
  // how many have existing vector DB entries (helps user understand embedding impact).
  const wouldMovePaths: string[] = [];
  for (const plan of plans) {
    for (const dirPlan of plan.notesDirs) {
      for (const c of dirPlan.toMove) {
        const [year, month] = c.date.split("-");
        const targetPath = join(dirPlan.notesDir, year, month, c.filename);
        if (c.filepath !== targetPath) {
          wouldMovePaths.push(c.filepath);
        }
      }
    }
  }

  const vectorDbCount = await countVectorDbPaths(wouldMovePaths);

  console.log();
  console.log(bold("  Summary (dry-run):"));
  console.log(`    ${chalk.red("DEL")}  ${totalDelete} empty sessions to delete`);
  console.log(`    ${chalk.yellow("REN")}  ${totalRename} unnamed sessions to rename`);
  console.log(`    ${chalk.blue("NUM")}  ${totalRenumber} sessions to renumber`);
  console.log(`    ${chalk.cyan("MOV")}  ${totalMove} sessions to move into YYYY/MM/ dirs`);
  if (vectorDbCount > 0) {
    console.log(`    ${chalk.magenta("VEC")}  ${vectorDbCount} file path(s) will be updated in the vector DB (embeddings preserved)`);
  } else if (wouldMovePaths.length > 0) {
    console.log(`    ${chalk.magenta("VEC")}  0 file path(s) found in vector DB for moved files (no embeddings to preserve)`);
  }
  console.log();
  console.log(warn("  This is a dry-run. Add --execute to apply changes."));
  console.log();
}

// ---------------------------------------------------------------------------
// Postgres path update helper
// ---------------------------------------------------------------------------

/**
 * Count how many files in the vector DB match the given old paths.
 * Used for dry-run reporting. Returns 0 if Postgres is unavailable.
 */
async function countVectorDbPaths(oldPaths: string[]): Promise<number> {
  if (oldPaths.length === 0) return 0;

  try {
    const { loadConfig } = await import("../../daemon/config.js");
    const { PostgresBackend } = await import("../../storage/postgres.js");

    const config = loadConfig();
    if (config.storageBackend !== "postgres") return 0;

    const pgConfig = config.postgres ?? {};
    const pgBackend = new PostgresBackend(pgConfig);

    const connErr = await pgBackend.testConnection();
    if (connErr) {
      await pgBackend.close();
      return 0;
    }

    const pool = (pgBackend as unknown as { pool: { query: (sql: string, params: string[]) => Promise<{ rows: Array<{ n: string }> }> } }).pool;
    const placeholders = oldPaths.map((_, i) => `$${i + 1}`).join(", ");
    const result = await pool.query(
      `SELECT COUNT(*)::text AS n FROM pai_files WHERE path IN (${placeholders})`,
      oldPaths
    );

    await pgBackend.close();
    return parseInt(result.rows[0]?.n ?? "0", 10);
  } catch {
    return 0;
  }
}

/**
 * Update file paths in pai_files and pai_chunks for all moved session notes.
 * Returns the number of pai_files rows updated, or -1 on error.
 *
 * Both tables store path directly (no FK between them), so both must be updated.
 */
async function updateVectorDbPaths(
  moves: Array<{ oldPath: string; newPath: string }>
): Promise<number> {
  if (moves.length === 0) return 0;

  try {
    const { loadConfig } = await import("../../daemon/config.js");
    const { PostgresBackend } = await import("../../storage/postgres.js");

    const config = loadConfig();
    if (config.storageBackend !== "postgres") return 0;

    const pgConfig = config.postgres ?? {};
    const pgBackend = new PostgresBackend(pgConfig);

    const connErr = await pgBackend.testConnection();
    if (connErr) {
      process.stderr.write(`[session-cleanup] Postgres unavailable (${connErr}). Skipping vector DB path update.\n`);
      await pgBackend.close();
      return 0;
    }

    const pool = (pgBackend as unknown as { pool: { connect: () => Promise<{ query: (sql: string, params: string[]) => Promise<{ rowCount: number | null }>; release: () => void }> } }).pool;
    const client = await pool.connect();

    let filesUpdated = 0;

    try {
      await client.query("BEGIN", []);

      for (const { oldPath, newPath } of moves) {
        const filesResult = await client.query(
          "UPDATE pai_files SET path = $1 WHERE path = $2",
          [newPath, oldPath]
        );
        filesUpdated += filesResult.rowCount ?? 0;

        await client.query(
          "UPDATE pai_chunks SET path = $1 WHERE path = $2",
          [newPath, oldPath]
        );
      }

      await client.query("COMMIT", []);
    } catch (e) {
      await client.query("ROLLBACK", []);
      throw e;
    } finally {
      client.release();
    }

    await pgBackend.close();
    return filesUpdated;
  } catch (e) {
    process.stderr.write(`[session-cleanup] Failed to update vector DB paths: ${e}\n`);
    return -1;
  }
}

// ---------------------------------------------------------------------------
// Execution phase
// ---------------------------------------------------------------------------

async function executeCleanup(db: Database, plans: CleanupPlan[], skipReindex: boolean): Promise<void> {
  let deleted = 0;
  let renamed = 0;
  let moved = 0;
  let renumbered = 0;
  let dbUpdated = 0;

  // Track all file moves: old absolute path → new absolute path
  // Used to update pai_files and pai_chunks in Postgres after all moves complete.
  const vectorDbMoves: Array<{ oldPath: string; newPath: string }> = [];

  for (const plan of plans) {
    console.log();
    console.log(header(`  Project: ${plan.project.display_name} (${plan.project.slug})`));

    // Process each Notes/ directory independently for delete, rename, and move
    for (const dirPlan of plan.notesDirs) {
      const { notesDir } = dirPlan;

      if (plan.notesDirs.length > 1) {
        console.log(dim(`  Directory: ${notesDir}`));
      }

      // -----------------------------------------------------------------------
      // Step 1: Delete empty sessions
      // -----------------------------------------------------------------------
      for (const c of dirPlan.toDelete) {
        try {
          unlinkSync(c.filepath);
          console.log(ok(`  DEL  ${c.filename}`));
          deleted++;
        } catch (e) {
          console.log(err(`  FAIL to delete ${c.filename}: ${e}`));
        }

        // Remove from DB
        if (c.session) {
          try {
            db.prepare("DELETE FROM sessions WHERE id = ?").run(c.session.id);
            dbUpdated++;
          } catch (e) {
            console.log(err(`  FAIL to remove session #${c.number} from DB: ${e}`));
          }
        }
      }

      // -----------------------------------------------------------------------
      // Step 2: Rename unnamed/legacy sessions (in-place, before moving)
      // -----------------------------------------------------------------------
      for (const c of dirPlan.toRename) {
        const autoName = c.autoName ?? "Unnamed Session";
        const newFilename = `${padNum(c.number)} - ${c.date} - ${autoName}.md`;
        const newPath = join(notesDir, newFilename);

        if (c.filepath !== newPath) {
          try {
            renameSync(c.filepath, newPath);
            console.log(ok(`  REN  ${c.filename}`));
            console.log(dim(`       → ${newFilename}`));
            renamed++;
            // Update candidate for subsequent move step
            (c as { filename: string }).filename = newFilename;
            (c as { filepath: string }).filepath = newPath;
          } catch (e) {
            console.log(err(`  FAIL rename ${c.filename}: ${e}`));
            continue;
          }
        }

        // Update content H1
        try {
          const content = readFileSync(newPath, "utf8");
          const lines = content.split("\n");
          let h1Updated = false;
          const updated = lines.map((line) => {
            if (!h1Updated && line.startsWith("# ")) {
              h1Updated = true;
              return `# ${autoName}`;
            }
            return line;
          });
          if (!h1Updated) {
            updated.unshift(`# ${autoName}`, "");
          }
          writeFileSync(newPath, updated.join("\n"), "utf8");
        } catch {
          // Non-fatal
        }

        // Update DB
        if (c.session) {
          const normalizedSlug = autoName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "");
          try {
            db.prepare(
              "UPDATE sessions SET slug = ?, title = ?, filename = ? WHERE id = ?"
            ).run(normalizedSlug, autoName, newFilename, c.session.id);
            dbUpdated++;
          } catch (e) {
            console.log(err(`  FAIL DB update for session #${c.number}: ${e}`));
          }
        }
      }

      // -----------------------------------------------------------------------
      // Step 3a: Renumber survivors within this directory (global map)
      // -----------------------------------------------------------------------
      if (plan.renumberMap.size > 0) {
        const toRenumber = dirPlan.toMove.filter((c) => plan.renumberMap.has(c.number));

        // Pass 1: rename all candidates to temp files to avoid conflicts
        const tempFiles: { candidate: SessionCandidate; tempPath: string; newNum: number }[] = [];
        for (const c of toRenumber) {
          const newNum = plan.renumberMap.get(c.number)!;
          const tempFilename = `__tmp_${padNum(c.number)}_${c.filename}`;
          const tempPath = join(notesDir, tempFilename);
          try {
            if (existsSync(c.filepath)) {
              renameSync(c.filepath, tempPath);
              tempFiles.push({ candidate: c, tempPath, newNum });
            }
          } catch (e) {
            console.log(err(`  FAIL temp-rename #${c.number}: ${e}`));
          }
        }

        // Pass 2: rename temp files to final names with new numbers
        for (const { candidate: c, tempPath, newNum } of tempFiles) {
          const newFilename = c.filename.replace(/^\d{4}/, padNum(newNum));
          const newPath = join(notesDir, newFilename);
          try {
            renameSync(tempPath, newPath);
            console.log(ok(`  NUM  #${padNum(c.number)} → #${padNum(newNum)}: ${newFilename}`));
            renumbered++;
            // Update candidate for the move step
            (c as { filename: string }).filename = newFilename;
            (c as { filepath: string }).filepath = newPath;
            (c as { number: number }).number = newNum;
          } catch (e) {
            console.log(err(`  FAIL final-rename #${newNum}: ${e}`));
          }

          // Update content H1 to reflect new number
          if (existsSync(newPath)) {
            try {
              const content = readFileSync(newPath, "utf8");
              const lines = content.split("\n");
              const updated = lines.map((line) => {
                if (line.match(/^# Session \d{4}:/)) {
                  return line.replace(/^# Session \d{4}:/, `# Session ${padNum(newNum)}:`);
                }
                return line;
              });
              writeFileSync(newPath, updated.join("\n"), "utf8");
            } catch {
              // Non-fatal
            }
          }
        }

        // Update DB for sessions in this directory (two-pass for UNIQUE constraint safety)
        const dbRenumbers = tempFiles
          .filter(({ candidate: c }) => c.session != null)
          .map(({ candidate: c, newNum }) => ({ session: c.session!, newNum, newFilename: c.filename }));

        if (dbRenumbers.length > 0) {
          const renumberDb = db.transaction(() => {
            for (const { session, newNum } of dbRenumbers) {
              db.prepare("UPDATE sessions SET number = ? WHERE id = ?").run(-newNum, session.id);
            }
            for (const { session, newNum, newFilename } of dbRenumbers) {
              db.prepare("UPDATE sessions SET number = ?, filename = ? WHERE id = ?").run(
                newNum, newFilename, session.id
              );
            }
          });
          try {
            renumberDb();
            dbUpdated += dbRenumbers.length;
          } catch (e) {
            console.log(err(`  FAIL DB renumber transaction: ${e}`));
          }
        }
      }

      // -----------------------------------------------------------------------
      // Step 3b: Move survivors to YYYY/MM/ hierarchy within this Notes/ dir
      // -----------------------------------------------------------------------
      for (const c of dirPlan.toMove) {
        const [year, month] = c.date.split("-");
        const targetDir = join(notesDir, year, month);
        const targetPath = join(targetDir, c.filename);

        // Skip if already in the right place
        if (c.filepath === targetPath) continue;

        // Create target dir
        try {
          mkdirSync(targetDir, { recursive: true });
        } catch (e) {
          console.log(err(`  FAIL mkdir ${targetDir}: ${e}`));
          continue;
        }

        // Move the file
        const oldAbsPath = c.filepath;
        try {
          if (existsSync(c.filepath)) {
            renameSync(c.filepath, targetPath);
            console.log(ok(`  MOV  ${c.filename}`));
            console.log(dim(`       → ${year}/${month}/${c.filename}`));
            moved++;
            vectorDbMoves.push({ oldPath: oldAbsPath, newPath: targetPath });
          }
        } catch (e) {
          console.log(err(`  FAIL move ${c.filename}: ${e}`));
          continue;
        }

        // Update DB filename to include the YYYY/MM/ prefix
        const newFilenameInDb = `${year}/${month}/${c.filename}`;
        if (c.session) {
          try {
            db.prepare("UPDATE sessions SET filename = ? WHERE id = ?").run(
              newFilenameInDb,
              c.session.id
            );
            dbUpdated++;
          } catch (e) {
            console.log(err(`  FAIL DB update path for ${c.filename}: ${e}`));
          }
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Step 5: Update Postgres vector DB paths to preserve embeddings
  // -----------------------------------------------------------------------
  let vectorDbUpdated = 0;
  if (vectorDbMoves.length > 0) {
    console.log();
    console.log(dim(`  Updating ${vectorDbMoves.length} file path(s) in vector DB to preserve embeddings...`));
    const result = await updateVectorDbPaths(vectorDbMoves);
    if (result >= 0) {
      vectorDbUpdated = result;
      console.log(ok(`  Updated ${vectorDbUpdated} file path(s) in Postgres (embeddings preserved)`));
    } else {
      console.log(warn("  Vector DB path update failed — embeddings may be orphaned (check logs)"));
    }
  }

  console.log();
  console.log(bold("  Cleanup complete:"));
  console.log(ok(`    ${deleted} session(s) deleted`));
  console.log(ok(`    ${renamed} session(s) renamed`));
  console.log(ok(`    ${renumbered} session(s) renumbered`));
  console.log(ok(`    ${moved} session(s) moved to YYYY/MM/ hierarchy`));
  console.log(ok(`    ${dbUpdated} registry DB record(s) updated`));
  if (vectorDbMoves.length > 0) {
    console.log(ok(`    ${vectorDbUpdated} vector DB file path(s) updated (embeddings preserved)`));
  }

  if (!skipReindex) {
    console.log();
    console.log(dim("  Memory re-index: the PAI daemon will pick up changes within 5 minutes."));
    console.log(dim("  To force immediate re-index: pai memory index --all"));
  }

  console.log();
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

export function registerSessionCleanupCommand(
  sessionCmd: Command,
  getDb: () => Database
): void {
  sessionCmd
    .command("cleanup [project-slug]")
    .description(
      "Clean up session notes: delete empties, auto-name unnamed, move into YYYY/MM/ hierarchy, renumber"
    )
    .option("--execute", "Actually perform the cleanup (default is dry-run)")
    .option("--no-renumber", "Skip renumbering sessions after deletions")
    .option("--no-reindex", "Skip triggering memory re-index after moves")
    .action(
      async (
        projectSlug: string | undefined,
        opts: { execute?: boolean; renumber?: boolean; reindex?: boolean }
      ) => {
        const db = getDb();
        const dryRun = !opts.execute;
        const skipReindex = opts.reindex === false;

        let projects: ProjectRow[];
        if (projectSlug) {
          const p = getProject(db, projectSlug);
          if (!p) {
            console.error(err(`Project not found: ${projectSlug}`));
            process.exit(1);
          }
          projects = [p];
        } else {
          projects = getAllProjects(db);
        }

        console.log();
        console.log(
          header(
            dryRun
              ? "  pai session cleanup — DRY RUN (no changes will be made)"
              : "  pai session cleanup — EXECUTING"
          )
        );
        console.log(
          dim(`  Analyzing ${projects.length} project(s)...`)
        );

        const plans: CleanupPlan[] = [];
        for (const project of projects) {
          const plan = analyzeProject(db, project);
          if (plan) {
            plans.push(plan);
          }
        }

        const activePlans = plans.filter(
          (p) =>
            p.notesDirs.some(
              (d) => d.toDelete.length > 0 || d.toRename.length > 0 || d.toMove.length > 0
            ) || p.renumberMap.size > 0
        );

        if (activePlans.length === 0) {
          console.log();
          console.log(ok("  Nothing to do — all session notes are clean!"));
          console.log();
          return;
        }

        if (dryRun) {
          await displayDryRun(activePlans);
        } else {
          await executeCleanup(db, activePlans, skipReindex);
        }
      }
    );
}
