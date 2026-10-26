/**
 * inbox.ts — the per-session operator inbox, shared by the hooks.
 *
 * The operator writes into the session's answers file (Notes/ANSWERS.md of the
 * project when it exists) and into the global ~/.pai/inbox.md for anything not
 * tied to a project. Nothing re-reads those files, so a message written while
 * the session is busy went unseen (observed 2026-10-26: a frozen machine, the
 * operator's note in ANSWERS.md, nobody looking).
 *
 * The hooks (user-prompt/inbox-inject.ts, post-tool-use/inbox-inject.ts) call
 * checkInbox() after every prompt and after every tool call. Each call is one
 * stat per inbox file; only when the mtime moved does it read the file and
 * diff against the last seen content, and only NEW operator text is injected.
 *
 * The session's own writes must never be echoed back to it: the session writes
 * these files through Write/Edit, and markOwnWrite() records the file's hash
 * as seen right after such a call (post-tool-use/inbox-inject.ts does that).
 * A hash match is treated as seen even when the mtime moved — an Edit can land
 * in the same mtime tick as the operator's append, and the hash is what
 * actually distinguishes the two writes.
 *
 * State: one JSON file per session under PAI_HOME/state/inbox-<session>.json.
 * Every function here is best effort: an error means "inject nothing", never
 * a failed tool call.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { paiHomePath } from "../../../config/pai-home.js";
import { findNotesDir } from "./project-utils.js";

/** Answers file name inside a project's Notes dir. */
export const ANSWERS_FILE = "ANSWERS.md";

/** A line of the answers file: `- [ ] A-001 · …` (or `[x]`). */
const ANSWER_LINE = /^-\s*\[( |x|X)\]\s*(A-\d+)/;

/** An operator decision appended to an A-line or written as free text. */
const OPERATOR_PREFIX = "Operator:";

export interface InboxChange {
  file: string;
  lines: string[];
}

interface SeenFileState {
  mtimeMs: number;
  hash: string;
  lines: string[];
}

interface SessionState {
  files: Record<string, SeenFileState>;
}

function safeSession(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_-]/g, "") || "nosession";
}

function stateFile(sessionId: string): string {
  return paiHomePath("state", `inbox-${safeSession(sessionId)}.json`);
}

function loadState(sessionId: string): SessionState {
  try {
    const j = JSON.parse(readFileSync(stateFile(sessionId), "utf8")) as SessionState;
    if (j && typeof j === "object" && j.files && typeof j.files === "object") return j;
  } catch {
    /* first call or damaged state: fresh */
  }
  return { files: {} };
}

function saveState(sessionId: string, state: SessionState): void {
  try {
    const f = stateFile(sessionId);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify(state), "utf8");
  } catch {
    /* best effort — worst case the next call re-diffs and re-injects */
  }
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * The inbox files for this session: the project's answers file (only when it
 * exists) plus the global one. The global file resolves under PAI_HOME like
 * every other PAI file — on a default machine that is ~/.pai/inbox.md.
 */
export function inboxFiles(cwd: string): string[] {
  const out: string[] = [];
  try {
    const notes = findNotesDir(cwd);
    if (notes.isLocal) {
      const answers = join(notes.path, ANSWERS_FILE);
      if (existsSync(answers)) out.push(answers);
    }
  } catch { /* no project notes — global only */ }
  out.push(paiHomePath("inbox.md"));
  return out;
}

/** True when this line is one of the session's own A-NNN lines (the line the
 *  session maintains; an untouched or re-ticked A-line is not new text). */
function isOwnLine(line: string): boolean {
  return ANSWER_LINE.test(line);
}

/** The operator suffix of an A-line, or "" when there is none. */
function operatorSuffix(line: string): string {
  const i = line.indexOf(OPERATOR_PREFIX);
  return i < 0 ? "" : line.slice(i);
}

/**
 * What the operator wrote since `seen` was recorded:
 * - new/changed `Operator:` suffixes on A-lines (kept with their A-NNN id);
 * - an A-line that changed to `[x]` (a tick the session did not see);
 * - any new line that is not one of the session's own A-NNN lines (free text,
 *   including a bare `Operator:` line).
 */
function newOperatorText(seenLines: string[], currentLines: string[]): string[] {
  const seenBy = new Map<string, string>();
  for (const l of seenLines) {
    const m = ANSWER_LINE.exec(l);
    if (m) seenBy.set(m[2], l);
  }
  const out: string[] = [];
  const seenOwn = new Set(seenLines.filter(isOwnLine));
  for (const l of currentLines) {
    const m = ANSWER_LINE.exec(l);
    if (m) {
      const prev = seenBy.get(m[2]);
      if (prev === undefined) {
        // an A-line the session has never seen — only its operator part is
        // the operator's text; the line itself is the session's format
        const suffix = operatorSuffix(l);
        if (suffix) out.push(`${m[2]} ${suffix}`);
        continue;
      }
      const suffix = operatorSuffix(l);
      if (suffix && suffix !== operatorSuffix(prev)) out.push(`${m[2]} ${suffix}`);
      if (m[1] === "x" && !/^\s*\[[xX]\]/.test(prev)) out.push(`${m[2]} [x] ticked by operator`);
      continue;
    }
    if (l.trim() === "") continue;
    if (seenOwn.has(l)) continue;
    out.push(l);
  }
  return out;
}

/**
 * One stat per inbox file; read and diff only on change. Returns the changes
 * since the session's last seen state, and records the current content as seen
 * for the changed files (so a change is injected exactly once).
 */
export function checkInbox(sessionId: string, cwd: string): InboxChange[] {
  const state = loadState(sessionId);
  const changes: InboxChange[] = [];
  for (const path of inboxFiles(cwd)) {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue; // missing file: nothing to see
    }
    const seen = state.files[path];
    if (seen && seen.mtimeMs === stat.mtimeMs) continue; // cheap path: one stat, no read
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const h = hash(content);
    if (seen && seen.hash === h) {
      // content identical — an mtime touch with no new text, or the session's
      // own write raced the mark; remember the touch, inject nothing
      state.files[path] = { mtimeMs: stat.mtimeMs, hash: h, lines: seen.lines };
      continue;
    }
    const lines = content.split("\n");
    // First sight of a file is the baseline, not news: the session knows its
    // own answers file, and pre-session operator context is not injected as a
    // surprise. Every change after the baseline is diffed and injected.
    const newLines = seen ? newOperatorText(seen.lines, lines) : [];
    state.files[path] = { mtimeMs: stat.mtimeMs, hash: h, lines };
    if (newLines.length) changes.push({ file: path, lines: newLines });
  }
  // the seen-state is updated whether or not anything was injected: a change
  // with no operator text (the session's own write, a touch) must not be
  // re-diffed on the next call
  saveState(sessionId, state);
  return changes;
}

/**
 * Record that the session itself wrote this file (PostToolUse on Write/Edit of
 * an inbox path): its content becomes "seen", so none of it is ever injected
 * back. A later operator append changes the hash again and is injected then.
 */
export function markOwnWrite(sessionId: string, path: string): void {
  try {
    const stat = statSync(path);
    const content = readFileSync(path, "utf8");
    const state = loadState(sessionId);
    state.files[path] = { mtimeMs: stat.mtimeMs, hash: hash(content), lines: content.split("\n") };
    saveState(sessionId, state);
  } catch {
    /* best effort */
  }
}

/** True when `path` is one of this session's inbox files. */
export function isInboxPath(cwd: string, path: string): boolean {
  try {
    return inboxFiles(cwd).includes(path);
  } catch {
    return false;
  }
}

/** The context block the hooks inject; "" when there is nothing new. */
export function inboxContext(changes: InboxChange[]): string {
  if (!changes.length) return "";
  const parts = changes.map((c) => `[Inbox] operator wrote in ${c.file}:\n${c.lines.join("\n")}`);
  return parts.join("\n");
}

/**
 * The hook's stdout line: additionalContext under the given event name.
 * "" when there is nothing to inject.
 */
export function inboxHookOutput(event: "UserPromptSubmit" | "PostToolUse", context: string): string {
  if (!context) return "";
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } }) + "\n";
}
