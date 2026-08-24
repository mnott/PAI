/**
 * Analysis phase: scan Notes/ directories and build CleanupPlans.
 */

import type { Database } from "better-sqlite3";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  ProjectRow,
  SessionRow,
  SessionCandidate,
  SessionClassification,
  NotesDirPlan,
  CleanupPlan,
} from "./types.js";
import {
  TEMPLATE_INDICATORS,
  MODERN_PATTERN,
  LEGACY_PATTERN,
} from "./types.js";
import { extractAutoName, padNum } from "./rename.js";

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

export function getAllProjects(db: Database): ProjectRow[] {
  return db
    .prepare(
      "SELECT id, slug, display_name, root_path, encoded_dir, claude_notes_dir FROM projects WHERE status = 'active' ORDER BY slug"
    )
    .all() as ProjectRow[];
}

export function getProject(
  db: Database,
  slug: string
): ProjectRow | undefined {
  return db
    .prepare(
      "SELECT id, slug, display_name, root_path, encoded_dir, claude_notes_dir FROM projects WHERE slug = ?"
    )
    .get(slug) as ProjectRow | undefined;
}

function getProjectSessions(
  db: Database,
  projectId: number
): SessionRow[] {
  return db
    .prepare("SELECT * FROM sessions WHERE project_id = ? ORDER BY number ASC")
    .all(projectId) as SessionRow[];
}

// ---------------------------------------------------------------------------
// Notes directory discovery
// ---------------------------------------------------------------------------

function findRootNotesDir(rootPath: string): string | null {
  const canonical = join(rootPath, "Notes");
  if (existsSync(canonical)) return canonical;
  const alt = join(rootPath, ".claude", "Notes");
  if (existsSync(alt)) return alt;
  return null;
}

function findClaudeNotesDir(
  project: ProjectRow,
  rootNotesDir: string | null
): string | null {
  const candidate =
    project.claude_notes_dir ??
    join(homedir(), ".claude", "projects", project.encoded_dir, "Notes");

  if (!existsSync(candidate)) return null;
  if (rootNotesDir && candidate === rootNotesDir) return null;
  return candidate;
}

export function findAllNotesDirs(project: ProjectRow): string[] {
  const rootDir = findRootNotesDir(project.root_path);
  const claudeDir = findClaudeNotesDir(project, rootDir);
  const dirs: string[] = [];
  if (rootDir) dirs.push(rootDir);
  if (claudeDir) dirs.push(claudeDir);
  return dirs;
}

// ---------------------------------------------------------------------------
// Content analysis
// ---------------------------------------------------------------------------

function isTemplateOnly(content: string): boolean {
  const hasTemplateMarker = TEMPLATE_INDICATORS.some((ind) =>
    content.includes(ind)
  );
  if (!hasTemplateMarker) return false;

  const lines = content.split("\n");
  let inWorkDone = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "## Work Done") {
      inWorkDone = true;
      continue;
    }
    if (trimmed.startsWith("## ") && inWorkDone) break;
    if (!inWorkDone) continue;
    if (!trimmed) continue;
    if (trimmed.startsWith("<!--") && trimmed.endsWith("-->")) continue;
    if (trimmed.startsWith("<!--")) continue;
    if (trimmed === "-->") continue;
    if (trimmed === "Session completed.") continue;
    if (trimmed === "#Session" || trimmed === "**Tags:** #Session") continue;
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Scan + analysis
// ---------------------------------------------------------------------------

export function scanNotesDir(
  notesDir: string,
  dbByFilename: Map<string, SessionRow>
): SessionCandidate[] {
  const candidates: SessionCandidate[] = [];

  let flatFiles: string[] = [];
  try {
    flatFiles = readdirSync(notesDir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(".md"))
      .map((d) => d.name);
  } catch {
    // Directory unreadable
  }

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
      continue; // not a session file
    }

    let sizeBytes = 0;
    let content = "";
    try {
      sizeBytes = statSync(filepath).size;
      content = readFileSync(filepath, "utf8");
    } catch {
      continue;
    }

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

    if (
      classification === "UNNAMED" ||
      classification === "LEGACY_FORMAT"
    ) {
      candidate.autoName = extractAutoName(content);
    }

    candidates.push(candidate);
  }

  return candidates;
}

/**
 * Renumbering is disabled. This always returns an empty map.
 *
 * It used to reassign every surviving note to its position in the sorted list
 * (`newNum = idx + 1`), which treats the number as a position. The number is
 * also the note's identity — handovers and other notes cite notes by number —
 * and a value that is both a position and an identity parts company with
 * itself the moment the set changes.
 *
 * What that cost, measured on a real corpus: deleting or adding one note
 * shifted the whole series, and because the number is also written into the H1
 * (`# Session 0006: ...`), the rewrite changed file *contents* as well as
 * names. Git could not pair them as renames — 0 of 262 rewritten notes were
 * byte-identical to anything in HEAD — so a single shift produced 261 deletions
 * plus 262 additions. The operator changed one source file and their prompt
 * reported 262 changes, which hides any real uncommitted work in the noise.
 *
 * Numbers are now minted once, at creation, and never reassigned. Gaps are
 * expected and harmless: a gap is information (a note was removed) and costs
 * nothing, whereas a renumber invalidates every existing reference silently.
 *
 * Kept as a function rather than deleted so the call site and the CleanupPlan
 * shape stay intact; collisions should be reported by the caller, never
 * resolved by shifting.
 */
function buildRenumberMap(
  _survivors: SessionCandidate[]
): Map<number, number> {
  return new Map();
}

export function analyzeProject(
  db: Database,
  project: ProjectRow
): CleanupPlan | null {
  const notesDirPaths = findAllNotesDirs(project);
  if (notesDirPaths.length === 0) return null;

  const dbSessions = getProjectSessions(db, project.id);
  const dbByFilename = new Map<string, SessionRow>();
  for (const s of dbSessions) dbByFilename.set(s.filename, s);

  const notesDirPlans: NotesDirPlan[] = [];
  const allSurvivors: SessionCandidate[] = [];

  for (const notesDir of notesDirPaths) {
    const candidates = scanNotesDir(notesDir, dbByFilename);
    if (candidates.length === 0) continue;

    const toDelete = candidates.filter((c) => c.classification === "EMPTY");
    const toRename = candidates.filter(
      (c) =>
        c.classification === "UNNAMED" || c.classification === "LEGACY_FORMAT"
    );
    const survivors = candidates.filter((c) => c.classification !== "EMPTY");

    notesDirPlans.push({ notesDir, toDelete, toRename, toMove: survivors });
    allSurvivors.push(...survivors);
  }

  if (notesDirPlans.length === 0) return null;

  const renumberMap = buildRenumberMap(allSurvivors);

  return { project, notesDirs: notesDirPlans, renumberMap };
}
