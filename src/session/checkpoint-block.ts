/**
 * Shared "## Continue" checkpoint logic for a project's TODO.md.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Before this, `pause.ts` and `handover.ts` each carried their own copy of
 * findProjectTodo / stripContinueSection / block-builder. Both wrote the same
 * fixed four-line block, and both stripped any existing ## Continue section
 * unconditionally. The consequence was that a rich, model-authored checkpoint
 * could never survive:
 *
 *   1. `pai pause` had no way to accept a body, so the model printed its
 *      checkpoint to the terminal and it was lost.
 *   2. Even if a body had been written by hand, the session-stop hook runs
 *      `pai session handover` on every clean exit, which regenerated the
 *      generic block and erased it.
 *
 * So there are two jobs here:
 *
 *   - AUTHORED writes (`pai pause --body-file`) carry the model's markdown
 *     verbatim, wrapped in explicit start/end markers.
 *   - AUTO writes (hooks) must never destroy an authored checkpoint belonging
 *     to the *same* session. They may replace a stale one left by an earlier
 *     session, otherwise TODO.md would show a checkpoint that no longer
 *     describes where the work stands.
 *
 * PARSING
 * -------
 * A rich body can legitimately contain `---` rules and `##` headings, which the
 * old heuristic scanner treated as section terminators. Authored blocks are
 * therefore delimited by an explicit HTML-comment pair; the legacy heuristic is
 * kept only as a fallback for blocks written before this change.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  renameSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Locations searched for a project TODO.md, in priority order. */
export const TODO_LOCATIONS = [
  "Notes/TODO.md",
  ".claude/Notes/TODO.md",
  "tasks/todo.md",
  "TODO.md",
];

export const MARKER_OPEN = "<!-- pai:checkpoint";
export const MARKER_CLOSE = "<!-- /pai:checkpoint -->";

export const CONTINUE_HEADING = "## Continue";

/** Who wrote the checkpoint currently in TODO.md. */
export type Authorship = "model" | "auto";

/** Result of applying a checkpoint. */
export type ApplyAction = "written" | "preserved" | "failed";

// ---------------------------------------------------------------------------
// TODO.md discovery
// ---------------------------------------------------------------------------

export function findProjectTodo(
  rootPath: string
): { path: string; content: string } | null {
  for (const rel of TODO_LOCATIONS) {
    const full = join(rootPath, rel);
    if (existsSync(full)) {
      try {
        return { path: full, content: readFileSync(full, "utf8") };
      } catch {
        // unreadable — try next
      }
    }
  }
  return null;
}

/**
 * Resolve the TODO.md to write to, creating Notes/ if nothing exists yet.
 * Returns null only when the directory could not be created.
 */
export function resolveTodoTarget(
  rootPath: string,
  opts: { create?: boolean } = {}
): { path: string; content: string } | null {
  const found = findProjectTodo(rootPath);
  if (found) return found;

  const notesDir = join(rootPath, "Notes");
  if (opts.create !== false) {
    try {
      if (!existsSync(notesDir)) mkdirSync(notesDir, { recursive: true });
    } catch {
      return null;
    }
  }
  return { path: join(notesDir, "TODO.md"), content: "" };
}

// ---------------------------------------------------------------------------
// Marker parsing
// ---------------------------------------------------------------------------

export interface CheckpointMeta {
  authored: Authorship;
  /** Session line the checkpoint describes, e.g. "0003 - 2026-08-01 - Title". */
  session?: string;
  /** Claude Code session UUID, when known. */
  sessionId?: string;
  ts?: string;
}

/**
 * Parse a `<!-- pai:checkpoint key="value" ... -->` marker line.
 * Returns null when the line is not a marker.
 */
export function parseMarker(line: string): CheckpointMeta | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(MARKER_OPEN)) return null;

  const attrs: Record<string, string> = {};
  for (const m of trimmed.matchAll(/([a-zA-Z][\w-]*)="([^"]*)"/g)) {
    attrs[m[1]] = m[2];
  }

  return {
    authored: attrs.authored === "model" ? "model" : "auto",
    session: attrs.session || undefined,
    sessionId: attrs["session-id"] || undefined,
    ts: attrs.ts || undefined,
  };
}

export interface LocatedContinue {
  /** Index of the "## Continue" heading line. */
  startIdx: number;
  /** Exclusive end index, past any trailing `---` separator. */
  endIdx: number;
  meta: CheckpointMeta | null;
  /** Raw lines of the section, heading included. */
  lines: string[];
}

/**
 * Lines an auto-generated block is made of. Anything else in a section is
 * content somebody put there deliberately.
 */
const BOILERPLATE_PATTERNS = [
  /^##\s+Continue$/,
  /^<!--\s*\/?pai:checkpoint/,
  /^>\s*\*\*Last session:\*\*/,
  /^>\s*\*\*Paused at:\*\*/,
  /^>\s*Working directory:/,
  /^>\s*Resume with:/,
  /^>\s*_No checkpoint body was recorded/,
  /^>?\s*$/,
  /^-{3,}$/,
];

/**
 * True when a section contains nothing but generated header lines.
 *
 * This is the guard that stops an auto write from destroying content it did
 * not author. A session that hit the old clobbering bug may have worked around
 * it by hand — writing its state into a subsection underneath the generated
 * header lines, in an unmarked block. Those blocks predate the marker, so
 * authorship cannot be read off them; the only safe signal is whether anything
 * beyond boilerplate is present.
 */
export function isBoilerplateOnly(lines: string[]): boolean {
  return lines.every((line) => {
    const t = line.trim();
    return BOILERPLATE_PATTERNS.some((re) => re.test(t));
  });
}

/** Extract the non-boilerplate content of a section, or "" if there is none. */
export function extractSectionContent(lines: string[]): string {
  const kept: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (BOILERPLATE_PATTERNS.some((re) => re.test(t))) continue;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

/**
 * Locate the existing ## Continue section.
 *
 * When the section carries an explicit marker pair, the close marker defines
 * the end — this is what lets a rich body contain `---` and `##` safely.
 * Otherwise the legacy heuristic applies: stop at the first `---` or the next
 * `##` heading.
 */
export function locateContinue(content: string): LocatedContinue | null {
  const lines = content.split("\n");
  const startIdx = lines.findIndex((l) => l.trim() === CONTINUE_HEADING);
  if (startIdx === -1) return null;

  // Look for an open marker in the first few lines of the section.
  let meta: CheckpointMeta | null = null;
  let markerIdx = -1;
  for (let i = startIdx + 1; i < Math.min(startIdx + 6, lines.length); i++) {
    const parsed = parseMarker(lines[i]);
    if (parsed) {
      meta = parsed;
      markerIdx = i;
      break;
    }
    // A non-blank, non-marker line means there is no marker for this section.
    if (lines[i].trim() !== "") break;
  }

  let endIdx = lines.length;

  if (markerIdx !== -1) {
    const closeIdx = lines.findIndex(
      (l, i) => i > markerIdx && l.trim() === MARKER_CLOSE
    );
    if (closeIdx !== -1) {
      endIdx = closeIdx + 1;
    } else {
      // Malformed (open without close) — fall back to the heuristic so we do
      // not swallow the rest of the file.
      endIdx = heuristicEnd(lines, startIdx);
    }
  } else {
    endIdx = heuristicEnd(lines, startIdx);
  }

  // Consume one trailing `---` separator and the blank lines around it.
  let trailingEnd = endIdx;
  while (trailingEnd < lines.length && lines[trailingEnd].trim() === "") {
    trailingEnd += 1;
  }
  if (trailingEnd < lines.length && lines[trailingEnd].trim() === "---") {
    trailingEnd += 1;
  } else {
    trailingEnd = endIdx;
  }

  return {
    startIdx,
    endIdx: trailingEnd,
    meta,
    lines: lines.slice(startIdx, trailingEnd),
  };
}

/**
 * Legacy scanner for blocks written before checkpoint markers existed.
 *
 * Terminates on a horizontal rule or the next level-2 heading. Note the
 * `(?!#)` — `###` is a *subsection* of `## Continue`, not a terminator. The
 * original scanner stopped at any run of `#`, which meant a `### Restored
 * state` subsection fell outside the section entirely and could not be seen,
 * let alone carried forward.
 */
function heuristicEnd(lines: string[], startIdx: number): number {
  for (let i = startIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (
      trimmed === "---" ||
      (/^##(?!#)/.test(trimmed) && trimmed !== CONTINUE_HEADING)
    ) {
      return i;
    }
  }
  return lines.length;
}

/** Remove the ## Continue section, returning the remainder of the document. */
export function stripContinue(content: string): string {
  const found = locateContinue(content);
  if (!found) return content;

  const lines = content.split("\n");
  const before = lines.slice(0, found.startIdx);
  const after = lines.slice(found.endIdx);
  while (after.length > 0 && after[0].trim() === "") after.shift();

  return [...before, ...after].join("\n");
}

// ---------------------------------------------------------------------------
// Block construction
// ---------------------------------------------------------------------------

export interface BuildOptions {
  authored: Authorship;
  /** Human-readable session line, or "Unknown session". */
  sessionLine: string;
  /** Claude Code session UUID — the `claude --resume` handle. */
  sessionId?: string;
  cwd: string;
  /** Model-authored markdown. Omitted for auto blocks. */
  body?: string;
  /** Overridable for deterministic tests. */
  timestamp?: string;
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, "'");
}

export function buildContinueBlock(opts: BuildOptions): string {
  const ts = opts.timestamp ?? new Date().toISOString();

  const attrs = [
    `authored="${opts.authored}"`,
    `session="${escapeAttr(opts.sessionLine)}"`,
    opts.sessionId ? `session-id="${escapeAttr(opts.sessionId)}"` : null,
    `ts="${ts}"`,
  ]
    .filter(Boolean)
    .join(" ");

  const header = [
    `> **Last session:** ${opts.sessionLine}`,
    `> **Paused at:** ${ts}`,
    ">",
    `> Working directory: ${opts.cwd}`,
  ];

  if (opts.sessionId) {
    header.push(">", `> Resume with: \`claude --resume ${opts.sessionId}\``);
  }

  const body = (opts.body ?? "").trim();

  const parts = [
    CONTINUE_HEADING,
    "",
    `${MARKER_OPEN} ${attrs} -->`,
    "",
    ...header,
  ];

  if (body) {
    parts.push("", body);
  } else {
    parts.push(
      ">",
      "> _No checkpoint body was recorded — see the latest session note._"
    );
  }

  parts.push("", MARKER_CLOSE, "", "---", "");

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export interface ApplyOptions extends BuildOptions {
  /** Project root; TODO.md is resolved beneath it. */
  rootPath: string;
  /** Preview only — nothing is written. */
  dryRun?: boolean;
}

export interface ApplyResult {
  action: ApplyAction;
  path: string | null;
  block: string;
  /** Set when action === "preserved". */
  preservedMeta?: CheckpointMeta;
  /** Set when unattributed content was carried forward into the new block. */
  carriedForward?: boolean;
  error?: string;
}

/**
 * Write the ## Continue block, honouring the preservation rules.
 *
 * An AUTO write is unattended — it fires from the session-stop and pre-compact
 * hooks — so it operates under one governing rule: **never destroy content it
 * did not author.** Three cases follow from that:
 *
 *   1. An authored checkpoint for the SAME session is left untouched. The hooks
 *      fire after the model has already recorded the real state; overwriting it
 *      with metadata is the bug this module exists to fix.
 *   2. An authored checkpoint from an EARLIER session is stale — TODO.md would
 *      otherwise keep pointing at the wrong session — so it is replaced. Its
 *      content is not lost: `pai pause` mirrors every authored body into the
 *      session note.
 *   3. An UNMARKED block predates the marker, so authorship cannot be read off
 *      it. If it is nothing but generated header lines it is replaced. If it
 *      carries anything else, that content was put there deliberately — quite
 *      possibly as a hand-rolled workaround for the very clobbering this fixes —
 *      and is carried forward into the new block rather than dropped.
 *
 * A MODEL write always replaces: the model is authoring the checkpoint, and a
 * newer one supersedes an older one.
 */
export function applyContinue(opts: ApplyOptions): ApplyResult {
  const target = resolveTodoTarget(opts.rootPath, { create: !opts.dryRun });
  if (!target) {
    return {
      action: "failed",
      path: null,
      block: buildContinueBlock(opts),
      error: "Could not resolve or create a TODO.md target",
    };
  }

  const existing = locateContinue(target.content);
  let carriedForward = false;
  let effectiveBody = opts.body;

  if (opts.authored === "auto" && existing) {
    // Case 1 — authored, same session: hands off.
    if (
      existing.meta?.authored === "model" &&
      existing.meta.session === opts.sessionLine
    ) {
      return {
        action: "preserved",
        path: target.path,
        block: buildContinueBlock(opts),
        preservedMeta: existing.meta,
      };
    }

    // Case 3 — unmarked block holding content nobody can attribute to us.
    if (!existing.meta && !isBoilerplateOnly(existing.lines)) {
      const salvaged = extractSectionContent(existing.lines);
      if (salvaged) {
        effectiveBody = [
          "_Carried forward from the previous checkpoint (author unknown — this",
          "block predates checkpoint authorship markers):_",
          "",
          salvaged,
        ].join("\n");
        carriedForward = true;
      }
    }
  }

  const block = buildContinueBlock({ ...opts, body: effectiveBody });

  if (opts.dryRun) {
    return { action: "written", path: target.path, block, carriedForward };
  }

  const newContent = block + stripContinue(target.content).trimStart();
  const tmpPath = `${target.path}.continue.tmp`;

  try {
    writeFileSync(tmpPath, newContent, "utf8");
    renameSync(tmpPath, target.path);
  } catch (err) {
    try {
      if (existsSync(tmpPath)) renameSync(tmpPath, `${tmpPath}.dead`);
    } catch {
      /* ignore */
    }
    return {
      action: "failed",
      path: target.path,
      block,
      error: String(err),
    };
  }

  return { action: "written", path: target.path, block, carriedForward };
}

// ---------------------------------------------------------------------------
// Session-note discovery
//
// Lifted verbatim from end.ts so pause, end and any future caller share one
// implementation. end.ts now imports these rather than carrying its own copy.
// ---------------------------------------------------------------------------

/** PAI_DIR — mirrors pai-paths.ts resolution. */
function getPaiDir(): string {
  const envDir = process.env.PAI_DIR;
  if (envDir) {
    try {
      return realpathSync(envDir);
    } catch {
      return envDir;
    }
  }
  return join(homedir(), ".claude");
}

/**
 * Find the notes directory for a project — local first, then the central
 * ~/.claude/projects/<encoded>/Notes fallback. Never creates.
 */
export function findNotesDir(
  rootPath: string,
  encodedDir: string
): string | null {
  for (const rel of ["Notes", "notes", ".claude/Notes"]) {
    const p = join(rootPath, rel);
    if (existsSync(p)) return p;
  }
  const central = join(getPaiDir(), "projects", encodedDir, "Notes");
  if (existsSync(central)) return central;
  return null;
}

/**
 * Find the current (highest-numbered) session note: current month, then the
 * previous month, then a flat notesDir as legacy fallback.
 */
export function findLatestNote(notesDir: string): string | null {
  const findIn = (dir: string): string | null => {
    if (!existsSync(dir)) return null;
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      return null;
    }
    const notes = files
      .filter((f) => /^\d{3,4}[\s_-].*\.md$/.test(f))
      .sort((a, b) => {
        const na = parseInt(a.match(/^(\d+)/)?.[1] ?? "0", 10);
        const nb = parseInt(b.match(/^(\d+)/)?.[1] ?? "0", 10);
        return na - nb;
      });
    return notes.length > 0 ? join(dir, notes[notes.length - 1]) : null;
  };

  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");

  const current = findIn(join(notesDir, year, month));
  if (current) return current;

  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const py = String(prev.getFullYear());
  const pm = String(prev.getMonth() + 1).padStart(2, "0");
  const prevFound = findIn(join(notesDir, py, pm));
  if (prevFound) return prevFound;

  return findIn(notesDir);
}

// ---------------------------------------------------------------------------
// Session-note append
// ---------------------------------------------------------------------------

/**
 * Append the checkpoint body to a session note.
 *
 * TODO.md's ## Continue is a single slot that every later checkpoint
 * overwrites. The session note is the durable record, so the body goes to both.
 * Idempotent per timestamp: re-running with the same stamp will not duplicate.
 */
export function appendCheckpointToNote(
  notePath: string,
  body: string,
  timestamp?: string
): { appended: boolean; error?: string } {
  const ts = timestamp ?? new Date().toISOString();
  const heading = `## Pause Checkpoint — ${ts}`;

  let existing: string;
  try {
    existing = readFileSync(notePath, "utf8");
  } catch (err) {
    return { appended: false, error: String(err) };
  }

  if (existing.includes(heading)) return { appended: false };

  const block = `\n\n---\n\n${heading}\n\n${body.trim()}\n`;
  const tmpPath = `${notePath}.checkpoint.tmp`;

  try {
    writeFileSync(tmpPath, existing.trimEnd() + block, "utf8");
    renameSync(tmpPath, notePath);
  } catch (err) {
    try {
      if (existsSync(tmpPath)) renameSync(tmpPath, `${tmpPath}.dead`);
    } catch {
      /* ignore */
    }
    return { appended: false, error: String(err) };
  }

  return { appended: true };
}

// ---------------------------------------------------------------------------
// Body loading
// ---------------------------------------------------------------------------

/** Read a checkpoint body from a file, or from stdin when path is "-". */
export function readBodyFile(path: string): string {
  if (path === "-") {
    return readFileSync(0, "utf8");
  }
  return readFileSync(path, "utf8");
}
