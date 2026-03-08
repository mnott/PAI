/**
 * Slug generator for PAI session notes.
 *
 * Extracts a 1-3 word descriptive slug from Claude Code JSONL transcripts
 * using keyword frequency analysis — no LLM required.
 *
 * JSONL format (one JSON object per line):
 *   - type "user":      { type: "user",      message: { role: "user",      content: string | [{ type, text }] } }
 *   - type "assistant": { type: "assistant", message: { role: "assistant", content: [{ type, text }] } }
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { STOP_WORDS } from "../utils/stop-words.js";

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

export interface SlugOptions {
  /** Maximum number of words in the generated slug (default: 3) */
  maxWords?: number;
  /** Maximum character length of the generated slug (default: 30) */
  maxLength?: number;
}

// STOP_WORDS imported from utils/stop-words.ts

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract plain text from a parsed JSONL message object.
 */
function extractText(obj: Record<string, unknown>): string | null {
  const msg = obj.message as Record<string, unknown> | undefined;
  if (!msg) return null;

  const content = msg.content;

  // Array of content blocks (modern assistant messages)
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        texts.push(b.text);
      }
    }
    return texts.join(" ") || null;
  }

  // Plain string content (user messages)
  if (typeof content === "string") {
    return content || null;
  }

  return null;
}

/**
 * Tokenize a string into lowercase words, filtering stop words and short tokens.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((w) => {
      if (w.length < 3) return false;
      if (/^\d+$/.test(w)) return false;
      if (STOP_WORDS.has(w)) return false;
      return true;
    });
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/**
 * Find the latest JSONL transcript for a project's Claude encoded directory.
 *
 * @param encodedDir  Claude-encoded project directory name,
 *                    e.g. "-Users-alice-dev-ai-PAI"
 * @returns  Absolute path to the most recently modified .jsonl file, or null.
 */
export function findLatestTranscript(encodedDir: string): string | null {
  const sessionsDir = join(
    homedir(),
    ".claude",
    "projects",
    encodedDir,
    "sessions"
  );

  if (!existsSync(sessionsDir)) return null;

  let entries: string[];
  try {
    entries = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return null;
  }

  if (!entries.length) return null;

  // Sort by mtime descending, return the newest
  const sorted = entries
    .map((f) => {
      const fullPath = join(sessionsDir, f);
      try {
        return { path: fullPath, mtime: statSync(fullPath).mtimeMs };
      } catch {
        return { path: fullPath, mtime: 0 };
      }
    })
    .sort((a, b) => b.mtime - a.mtime);

  return sorted[0].path;
}

/**
 * Read the last `count` human/assistant message pairs from a JSONL file.
 *
 * Synchronous — reads the whole file in memory.  JSONL transcripts are
 * bounded by context window size so this is safe even for large sessions.
 *
 * @param jsonlPath  Absolute path to a Claude Code .jsonl transcript file.
 * @param count      Number of conversation pairs to read (default: 15).
 * @returns  Array of plain-text message strings (up to count*2 entries).
 */
export function readLastMessages(
  jsonlPath: string,
  count: number = 15
): string[] {
  if (!existsSync(jsonlPath)) return [];

  let raw: string;
  try {
    raw = readFileSync(jsonlPath, "utf8");
  } catch {
    return [];
  }

  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const messages: string[] = [];
  const limit = count * 2;

  // Walk from the end to collect the most recent messages first
  for (let i = lines.length - 1; i >= 0 && messages.length < limit; i--) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(lines[i]) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = obj.type as string | undefined;
    if (type !== "assistant" && type !== "user") continue;

    const text = extractText(obj);
    if (text && text.trim().length > 0) {
      // Prepend to maintain chronological order
      messages.unshift(text);
    }
  }

  return messages;
}

/**
 * Generate a descriptive 1-3 word slug from conversation message strings.
 *
 * Algorithm:
 *  1. Tokenize all messages, remove stop words and short tokens
 *  2. Count word frequency
 *  3. Pick the top `maxWords` most frequent tokens
 *  4. Join with hyphen, lowercase
 *
 * @param messages  Array of plain-text conversation messages.
 * @param opts      Optional slug configuration.
 * @returns  A lowercase hyphen-joined slug, e.g. "memory-engine-refactor",
 *           or "unnamed-session" if no meaningful words are found.
 */
export function generateSlug(messages: string[], opts?: SlugOptions): string {
  const maxWords = opts?.maxWords ?? 3;
  const maxLength = opts?.maxLength ?? 30;

  if (!messages.length) return "unnamed-session";

  // Count word frequencies across all messages
  const freq = new Map<string, number>();
  for (const msg of messages) {
    for (const token of tokenize(msg)) {
      freq.set(token, (freq.get(token) ?? 0) + 1);
    }
  }

  if (!freq.size) return "unnamed-session";

  // Sort by frequency descending, take top maxWords
  const topWords = Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxWords)
    .map(([word]) => word);

  if (!topWords.length) return "unnamed-session";

  // Join and trim to maxLength (truncate at last hyphen boundary)
  let slug = topWords.join("-");
  if (slug.length > maxLength) {
    slug = slug.slice(0, maxLength).replace(/-[^-]*$/, "");
  }

  return slug || "unnamed-session";
}
