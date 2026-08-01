/**
 * Rolling auto-checkpoint — the floor under every session.
 *
 * WHY THIS EXISTS
 * ---------------
 * A model-authored checkpoint is the best handover there is: it knows what is
 * unfinished, what is load-bearing, and what to do next. It has one fatal
 * property — it only exists if the model was asked to write one.
 *
 * The model is not invoked on `/exit`, and certainly not on Ctrl+C. No hook can
 * make it write prose at exit time. So a good checkpoint at exit can only exist
 * if something wrote it *before* exit. Exit-time is the wrong moment by
 * construction, and building the guarantee there is why sessions kept ending
 * with nothing to hand over.
 *
 * This module builds a mechanical digest instead — recent prompts, the state of
 * the working tree — cheap enough to run on a timer during the session. It is
 * strictly worse than what the model would write, and that is the point: it is
 * the floor, not the ceiling. `applyContinue` writes it in "auto" mode, so it
 * can never overwrite a model-authored checkpoint for the same session.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { encodeDir } from "../cli/utils.js";

/** How many recent user prompts to carry. */
const MAX_PROMPTS = 6;
/** Longest a single quoted prompt may be before it is elided. */
const MAX_PROMPT_CHARS = 220;
/** Cap on listed working-tree entries, so a big refactor cannot flood TODO.md. */
const MAX_FILES = 20;

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

/**
 * Text of a JSONL message, or null when the entry carries none.
 * Mirrors the shape handled by slug-generator: content is either a plain
 * string (user turns) or an array of typed blocks (assistant turns).
 */
function messageText(obj: Record<string, unknown>): string | null {
  const msg = obj.message as Record<string, unknown> | undefined;
  if (!msg) return null;

  const content = msg.content;
  if (typeof content === "string") return content || null;

  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
    }
    return texts.join(" ") || null;
  }

  return null;
}

/**
 * Strip injected machinery from a user turn, leaving what the user typed.
 *
 * Hooks do not get their own turn — `UserPromptSubmit` output is folded into
 * the same user message as the prompt itself. So this cannot be a predicate
 * that accepts or rejects whole messages: doing that discarded every prompt in
 * a session where a reminder happened to sort first, which is every session
 * here. The markup has to be cut out and the remainder kept.
 */
function stripInjected(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<local-command-[a-z]*>[\s\S]*?<\/local-command-[a-z]*>/g, "")
    .replace(/<command-(name|message|args)>[\s\S]*?<\/command-\1>/g, "")
    .replace(/<persisted-output>[\s\S]*?<\/persisted-output>/g, "")
    .trim();
}

/**
 * True for a turn that is entirely machinery — no user intent to recover.
 */
function isMachinery(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith("Caveat:") ||
    t.startsWith("[Request interrupted") ||
    t.startsWith("This session is being continued from a previous")
  );
}

/**
 * Every transcript file belonging to a session, oldest part first.
 *
 * A session's transcript is not one file. `load-project-context` archives all
 * but the newest `.jsonl` into `sessions/`, after which Claude Code opens a
 * fresh file under the same UUID — so the same session routinely has a large
 * archived half and a small live one. Reading only the newest file yields just
 * the current turn, which is how the first cut of this digest reported a
 * six-turn session as a single prompt.
 *
 * With no session id, falls back to the newest file in the project directory.
 */
/**
 * Locate the Claude Code transcript directory for a project.
 *
 * The registry records an `encoded_dir`, but it records whatever was true when
 * the project was added and is not updated when the project moves. Audited on
 * 2026-08-01: of 114 active projects only 19 had an `encoded_dir` containing
 * any transcript at all — 20 named a directory that no longer exists and 75
 * named one holding no `.jsonl` files. AIBroker's still pointed at a path last
 * used in March, which silently disabled checkpoint capture for that project:
 * every lookup returned no transcript, so every digest came out empty and every
 * handover degraded to "see the latest session note".
 *
 * So the stored value is treated as a hint, not an answer. If it yields no
 * transcripts, the directory is re-derived from the project's current root
 * path — which is maintained — and that is used instead. This self-heals a
 * moved project on the next capture without a migration.
 */
export function resolveTranscriptDir(project: {
  encoded_dir?: string | null;
  root_path: string;
}): string {
  const base = join(homedir(), ".claude", "projects");

  const recorded = project.encoded_dir ? join(base, project.encoded_dir) : null;
  if (recorded && hasTranscripts(recorded)) return recorded;

  const derived = join(base, encodeDir(project.root_path));
  if (hasTranscripts(derived)) return derived;

  // Neither has anything. Return the recorded one so behaviour and any error
  // message still reference what the registry actually claims.
  return recorded ?? derived;
}

function hasTranscripts(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    if (readdirSync(dir).some((e) => e.endsWith(".jsonl"))) return true;
    const archived = join(dir, "sessions");
    return existsSync(archived) && readdirSync(archived).some((e) => e.endsWith(".jsonl"));
  } catch {
    return false;
  }
}

export function findTranscripts(
  projectDir: string,
  sessionId?: string
): string[] {
  if (!existsSync(projectDir)) return [];

  if (sessionId) {
    const archived = join(projectDir, "sessions", `${sessionId}.jsonl`);
    const live = join(projectDir, `${sessionId}.jsonl`);
    const parts = [archived, live].filter((p) => existsSync(p));
    if (parts.length > 0) return parts;
  }

  let newest: { path: string; mtime: number } | null = null;
  let entries: string[];
  try {
    entries = readdirSync(projectDir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const full = join(projectDir, entry);
    try {
      const { mtimeMs } = statSync(full);
      if (!newest || mtimeMs > newest.mtime) newest = { path: full, mtime: mtimeMs };
    } catch {
      // Unreadable — skip.
    }
  }

  return newest ? [newest.path] : [];
}

/**
 * The last few things the user actually asked for, oldest first.
 *
 * Claude Code writes a dedicated `last-prompt` entry per turn, holding the
 * prompt already separated from the hook output that shares its user message.
 * That is used when present; parsing user messages is the fallback for
 * transcripts written before those entries existed.
 */
export function recentPrompts(
  transcriptPaths: string[],
  limit = MAX_PROMPTS
): string[] {
  const fromEntries: string[] = [];
  const fromMessages: string[] = [];

  const take = (text: string, into: string[]): void => {
    const cleaned = stripInjected(text);
    if (!cleaned || isMachinery(cleaned)) return;
    into.push(
      cleaned.length > MAX_PROMPT_CHARS
        ? cleaned.slice(0, MAX_PROMPT_CHARS).trimEnd() + " …"
        : cleaned
    );
  };

  for (const path of transcriptPaths) {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }

    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (obj.type === "last-prompt") {
        if (typeof obj.lastPrompt === "string") take(obj.lastPrompt, fromEntries);
        continue;
      }

      if (obj.type === "user") {
        const text = messageText(obj);
        if (text) take(text, fromMessages);
      }
    }
  }

  const source = fromEntries.length > 0 ? fromEntries : fromMessages;

  // Consecutive duplicates are common: a prompt is recorded both when it is
  // submitted and again when the turn it belongs to is finalised.
  const deduped = source.filter((p, i) => i === 0 || p !== source[i - 1]);
  return deduped.slice(-limit);
}

// ---------------------------------------------------------------------------
// Working tree
// ---------------------------------------------------------------------------

export interface WorkingTree {
  branch: string | null;
  head: string | null;
  /** Porcelain entries, capped. */
  changes: string[];
  /** How many entries were dropped by the cap. */
  overflow: number;
}

export function readWorkingTree(cwd: string): WorkingTree | null {
  const git = (args: string[]): string | null => {
    try {
      return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  };

  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === null) return null; // Not a git repo — nothing to report.

  const status = git(["status", "--porcelain"]) ?? "";
  const all = status.split("\n").filter((l) => l.trim().length > 0);

  return {
    branch,
    head: git(["log", "-1", "--pretty=%h %s"]),
    changes: all.slice(0, MAX_FILES),
    overflow: Math.max(0, all.length - MAX_FILES),
  };
}

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

export interface DigestInput {
  cwd: string;
  /** Every transcript file for this session, oldest part first. */
  transcriptPaths?: string[];
  timestamp?: string;
}

/**
 * Build the auto-checkpoint body, or "" when there is nothing worth recording.
 *
 * REQUIRING A PROMPT IS THE POINT
 * -------------------------------
 * A checkpoint that replaces an earlier one had better be worth more than what
 * it displaced. Until the user has said something, this session has produced no
 * state — and an uncommitted working tree is not this session's doing; it was
 * most likely already there when the session opened.
 *
 * Without this guard, opening a session in a dirty repo and touching one tool
 * is enough to overwrite the previous session's rich handover with "clean tree,
 * nothing asked". The handover survives in the session note either way, but
 * `## Continue` is what the next session is shown, so what sits there matters.
 */
export function buildAutosaveBody(input: DigestInput): string {
  const ts = input.timestamp ?? new Date().toISOString();
  const prompts = recentPrompts(input.transcriptPaths ?? []);
  if (prompts.length === 0) return "";

  const tree = readWorkingTree(input.cwd);
  const dirty = tree?.changes.length ?? 0;

  const out: string[] = [
    `_Automatic checkpoint — ${ts}. Written without the model, from the` +
      ` transcript and the working tree. A model-authored checkpoint replaces` +
      ` this; it is here so an interrupted session still leaves something._`,
  ];

  if (prompts.length > 0) {
    out.push("", "### What was being asked", "");
    for (const p of prompts) {
      // Quote as a list item, flattening newlines so the list stays a list.
      out.push(`- ${p.replace(/\s*\n\s*/g, " ")}`);
    }
  }

  if (tree) {
    out.push("", "### Working tree", "");
    out.push(`- Branch: \`${tree.branch}\``);
    if (tree.head) out.push(`- HEAD: ${tree.head}`);
    if (dirty === 0) {
      out.push("- Clean — nothing uncommitted.");
    } else {
      out.push(`- ${dirty} uncommitted path(s)${tree.overflow > 0 ? ` (+${tree.overflow} more)` : ""}:`);
      out.push("");
      out.push("```");
      out.push(...tree.changes);
      out.push("```");
    }
  }

  return out.join("\n");
}
