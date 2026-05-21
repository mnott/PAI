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
import { fetchLiveSessions, type AiBrokerSessionMeta } from "../../lib/aibroker-client.js";

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

function renderLiveSessions(allLiveSessions: AiBrokerSessionMeta[], allTabs: boolean): void {
  // Default: Claude sessions only (kind === "claude"). --all-tabs includes shells.
  const displayed = allTabs
    ? allLiveSessions
    : allLiveSessions.filter((s) => s.kind !== "shell");
  const skippedCount = allLiveSessions.length - displayed.length;

  if (displayed.length === 0) return;

  console.log("\n" + header("Live Sessions") + "\n");

  const liveHeaders = ["#", "id", "name", "at prompt", "kind"];
  const liveRows = displayed.map((s, idx) => {
    const shortId = s.sessionId.slice(0, 8);
    // Prefer paiName for Claude sessions, fall back to iTerm2 tab name
    const rawName = s.paiName ?? s.name;
    const name = rawName.length > 36 ? rawName.slice(0, 35) + "…" : rawName;
    const atPrompt = s.atPrompt ? chalk.green("yes") : chalk.yellow("busy");
    const kind = s.kind === "claude"
      ? chalk.cyan(s.kind)
      : chalk.dim(s.kind);

    return [
      chalk.dim(String(idx + 1)),
      chalk.cyan(shortId),
      name,
      atPrompt,
      kind,
    ];
  });

  console.log(renderTable(liveHeaders, liveRows));

  if (skippedCount > 0) {
    console.log(
      dim(`  (${skippedCount} shell tab${skippedCount === 1 ? "" : "s"} hidden — use --all-tabs to show)`)
    );
  }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function cmdRecent(
  db: Database,
  opts: { n?: string; all?: boolean; allTabs?: boolean; json?: boolean }
): Promise<void> {
  const limit = parseInt(opts.n ?? "20", 10);
  const includeAll = opts.all === true;
  const allTabs = opts.allTabs === true;

  // Fetch live sessions from AIBroker (silently no-ops if not running).
  const liveSessions = await fetchLiveSessions();

  const sessions = scanSessions(db, {
    limit,
    filter: includeAll ? "all" : "named",
  });

  if (opts.json) {
    const output = {
      live: liveSessions.map((s) => ({
        index: s.index,
        sessionId: s.sessionId,
        name: s.name,
        paiName: s.paiName,
        atPrompt: s.atPrompt,
        kind: s.kind,
        active: s.active,
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
  const hasClaudeLive = liveSessions.some((s) => s.kind === "claude");
  if (liveSessions.length > 0) {
    renderLiveSessions(liveSessions, allTabs);
  }

  // ── Paused / disk-scan section ────────────────────────────────────────────
  if (sessions.length === 0) {
    if (!hasClaudeLive) {
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
    // If we had live Claude sessions, nothing more to print.
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
      (hasClaudeLive
        ? dim("Pause all live:    ") + chalk.white("pai pause all") + "\n"
        : "") +
      (includeAll
        ? ""
        : dim("Show all sessions: ") +
          chalk.white("pai sessions --all") +
          "\n")
  );
}
