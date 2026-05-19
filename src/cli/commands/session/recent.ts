/**
 * pai session recent [-n N] [--all] [--json]
 *
 * List named sessions — resumable OR in the clc registry.
 *   Default: "named" filter (resumable + stubs + transcript-only from clc registry).
 *   --all: also include unnamed orphan sessions (only in sessions/ subdir, not in registry).
 *
 * Status column (always shown):
 *   resumable       — top-level jsonl with system snapshot (claude --resume works) — green
 *   stub            — in registry, top-level exists but no system lines (Ctrl+C exit) — yellow
 *   transcript-only — in registry but no top-level jsonl — yellow
 *   orphan          — not in registry, only transcript exists — dim (--all only)
 *
 * When AIBroker is running, a "Live Sessions" section is shown first,
 * listing currently-active iTerm2 panes that have an active Claude session.
 */

import type { Database } from "better-sqlite3";
import chalk from "chalk";
import { renderTable, err, dim, header } from "../../utils.js";
import { scanSessions, fmtAge, type SessionStatus } from "../../lib/session-scan.js";
import { fetchLiveSessions, type AiBrokerSession } from "../../lib/aibroker-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1_048_576) return `${Math.round(bytes / 1024)}K`;
  return `${(bytes / 1_048_576).toFixed(1)}M`;
}

function fmtStatus(status: SessionStatus): string {
  switch (status) {
    case "resumable":
      return chalk.green("resumable");
    case "stub":
      return chalk.yellow("stub");
    case "transcript-only":
      return chalk.yellow("transcript-only");
    case "orphan":
      return chalk.dim("orphan");
  }
}

// ---------------------------------------------------------------------------
// Live-sessions rendering (AIBroker integration)
// ---------------------------------------------------------------------------

function renderLiveSessions(liveSessions: AiBrokerSession[]): void {
  if (liveSessions.length === 0) return;

  console.log("\n" + header("Live Sessions") + "\n");

  const liveHeaders = ["#", "iTerm2 id", "name", "at prompt", "paiName"];
  const liveRows = liveSessions.map((s, idx) => {
    const shortId = s.sessionId.slice(0, 8);
    const name = s.name.length > 32 ? s.name.slice(0, 31) + "…" : s.name;
    const paiName = s.paiName
      ? s.paiName.length > 20
        ? s.paiName.slice(0, 19) + "…"
        : s.paiName
      : dim("—");
    const atPrompt = s.atPrompt ? chalk.green("yes") : chalk.yellow("busy");

    return [
      chalk.dim(String(idx + 1)),
      chalk.cyan(shortId),
      name,
      atPrompt,
      paiName,
    ];
  });

  console.log(renderTable(liveHeaders, liveRows));
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function cmdRecent(
  db: Database,
  opts: { n?: string; all?: boolean; json?: boolean }
): Promise<void> {
  const limit = parseInt(opts.n ?? "20", 10);
  const includeAll = opts.all === true;

  // Fetch live sessions from AIBroker (silently no-ops if not running).
  const liveSessions = await fetchLiveSessions();

  const sessions = scanSessions(db, {
    limit,
    filter: includeAll ? "all" : "named",
  });

  if (opts.json) {
    const output = {
      live: liveSessions.map((s) => ({
        sessionId: s.sessionId,
        name: s.name,
        paiName: s.paiName ?? null,
        atPrompt: s.atPrompt,
      })),
      paused: sessions.map((s, idx) => ({
        idx: idx + 1,
        uuid: s.uuid,
        shortId: s.shortId,
        resumable: s.resumable,
        sessionStatus: s.sessionStatus,
        age: fmtAge(s.mtime),
        mtime: s.mtime,
        name: s.friendlyName,
        lastUserPrompt: s.lastUserPrompt,
        userLines: s.userLines,
        msgCount: s.msgCount,
        topLevelSize: s.topLevelSize,
        decodedPath: s.decodedPath,
      })),
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // ── Live section ──────────────────────────────────────────────────────────
  if (liveSessions.length > 0) {
    renderLiveSessions(liveSessions);
  }

  // ── Paused / disk-scan section ────────────────────────────────────────────
  if (sessions.length === 0) {
    if (liveSessions.length === 0) {
      // Nothing at all
      if (includeAll) {
        console.log(err("No sessions found in ~/.claude/projects/."));
      } else {
        console.log(
          err(
            "No named sessions found.\n\n" +
              "  Named sessions appear when you have entries in ~/.claude/session.json\n" +
              "  (set via /Name inside Claude Code) or resumable top-level jsonl files.\n" +
              "  Run: pai session recent --all  to list all sessions including unnamed orphans."
          )
        );
      }
    }
    // If we had live sessions, nothing more to print.
    return;
  }

  const title = includeAll
    ? "Paused / All Sessions (named + orphans)"
    : "Paused / Resumable Sessions";
  console.log("\n" + header(title) + "\n");

  const headers = ["#", "id", "age", "name / project", "last prompt", "msgs", "size", "status"];

  const rows = sessions.map((s, idx) => {
    const name = s.friendlyName ?? s.decodedPath;
    const prompt = s.lastUserPrompt
      ? chalk.dim(
          s.lastUserPrompt.length > 40
            ? s.lastUserPrompt.slice(0, 39) + "…"
            : s.lastUserPrompt
        )
      : dim("—");

    return [
      chalk.dim(String(idx + 1)),
      chalk.cyan(s.shortId),
      dim(fmtAge(s.mtime)),
      name.length > 26 ? name.slice(0, 25) + "…" : name,
      prompt,
      s.userLines > 0 ? String(s.userLines) : dim("—"),
      dim(fmtSize(s.topLevelSize)),
      fmtStatus(s.sessionStatus),
    ];
  });

  console.log(renderTable(headers, rows));

  console.log(
    "\n" +
      dim("Go to a session:   ") +
      chalk.white("pai resume <name>") +
      "\n" +
      (liveSessions.length > 0
        ? dim("Pause all live:    ") + chalk.white("pai pause all") + "\n"
        : "") +
      (includeAll
        ? ""
        : dim("Show all sessions: ") +
          chalk.white("pai sessions --all") +
          "\n")
  );
}
