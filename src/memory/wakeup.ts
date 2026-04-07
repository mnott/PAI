/**
 * Wake-up context system — progressive context loading inspired by mempalace.
 *
 * Layers:
 *   L0 Identity     (~100 tokens)   — user identity from ~/.pai/identity.txt. Always loaded.
 *   L1 Essential Story (~500-800t)  — top session notes for the project, key lines extracted.
 *   L2 On-Demand                    — triggered by topic queries (handled by memory_search).
 *   L3 Deep Search                  — unlimited federated memory search (memory_search tool).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum tokens for the L1 essential story block. Approx 4 chars/token. */
const L1_TOKEN_BUDGET = 800;
const L1_CHAR_BUDGET = L1_TOKEN_BUDGET * 4; // ~3200 chars

/** Maximum session notes to scan when building L1. */
const L1_MAX_NOTES = 10;

/** Sections to extract from session notes (in priority order). */
const EXTRACT_SECTIONS = [
  "Work Done",
  "Key Decisions",
  "Next Steps",
  "Checkpoint",
];

/** Identity file location. */
const IDENTITY_FILE = join(homedir(), ".pai", "identity.txt");

// ---------------------------------------------------------------------------
// L0: Identity
// ---------------------------------------------------------------------------

/**
 * Load L0 identity from ~/.pai/identity.txt.
 * Returns the file content, or an empty string if the file does not exist.
 * Never throws.
 */
export function loadL0Identity(): string {
  if (!existsSync(IDENTITY_FILE)) return "";
  try {
    return readFileSync(IDENTITY_FILE, "utf-8").trim();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// L1: Essential Story
// ---------------------------------------------------------------------------

/**
 * Find the Notes directory for a project given its root_path from the registry.
 * Checks local Notes/ first, then central ~/.claude/projects/... path.
 */
function findNotesDirForProject(rootPath: string): string | null {
  // Check local Notes directories first
  const localCandidates = [
    join(rootPath, "Notes"),
    join(rootPath, "notes"),
    join(rootPath, ".claude", "Notes"),
  ];
  for (const p of localCandidates) {
    if (existsSync(p)) return p;
  }

  // Fall back to central ~/.claude/projects/{encoded}/Notes
  const encoded = rootPath
    .replace(/\//g, "-")
    .replace(/\./g, "-")
    .replace(/ /g, "-");
  const centralNotes = join(
    homedir(),
    ".claude",
    "projects",
    encoded,
    "Notes"
  );
  if (existsSync(centralNotes)) return centralNotes;

  return null;
}

/**
 * Recursively find all .md session note files in a Notes directory.
 * Handles both flat layout (Notes/*.md) and month-subdirectory layout
 * (Notes/YYYY/MM/*.md). Returns files sorted newest-first by filename
 * (note numbers are monotonically increasing, so lexicographic = newest-last,
 * so we reverse).
 */
function findSessionNotes(notesDir: string): string[] {
  const result: string[] = [];

  const scanDir = (dir: string) => {
    if (!existsSync(dir)) return;
    let entries: string[];
    try {
      entries = readdirSync(dir, { withFileTypes: true } as Parameters<typeof readdirSync>[1] as any)
        .map((e: any) => ({ name: e.name, isDir: e.isDirectory() }));
    } catch {
      return;
    }

    for (const entry of entries as Array<{ name: string; isDir: boolean }>) {
      const fullPath = join(dir, entry.name);
      if (entry.isDir) {
        // Recurse into YYYY/MM subdirectories
        scanDir(fullPath);
      } else if (entry.name.match(/^\d{3,4}[\s_-].*\.md$/)) {
        result.push(fullPath);
      }
    }
  };

  scanDir(notesDir);

  // Sort: extract leading number, highest = most recent
  result.sort((a, b) => {
    const numA = parseInt(basename(a).match(/^(\d+)/)?.[1] ?? "0", 10);
    const numB = parseInt(basename(b).match(/^(\d+)/)?.[1] ?? "0", 10);
    return numB - numA; // newest first
  });

  return result;
}

/**
 * Extract the most important lines from a session note.
 * Prioritises: Work Done items, Key Decisions, Next Steps, Checkpoint headings.
 * Returns a condensed string under maxChars.
 */
function extractKeyLines(content: string, maxChars: number): string {
  const lines = content.split("\n");
  const selected: string[] = [];
  let inTargetSection = false;
  let currentSection = "";
  let charCount = 0;

  // First pass: collect lines from priority sections
  for (const line of lines) {
    // Detect section headers
    const h2Match = line.match(/^## (.+)$/);
    const h3Match = line.match(/^### (.+)$/);
    if (h2Match) {
      currentSection = h2Match[1];
      inTargetSection = EXTRACT_SECTIONS.some((s) =>
        currentSection.toLowerCase().includes(s.toLowerCase())
      );
      continue;
    }
    if (h3Match) {
      // Checkpoints / sub-sections — include heading as label
      if (inTargetSection) {
        const label = `[${h3Match[1]}]`;
        if (charCount + label.length < maxChars) {
          selected.push(label);
          charCount += label.length + 1;
        }
      }
      continue;
    }

    if (!inTargetSection) continue;

    // Skip blank lines and HTML comments
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("<!--") || trimmed === "---") continue;

    // Include checkbox items, bold text, and plain text lines
    if (
      trimmed.startsWith("- ") ||
      trimmed.startsWith("* ") ||
      trimmed.match(/^\d+\./) ||
      trimmed.startsWith("**")
    ) {
      if (charCount + trimmed.length + 1 > maxChars) break;
      selected.push(trimmed);
      charCount += trimmed.length + 1;
    }
  }

  return selected.join("\n");
}

/**
 * Build the L1 essential story block.
 *
 * Reads the most recent session notes for the project and extracts the key
 * lines (Work Done, Key Decisions, Next Steps) within the token budget.
 *
 * @param rootPath   The project root path (from the registry).
 * @param tokenBudget  Max tokens to consume. Default 800 (~3200 chars).
 * @returns Formatted L1 block, or empty string if no notes found.
 */
export function buildL1EssentialStory(
  rootPath: string,
  tokenBudget = L1_TOKEN_BUDGET
): string {
  const charBudget = tokenBudget * 4;
  const notesDir = findNotesDirForProject(rootPath);
  if (!notesDir) return "";

  const noteFiles = findSessionNotes(notesDir).slice(0, L1_MAX_NOTES);
  if (noteFiles.length === 0) return "";

  const sections: string[] = [];
  let remaining = charBudget;

  for (const noteFile of noteFiles) {
    if (remaining <= 50) break;

    let content: string;
    try {
      content = readFileSync(noteFile, "utf-8");
    } catch {
      continue;
    }

    // Extract the note date and title from the filename
    const name = basename(noteFile);
    const titleMatch = name.match(/^\d+ - (\d{4}-\d{2}-\d{2}) - (.+)\.md$/);
    const dateLabel = titleMatch ? titleMatch[1] : "";
    const titleLabel = titleMatch
      ? titleMatch[2]
      : name.replace(/^\d+ - /, "").replace(/\.md$/, "");

    // Skip if nothing useful extracted from this note
    const perNoteChars = Math.min(remaining, Math.floor(charBudget / noteFiles.length) + 200);
    const extracted = extractKeyLines(content, perNoteChars);
    if (!extracted) continue;

    const noteBlock = `[${dateLabel} - ${titleLabel}]\n${extracted}`;
    sections.push(noteBlock);
    remaining -= noteBlock.length + 1;
  }

  if (sections.length === 0) return "";

  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Combined: buildWakeupContext
// ---------------------------------------------------------------------------

/**
 * Build the combined wake-up context block (L0 + L1).
 *
 * Returns a formatted string suitable for injection as a system-reminder,
 * or an empty string if both layers are empty.
 *
 * @param rootPath   Project root path for L1 note lookup. Optional.
 * @param tokenBudget  L1 token budget. Default 800.
 */
export function buildWakeupContext(
  rootPath?: string,
  tokenBudget = L1_TOKEN_BUDGET
): string {
  const identity = loadL0Identity();
  const essentialStory = rootPath
    ? buildL1EssentialStory(rootPath, tokenBudget)
    : "";

  if (!identity && !essentialStory) return "";

  const parts: string[] = [];

  if (identity) {
    parts.push(`## L0 Identity\n\n${identity}`);
  }

  if (essentialStory) {
    parts.push(`## L1 Essential Story\n\n${essentialStory}`);
  }

  return parts.join("\n\n");
}
