/**
 * pai find <query> [--n=20] [--json]
 *
 * Content-based search across ~/.claude/history.jsonl.
 * Finds user prompts matching the query (case-insensitive substring),
 * groups by sessionId, sorts by most-recent match, and shows a table
 * with short UUID, date, project path, and the matching prompt snippet.
 *
 * The sessionId from history.jsonl is the same UUID used by claude --resume,
 * so rows are directly resumable via: pai resume <id>
 *
 * Note: older history.jsonl entries (before Claude Code ~2.0) may lack a
 * sessionId field. These are grouped under a synthetic "no-session" bucket
 * and shown in a separate note at the bottom.
 */

import { existsSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { homedir } from "node:os";
import chalk from "chalk";
import { renderTable, header, dim, warn, err } from "../utils.js";

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

interface SessionMatch {
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

const HISTORY_FILE = join(homedir(), ".claude", "history.jsonl");

// ---------------------------------------------------------------------------
// Shorten project path for display
// ---------------------------------------------------------------------------

function shortenProject(p: string, maxLen = 42): string {
  if (p.length <= maxLen) return p;
  // Keep tail (the meaningful part) and prefix with …
  return "…" + p.slice(-(maxLen - 1));
}

// ---------------------------------------------------------------------------
// Format timestamp
// ---------------------------------------------------------------------------

function fmtTs(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

// ---------------------------------------------------------------------------
// Core search function (streaming to avoid loading 26k lines into memory)
// ---------------------------------------------------------------------------

export async function searchHistory(
  query: string,
  maxResults: number
): Promise<SessionMatch[]> {
  if (!existsSync(HISTORY_FILE)) return [];

  const queryLower = query.toLowerCase();
  // Escape regex special chars from query for safety — but we're doing
  // string .includes() not regex, so no escaping needed.

  const bySession = new Map<string, SessionMatch>();
  const noSession: SessionMatch = {
    sessionId: null,
    lastMatchTs: 0,
    lastMatchDisplay: "",
    project: "",
    matchCount: 0,
  };

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

    if (!sessionId) {
      // Older entry without sessionId
      if (ts > noSession.lastMatchTs) {
        noSession.lastMatchTs = ts;
        noSession.lastMatchDisplay = display;
        noSession.project = project;
      }
      noSession.matchCount++;
      continue;
    }

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

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function cmdFind(
  query: string,
  opts: { n?: string; json?: boolean }
): Promise<void> {
  const maxResults = parseInt(opts.n ?? "20", 10);

  if (!existsSync(HISTORY_FILE)) {
    console.error(err(`~/.claude/history.jsonl not found.`));
    process.exitCode = 1;
    return;
  }

  const matches = await searchHistory(query, maxResults);

  if (opts.json) {
    console.log(JSON.stringify(matches, null, 2));
    return;
  }

  if (matches.length === 0) {
    console.log(warn(`No sessions found matching "${query}" in ~/.claude/history.jsonl.`));
    console.log(dim(`  Try a shorter or different search term.`));
    return;
  }

  console.log("\n" + header("Session Search Results") + "\n");
  console.log(dim(`  Query: "${query}"  (${matches.length} session(s) with matching prompts)\n`));

  const headers = ["#", "id", "when", "project", "last matching prompt"];
  const rows = matches.map((m, idx) => {
    const shortId = (m.sessionId ?? "no-session").slice(0, 8);
    const when = m.lastMatchTs > 0 ? fmtTs(m.lastMatchTs) : dim("—");
    const project = shortenProject(m.project || dim("—"));
    // Truncate the prompt snippet — strip newlines, trim
    const snippet = m.lastMatchDisplay
      .replace(/\n+/g, " ")
      .trim()
      .slice(0, 48);
    const display = snippet.length < m.lastMatchDisplay.replace(/\n+/g, " ").trim().length
      ? `"${snippet}…"`
      : `"${snippet}"`;

    return [
      dim(String(idx + 1)),
      chalk.cyan(shortId),
      when,
      dim(project),
      chalk.dim(display),
    ];
  });

  console.log(renderTable(headers, rows));
  console.log();
  console.log(dim("  Resume: ") + chalk.white("pai resume <id>"));
  console.log();
}
