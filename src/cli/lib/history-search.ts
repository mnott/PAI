/**
 * history-search.ts
 *
 * Content-based search across ~/.claude/history.jsonl.
 * Streams the file (avoids loading 26k+ lines into memory), groups matching
 * lines by sessionId, and returns results sorted by most-recent match.
 *
 * Used by: pai <query> (main resolver) and pai find (compat alias)
 */

import { existsSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HistoryEntry {
  display?: string;
  timestamp?: number;
  project?: string;
  sessionId?: string;
  pastedContents?: unknown;
}

export interface SessionMatch {
  sessionId: string | null;
  /** Most-recent timestamp among matching lines */
  lastMatchTs: number;
  /** Most-recent matching prompt text */
  lastMatchDisplay: string;
  /** Project path (from the most-recent match) */
  project: string;
  /** Number of matching lines in this session */
  matchCount: number;
}

// ---------------------------------------------------------------------------
// History file location
// ---------------------------------------------------------------------------

export const HISTORY_FILE = join(homedir(), ".claude", "history.jsonl");

// ---------------------------------------------------------------------------
// Core search function (streaming)
// ---------------------------------------------------------------------------

/**
 * Search ~/.claude/history.jsonl for prompts matching the query (case-insensitive
 * substring). Results are grouped by sessionId and sorted by most-recent match.
 *
 * Entries without a sessionId (old Claude Code versions) are excluded from
 * results since they can't be resumed.
 */
export async function searchHistory(
  query: string,
  maxResults: number
): Promise<SessionMatch[]> {
  if (!existsSync(HISTORY_FILE)) return [];

  const queryLower = query.toLowerCase();
  const bySession = new Map<string, SessionMatch>();

  const rl = createInterface({
    input: createReadStream(HISTORY_FILE, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;

    let entry: HistoryEntry;
    try {
      entry = JSON.parse(t) as HistoryEntry;
    } catch {
      continue;
    }

    const display = entry.display ?? "";
    if (!display.toLowerCase().includes(queryLower)) continue;

    const ts = entry.timestamp ?? 0;
    const project = entry.project ?? "";
    const sessionId = entry.sessionId ?? null;

    // Skip entries with no sessionId — can't resume them
    if (!sessionId) continue;

    const existing = bySession.get(sessionId);
    if (!existing) {
      bySession.set(sessionId, {
        sessionId,
        lastMatchTs: ts,
        lastMatchDisplay: display,
        project,
        matchCount: 1,
      });
    } else {
      existing.matchCount++;
      if (ts > existing.lastMatchTs) {
        existing.lastMatchTs = ts;
        existing.lastMatchDisplay = display;
        existing.project = project;
      }
    }
  }

  // Sort by most-recent match descending
  const sorted = [...bySession.values()].sort(
    (a, b) => b.lastMatchTs - a.lastMatchTs
  );

  return sorted.slice(0, maxResults);
}
