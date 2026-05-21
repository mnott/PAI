/**
 * main-resolver.ts
 *
 * `pai [<query>]`  —  topic-first session discovery and launcher (v0.10.0)
 *
 * Decision tree:
 *   1. No arg          → show interactive picker of recent sessions (top 20 by mtime)
 *   2. UUID prefix     → universal filesystem scan; auto-launch the match
 *   3. Known name      → catalog name match; auto-launch immediately
 *   4. Free-text query → search history.jsonl; show candidates with excerpt; user picks
 *
 * The "-y" / "--auto" flag skips the interactive prompt and picks candidate #1.
 * "pai <query> <N>" also picks candidate #N directly.
 *
 * Launch logic (shared with goto.ts):
 *   - Find best resumable UUID for the matched project dir
 *   - Probe claude --resume to verify it's still valid
 *   - If valid: claude --resume <uuid> --name <name> "/Name <name>\ngo"
 *   - If invalid: claude --name <name> "/Name <name>\ngo"  (fresh in same dir)
 */

import type { Database } from "better-sqlite3";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import chalk from "chalk";
import { err, dim, warn, ok, header, bold, renderTable, fmtDate, shortenPath } from "../utils.js";
import {
  scanSessions,
  resolveSessionByNameOrId,
  fmtAge,
  type ScannedSession,
} from "../lib/session-scan.js";
import { searchHistory, HISTORY_FILE, type SessionMatch } from "../lib/history-search.js";
import { fetchLiveSessions } from "../lib/aibroker-client.js";

// ---------------------------------------------------------------------------
// Probe helper (same as goto.ts)
// ---------------------------------------------------------------------------

interface ProbeResult {
  ok: boolean;
  reason?: string;
}

function probeResume(uuid: string, cwd: string): ProbeResult {
  const result = spawnSync(
    "claude",
    ["--resume", uuid, "--print", "--output-format=json", "_"],
    {
      cwd,
      timeout: 5_000,
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    }
  );

  if (result.error) {
    return { ok: false, reason: `spawn error: ${result.error.message}` };
  }

  const stderr = result.stderr?.toString("utf8") ?? "";

  if (
    stderr.toLowerCase().includes("no conversation found") ||
    stderr.toLowerCase().includes("session not found")
  ) {
    return { ok: false, reason: "No conversation found for this UUID" };
  }

  if (result.status !== 0) {
    return {
      ok: false,
      reason: `claude exited ${result.status ?? "signal"}${stderr ? `: ${stderr.slice(0, 120).trim()}` : ""}`,
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Launch session
// ---------------------------------------------------------------------------

/**
 * Launch Claude for the given session. Handles resume probe + fallback to fresh.
 * Never returns on success (process.exit inside spawnSync block).
 */
function launchSession(
  session: ScannedSession,
  allSessions: ScannedSession[],
  dryRun: boolean
): void {
  // Find the best resumable UUID in this project dir
  let resumableUuid: string | undefined;
  let resumableSession: ScannedSession | undefined;

  if (session.resumable) {
    resumableUuid = session.uuid;
    resumableSession = session;
  } else if (session.encodedDir) {
    const sameProject = allSessions.filter(
      (s) => s.encodedDir === session.encodedDir && s.resumable
    );
    sameProject.sort((a, b) => b.mtime - a.mtime);
    if (sameProject.length > 0) {
      resumableSession = sameProject[0];
      resumableUuid = resumableSession.uuid;
    }
  }

  // Determine project dir
  const rawDir =
    session.clcDirectory ??
    session.registryRootPath ??
    session.decodedPath;

  let projectDir: string;
  try {
    projectDir = realpathSync(rawDir);
  } catch {
    console.error(
      err(
        `Session directory does not exist or cannot be resolved.\n` +
          `  Path: ${rawDir}\n` +
          `  The directory may have moved or been deleted.`
      )
    );
    process.exit(1);
    return;
  }

  const name = session.friendlyName ?? session.shortId;
  const promptArg = `/Name ${name}\ngo`;

  if (dryRun) {
    if (resumableUuid) {
      console.log("\n" + chalk.bold("Dry run — would probe then exec (RESUME path):") + "\n");
      console.log(`  cwd:      ${chalk.cyan(projectDir)}`);
      console.log(`  probe:    claude --resume ${resumableUuid} --print --output-format=json "_"`);
      console.log(`  argv:     claude --resume ${resumableUuid} --name "${name}" "/Name ${name}\\ngo"`);
      console.log(`  fallback: claude --name "${name}" "/Name ${name}\\ngo"`);
    } else {
      console.log("\n" + chalk.bold("Dry run — would exec (FRESH path):") + "\n");
      console.log(`  cwd:  ${chalk.cyan(projectDir)}`);
      console.log(`  argv: claude --name "${name}" "/Name ${name}\\ngo"`);
    }
    console.log();
    return;
  }

  if (resumableUuid) {
    const probe = probeResume(resumableUuid, projectDir);
    if (probe.ok) {
      const result = spawnSync(
        "claude",
        ["--resume", resumableUuid, "--name", name, promptArg],
        { cwd: projectDir, stdio: "inherit", env: process.env }
      );
      if (result.error) {
        console.error(err(`Failed to launch claude: ${result.error.message}`));
        process.exit(1);
      }
      process.exit(result.status ?? 0);
    } else {
      process.stderr.write(
        chalk.yellow(
          `\n  Resume failed for ${resumableUuid.slice(0, 8)}: ${probe.reason ?? "unknown error"}\n` +
            `  Starting fresh session in same directory.\n\n`
        )
      );
      const result = spawnSync(
        "claude",
        ["--name", name, promptArg],
        { cwd: projectDir, stdio: "inherit", env: process.env }
      );
      if (result.error) {
        console.error(err(`Failed to launch claude: ${result.error.message}`));
        process.exit(1);
      }
      process.exit(result.status ?? 0);
    }
  } else {
    const result = spawnSync(
      "claude",
      ["--name", name, promptArg],
      { cwd: projectDir, stdio: "inherit", env: process.env }
    );
    if (result.error) {
      console.error(err(`Failed to launch claude: ${result.error.message}`));
      process.exit(1);
    }
    process.exit(result.status ?? 0);
  }
}

// ---------------------------------------------------------------------------
// History match → ScannedSession bridge
// ---------------------------------------------------------------------------

/**
 * Given a SessionMatch from history search, find the corresponding ScannedSession
 * (for launch). Falls back to a minimal synthetic session using the decodedPath
 * from the history entry's project field.
 */
function matchToSession(
  match: SessionMatch,
  allSessions: ScannedSession[]
): ScannedSession | null {
  if (!match.sessionId) return null;

  // Try catalog first (for friendlyName, registryRootPath, resumable status)
  const catalogMatch = allSessions.find((s) => s.uuid === match.sessionId);
  if (catalogMatch) return catalogMatch;

  // Not in catalog — synthesize a minimal session using the project path from history
  // The sessionId is UUID format, use it to find the top-level jsonl directly
  if (!match.project) return null;

  return {
    uuid: match.sessionId,
    shortId: match.sessionId.slice(0, 8),
    encodedDir: "",
    decodedPath: match.project,
    topLevelPath: "",
    topLevelSystemLines: 0,
    topLevelSize: 0,
    resumable: false,
    sessionStatus: "transcript-only",
    sessionJsonlPath: undefined,
    userLines: 0,
    lastUserPrompt: match.lastMatchDisplay.slice(0, 80),
    msgCount: 0,
    mtime: match.lastMatchTs,
    friendlyName: undefined,
    clcDirectory: undefined,
    registryRootPath: match.project,
  };
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function fmtTs(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function shortenProject(p: string, maxLen = 44): string {
  if (!p || p.length <= maxLen) return p || dim("—");
  return "…" + p.slice(-(maxLen - 1));
}

// ---------------------------------------------------------------------------
// Interactive picker prompt
// ---------------------------------------------------------------------------

async function askForChoice(max: number): Promise<number | null> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(
      dim(`\n  Enter # to launch (1-${max}), or press Enter to cancel: `),
      (answer) => {
        rl.close();
        const n = parseInt(answer.trim(), 10);
        if (!isNaN(n) && n >= 1 && n <= max) {
          resolve(n);
        } else {
          resolve(null);
        }
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export interface MainResolverOpts {
  auto?: boolean;    // -y / --auto: pick #1 without prompting
  dryRun?: boolean;  // --dry-run: show what would happen
  n?: string;        // --n <count>: max candidates for history search
}

export async function cmdMain(
  db: Database,
  query: string | undefined,
  pickN: number | undefined,
  opts: MainResolverOpts
): Promise<void> {
  const maxResults = parseInt(opts.n ?? "20", 10);
  const allSessions = scanSessions(db, { limit: 500, filter: "named" });

  // -----------------------------------------------------------------------
  // Case 1: No query → recent session picker
  // -----------------------------------------------------------------------
  if (!query) {
    // Show live sessions from AIBroker + most recent disk sessions
    let liveSessions: Awaited<ReturnType<typeof fetchLiveSessions>> = [];
    try {
      liveSessions = await fetchLiveSessions();
    } catch {
      // AIBroker not running — show only disk sessions
    }

    const claudeLive = liveSessions.filter((s) => s.kind !== "shell");
    const recentDisk = allSessions.slice(0, maxResults);

    if (claudeLive.length === 0 && recentDisk.length === 0) {
      console.log(warn("No sessions found. Start Claude Code in a project directory first."));
      return;
    }

    // Live sessions section
    if (claudeLive.length > 0) {
      console.log("\n" + header("Live Sessions") + "\n");
      const liveHeaders = ["#", "id", "name", "at prompt"];
      const liveRows = claudeLive.map((s, i) => [
        dim(String(i + 1)),
        chalk.cyan(s.sessionId.slice(0, 8)),
        s.paiName ?? s.name ?? dim("—"),
        s.atPrompt ? chalk.green("yes") : chalk.dim("no"),
      ]);
      console.log(renderTable(liveHeaders, liveRows));
    }

    // Recent disk sessions section
    if (recentDisk.length > 0) {
      console.log("\n" + header("Recent Sessions") + "\n");
      const diskHeaders = ["#", "id", "age", "project", "last prompt"];
      const diskRows = recentDisk.map((s, i) => {
        const snippet = s.lastUserPrompt.replace(/\n+/g, " ").trim().slice(0, 40);
        return [
          dim(String(i + 1)),
          chalk.cyan(s.shortId),
          dim(fmtAge(s.mtime)),
          dim(shortenProject(s.friendlyName ?? s.decodedPath, 30)),
          chalk.dim(snippet ? `"${snippet}"` : "—"),
        ];
      });
      console.log(renderTable(diskHeaders, diskRows));
    }

    console.log();
    console.log(dim("  Resume a session: ") + chalk.white("pai <topic>") + dim("  or  ") + chalk.white("pai <id>"));
    console.log();
    return;
  }

  // -----------------------------------------------------------------------
  // Case 2: UUID prefix (8+ hex chars) → universal filesystem scan
  // -----------------------------------------------------------------------
  const UUID_PREFIX_RE = /^[0-9a-f-]{8,36}$/i;
  if (UUID_PREFIX_RE.test(query)) {
    // Try catalog first
    const byUuid = allSessions.filter((s) => s.uuid.startsWith(query.toLowerCase()));
    if (byUuid.length === 1) {
      launchSession(byUuid[0], allSessions, opts.dryRun ?? false);
      return;
    }
    if (byUuid.length > 1) {
      console.error(err(`UUID prefix "${query}" is ambiguous — ${byUuid.length} catalog matches.`));
      process.exitCode = 1;
      return;
    }
    // Fall through to name match / history search — UUID might be a partial word too
  }

  // -----------------------------------------------------------------------
  // Case 3: Known session name → auto-launch
  // -----------------------------------------------------------------------
  {
    const qLower = query.toLowerCase();
    const byExact = allSessions.filter(
      (s) => s.friendlyName && s.friendlyName.toLowerCase() === qLower
    );
    if (byExact.length >= 1) {
      launchSession(byExact[0], allSessions, opts.dryRun ?? false);
      return;
    }

    const byPartial = allSessions.filter(
      (s) => s.friendlyName && s.friendlyName.toLowerCase().includes(qLower)
    );
    if (byPartial.length === 1) {
      launchSession(byPartial[0], allSessions, opts.dryRun ?? false);
      return;
    }
    if (byPartial.length > 1) {
      // Multiple named sessions match — show as candidates
      console.log("\n" + header(`Sessions matching "${query}"`) + "\n");
      const headers = ["#", "id", "age", "name", "project"];
      const rows = byPartial.slice(0, maxResults).map((s, i) => [
        dim(String(i + 1)),
        chalk.cyan(s.shortId),
        dim(fmtAge(s.mtime)),
        s.friendlyName ?? dim("—"),
        dim(shortenProject(s.decodedPath, 36)),
      ]);
      console.log(renderTable(headers, rows));
      console.log();

      if (pickN !== undefined) {
        const idx = pickN - 1;
        if (idx >= 0 && idx < byPartial.length) {
          launchSession(byPartial[idx], allSessions, opts.dryRun ?? false);
          return;
        }
        console.error(err(`Invalid choice: ${pickN}`));
        process.exitCode = 1;
        return;
      }

      if (opts.auto) {
        launchSession(byPartial[0], allSessions, opts.dryRun ?? false);
        return;
      }

      const choice = await askForChoice(Math.min(byPartial.length, maxResults));
      if (choice !== null) {
        launchSession(byPartial[choice - 1], allSessions, opts.dryRun ?? false);
      }
      return;
    }
  }

  // -----------------------------------------------------------------------
  // Case 4: Free-text history search
  // -----------------------------------------------------------------------
  if (!existsSync(HISTORY_FILE)) {
    console.error(err("~/.claude/history.jsonl not found."));
    console.error(dim("  No prompt history available for search."));
    process.exitCode = 1;
    return;
  }

  process.stderr.write(dim(`  Searching prompt history for "${query}"...\n`));
  const matches = await searchHistory(query, maxResults);

  if (matches.length === 0) {
    console.log(warn(`No sessions found matching "${query}".`));
    console.log(dim(`  Try a shorter or different search term.`));
    console.log(dim(`  Or run: `) + chalk.white("pai") + dim(" (no args) to see all recent sessions."));
    return;
  }

  console.log("\n" + header(`Sessions matching "${query}"`) + "\n");
  const headers = ["#", "id", "when", "project", "last matching prompt"];
  const rows = matches.map((m, idx) => {
    const shortId = (m.sessionId ?? "—").slice(0, 8);
    const when = m.lastMatchTs > 0 ? fmtTs(m.lastMatchTs) : dim("—");
    const project = shortenProject(m.project || "—");
    const snippet = m.lastMatchDisplay.replace(/\n+/g, " ").trim().slice(0, 48);
    const fullSnippet = m.lastMatchDisplay.replace(/\n+/g, " ").trim();
    const display = snippet.length < fullSnippet.length ? `"${snippet}…"` : `"${snippet}"`;
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

  // Direct pick by inline number
  if (pickN !== undefined) {
    const idx = pickN - 1;
    if (idx >= 0 && idx < matches.length) {
      const session = matchToSession(matches[idx], allSessions);
      if (!session) {
        console.error(err("Could not resolve session for launch (no project path)."));
        process.exitCode = 1;
        return;
      }
      launchSession(session, allSessions, opts.dryRun ?? false);
      return;
    }
    console.error(err(`Invalid choice: ${pickN}`));
    process.exitCode = 1;
    return;
  }

  // Auto-pick first
  if (opts.auto) {
    const session = matchToSession(matches[0], allSessions);
    if (!session) {
      console.error(err("Could not resolve session for launch (no project path)."));
      process.exitCode = 1;
      return;
    }
    launchSession(session, allSessions, opts.dryRun ?? false);
    return;
  }

  // Interactive pick
  const choice = await askForChoice(matches.length);
  if (choice !== null) {
    const session = matchToSession(matches[choice - 1], allSessions);
    if (!session) {
      console.error(err("Could not resolve session for launch (no project path)."));
      process.exitCode = 1;
      return;
    }
    launchSession(session, allSessions, opts.dryRun ?? false);
  }
}
