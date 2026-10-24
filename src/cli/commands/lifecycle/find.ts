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
import { HISTORY_TABLE_HEADERS, historyMatchRows } from "../../lib/history-table.js";
import { renderTable, header, dim, warn, err } from "../../lib/utils.js";

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

  const rows = historyMatchRows(matches, { noSessionId: "no-session", projectMax: 42, noProject: dim("—") });

  console.log(renderTable(HISTORY_TABLE_HEADERS, rows));
  console.log();
  console.log(dim("  Resume: ") + chalk.white("pai resume <id>"));
  console.log();
}
