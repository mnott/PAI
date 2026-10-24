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

import { existsSync } from "node:fs";
import chalk from "chalk";
import { searchHistory, HISTORY_FILE } from "../../lib/history-search.js";
import { renderTable, header, dim, warn, err } from "../../lib/utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
