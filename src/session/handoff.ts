/**
 * handoff.ts — a portable, bounded, redacted handoff brief for one session.
 *
 * `pai handoff export` scrapes a Claude Code transcript into a short Markdown
 * brief a successor session can continue from: what was asked, what changed,
 * what ran, and where it stopped. Unlike the model-written context handover
 * this is mechanical — no model call, no prose to hallucinate — and it is
 * redacted (secrets replaced by [REDACTED]) before it is bounded, so a brief
 * can be pasted, mailed or committed without leaking a token.
 *
 * The brief is assembled as sections, masked, then cut to `maxBytes` from the
 * oldest end (Recent commands first, then Last steps) with a marker line, so
 * the parts a successor needs most (Session, requests, files) survive first.
 */

import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { maskSecrets } from "../hooks/ts/lib/loop-guard.js";
import { contentToText } from "../hooks/ts/lib/transcript-text.js";
import { claudeProjectsDir, paiHomePath } from "../config/pai-home.js";
import { encodeDir } from "../cli/lib/utils.js";

/** Default brief size: comfortably under what a successor can read in one turn. */
export const HANDOFF_MAX_BYTES = 49152;
/** Most distinct files listed under "Files changed". */
const MAX_FILES = 50;
/** Most Bash commands listed under "Recent commands". */
const MAX_COMMANDS = 20;
/** Most assistant text messages listed under "Last steps". */
const MAX_STEPS = 10;
/** Each "Last steps" entry is truncated to this many characters. */
const STEP_CHARS = 400;
/** Tools whose input carries a changed file. */
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

interface ContentPart {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  tool_use_id?: string;
  is_error?: boolean;
  input?: Record<string, unknown>;
  content?: unknown;
}

interface TranscriptEntry {
  type?: string;
  cwd?: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
}

/** The last assistant text message of a transcript, or null when there is none. */
function lastAssistantText(entries: TranscriptEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "assistant" || !Array.isArray(entry.message?.content)) continue;
    const text = (entry.message!.content as ContentPart[])
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text!)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return null;
}

/** First user text message that looks like something typed, not an injected block. */
function firstUserText(entries: TranscriptEntry[]): string | null {
  for (const entry of entries) {
    if (entry.type !== "user") continue;
    const content = entry.message?.content;
    const text = typeof content === "string" ? content : contentToText(content);
    if (text.trim()) return text.trim();
  }
  return null;
}

/** Last user text message — the request the session was working on. */
function lastUserText(entries: TranscriptEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "user") continue;
    const content = entry.message?.content;
    const text = typeof content === "string" ? content : contentToText(content);
    if (text.trim()) return text.trim();
  }
  return null;
}

/**
 * Exit code of a Bash tool_result, when the transcript records one.
 * Claude Code serialises Bash results as plain text; an interrupted command
 * reads "Exit code N", and a JSON payload carries `interrupted`/`success`.
 */
function bashExitCode(result: ContentPart): number | null {
  if (result.is_error === true) return null;
  const text = contentToText(result.content);
  const m = text.match(/Exit code (\d+)/);
  if (m) return Number(m[1]);
  try {
    const parsed = JSON.parse(text) as { interrupted?: boolean; success?: boolean };
    if (parsed.interrupted === true) return null;
    if (parsed.success === false) return null;
  } catch {
    // plain text without an exit-code line
  }
  return 0;
}

/**
 * Build the handoff brief for one transcript: Markdown, secrets masked,
 * cut to `maxBytes` whole sections from the oldest end with a marker line.
 *
 * @param transcriptPath  a Claude Code session transcript (.jsonl)
 */
export function buildHandoffBrief(transcriptPath: string, opts: { maxBytes?: number } = {}): string {
  const maxBytes = opts.maxBytes ?? HANDOFF_MAX_BYTES;
  const raw = readFileSync(transcriptPath, "utf8");
  const entries: TranscriptEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as TranscriptEntry);
    } catch {
      // a half-written line is skipped, not fatal
    }
  }

  const sessionId = basename(transcriptPath).replace(/\.jsonl$/, "") || "unknown";
  const cwd = entries.find((e) => e.cwd)?.cwd ?? "";
  const first = entries.find((e) => e.timestamp)?.timestamp ?? "";
  const last = [...entries].reverse().find((e) => e.timestamp)?.timestamp ?? "";

  const files: string[] = [];
  const seen = new Set<string>();
  const commands: string[] = [];
  const steps: string[] = [];

  // Results first: a tool_result can be folded before its tool_use is seen.
  const results = new Map<string, ContentPart>();
  for (const entry of entries) {
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content as ContentPart[]) {
      if (part?.type === "tool_result" && typeof part.tool_use_id === "string") {
        results.set(part.tool_use_id, part);
      }
    }
  }

  for (const entry of entries) {
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content as ContentPart[]) {
      if (part?.type === "tool_use" && part.name && FILE_TOOLS.has(part.name)) {
        const path = part.input?.file_path;
        if (typeof path === "string" && !seen.has(path)) {
          seen.add(path);
          files.push(path);
        }
      } else if (part?.type === "tool_use" && part.name === "Bash") {
        const command = typeof part.input?.command === "string" ? part.input.command : "";
        if (command) {
          const code = part.id ? results.get(part.id) : undefined;
          const exit = code ? bashExitCode(code) : null;
          commands.push(exit === null ? command : `${command}  [exit ${exit}]`);
        }
      } else if (part?.type === "text" && typeof part.text === "string" && entry.type === "assistant") {
        const text = part.text.trim();
        if (text) steps.push(text.length > STEP_CHARS ? `${text.slice(0, STEP_CHARS)}…` : text);
      }
    }
  }

  const sections: Record<string, string> = {
    Session: [
      `- id: ${sessionId}`,
      `- cwd: ${cwd}`,
      `- start: ${first}`,
      `- end: ${last}`,
    ].join("\n"),
    "First request": firstUserText(entries) ?? "(none)",
    "Latest request": lastUserText(entries) ?? "(none)",
    "Files changed": files.slice(0, MAX_FILES).map((f) => `- ${f}`).join("\n") || "(none)",
    "Recent commands": commands.slice(-MAX_COMMANDS).map((c) => `- ${c}`).join("\n") || "(none)",
    "Last steps": steps.slice(-MAX_STEPS).map((s) => `- ${s}`).join("\n") || "(none)",
    "Where it stopped": lastAssistantText(entries) ?? "(no assistant message)",
  };

  const masked = maskSecrets(
    Object.entries(sections)
      .map(([title, body]) => `## ${title}\n${body}`)
      .join("\n\n")
  );

  if (Buffer.byteLength(masked, "utf8") <= maxBytes) return masked;
  const note = `\n\n[truncated to ${maxBytes} bytes]`;
  const budget = maxBytes - Buffer.byteLength(note, "utf8");

  const render = (parts: Record<string, string>): string =>
    Object.entries(parts)
      .map(([title, body]) => `## ${title}\n${body}`)
      .join("\n\n");

  // Cut whole sections from the oldest end: commands first, then steps.
  const order = ["Recent commands", "Last steps"];
  const kept = { ...sections };
  for (const name of order) {
    delete kept[name];
    const text = render(kept);
    if (Buffer.byteLength(text, "utf8") <= budget) return text + note;
  }
  // Still too big: shorten "Where it stopped" to its first line, keeping its
  // heading — the successor needs to know the brief was cut, not just that
  // the session ended.
  const stopped = kept["Where it stopped"] ?? "";
  kept["Where it stopped"] = stopped.split("\n")[0].slice(0, 200);
  const text = render(kept);
  if (Buffer.byteLength(text, "utf8") <= budget) return text + note;
  // Still too big: keep the head of what remains, so the brief is never empty.
  const head = Buffer.from(text, "utf8").subarray(0, Math.max(0, budget)).toString("utf8");
  return head + note;
}

/** `yyyymmdd-hhmm` in local time, for the handoff file name. */
function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** The handoffs directory under PAI_HOME. */
export function handoffsDir(): string {
  return paiHomePath("handoffs");
}

/**
 * Write a handoff brief into <PAI_HOME>/handoffs/<sessionId>-<yyyymmdd-hhmm>.md
 * (dir 0700, file 0600) and return its path.
 */
export function writeHandoff(brief: string, sessionId: string): string {
  const dir = handoffsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${sessionId}-${stamp()}.md`);
  writeFileSync(path, brief, { mode: 0o600 });
  return path;
}

/** Append one handoff link to <PAI_HOME>/handoffs/links.jsonl. Silent on failure. */
export function appendHandoffLink(from: string, to: string, now = new Date()): void {
  try {
    const dir = handoffsDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(join(dir, "links.jsonl"), `${JSON.stringify({ ts: now.toISOString(), from, to })}\n`);
  } catch {
    // never blocks a prompt
  }
}

/** Newest transcript of a cwd, newest first; null when the project has none. */
export function sessionTranscripts(cwd: string): string[] {
  const dir = join(claudeProjectsDir(), encodeDir(cwd));
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files = names
    .filter((n) => n.endsWith(".jsonl"))
    .map((n) => join(dir, n));
  return files
    .map((path) => ({ path, mtime: safeMtime(path) }))
    .filter((f): f is { path: string; mtime: number } => f.mtime !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .map((f) => f.path);
}

function safeMtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** Resolve a session id (or transcript path) in a cwd to its transcript path. */
export function resolveTranscript(session: string | undefined, cwd: string): string | null {
  if (session && session.endsWith(".jsonl")) return session;
  const dir = join(claudeProjectsDir(), encodeDir(cwd));
  if (session) {
    const direct = join(dir, `${session}.jsonl`);
    try {
      statSync(direct);
      return direct;
    } catch {
      // also look under sessions/ (archived copies)
      const archived = join(dir, "sessions", `${session}.jsonl`);
      try {
        statSync(archived);
        return archived;
      } catch {
        return null;
      }
    }
  }
  return sessionTranscripts(cwd)[0] ?? null;
}

/** The session id a transcript path carries (its file name). */
export function sessionIdOf(transcriptPath: string): string {
  return basename(transcriptPath).replace(/\.jsonl$/, "");
}

/** Directory of a transcript's project (for tests and callers). */
export function transcriptProjectDir(transcriptPath: string): string {
  return dirname(transcriptPath);
}
