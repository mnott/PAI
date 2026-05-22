/**
 * main-resolver.ts
 *
 * `pai [<query>]`  —  topic-first session discovery and launcher (v0.11.0)
 *
 * Decision tree:
 *   1. No arg          → show deduped session listing (one row per name)
 *   2. UUID prefix     → universal filesystem scan; auto-launch the match
 *   3. Any string:
 *      a. Live match (by paiName) → aibroker_switch → iTerm tab to front. Done.
 *      b. Resumable match         → probe + claude --resume <uuid>
 *      c. Transcript/stub match   → fresh claude in same project dir
 *      d. No name match           → free-text history search → picker
 *
 * Dedup algorithm for listing:
 *   - Collect live Claude sessions from AIBroker (kind:"claude")
 *   - Collect disk sessions from session-scan (named filter)
 *   - Build unified entries, group by name (case-insensitive)
 *   - Within each group, pick by priority: live > resumable > transcript-only > stub > orphan
 *   - Within same priority, pick latest by mtime
 *   - Output ONE row per name with status column
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
import { fetchLiveSessions, switchToSession, type AiBrokerSessionMeta } from "../lib/aibroker-client.js";

// ---------------------------------------------------------------------------
// Status priority for dedup
// ---------------------------------------------------------------------------

type UnifiedStatus = "live" | "resumable" | "transcript-only" | "stub" | "orphan";

const STATUS_PRIORITY: Record<UnifiedStatus, number> = {
  live: 0,
  resumable: 1,
  "transcript-only": 2,
  stub: 3,
  orphan: 4,
};

interface UnifiedSession {
  name: string;
  status: UnifiedStatus;
  /** Only present for live sessions */
  liveSessionId?: string;
  /** Only present for disk sessions */
  diskSession?: ScannedSession;
  lastActivity: number;
  project: string;
  lastPrompt: string;
}

// ---------------------------------------------------------------------------
// Build deduped catalog
// ---------------------------------------------------------------------------

function buildDeduped(
  liveSessions: AiBrokerSessionMeta[],
  diskSessions: ScannedSession[]
): UnifiedSession[] {
  const byName = new Map<string, UnifiedSession>();

  // Process live Claude sessions
  for (const s of liveSessions) {
    if (s.kind === "shell") continue;
    const rawName = s.paiName ?? s.name ?? s.sessionId.slice(0, 8);
    const key = rawName.toLowerCase();
    const entry: UnifiedSession = {
      name: rawName,
      status: "live",
      liveSessionId: s.sessionId,
      lastActivity: Date.now(),
      project: "",
      lastPrompt: "",
    };
    const existing = byName.get(key);
    if (!existing || STATUS_PRIORITY["live"] < STATUS_PRIORITY[existing.status]) {
      byName.set(key, entry);
    }
  }

  // Process disk sessions
  for (const s of diskSessions) {
    const rawName = s.friendlyName ?? s.shortId;
    const key = rawName.toLowerCase();

    let status: UnifiedStatus;
    if (s.resumable) {
      status = "resumable";
    } else if (s.sessionStatus === "transcript-only") {
      status = "transcript-only";
    } else if (s.sessionStatus === "stub") {
      status = "stub";
    } else {
      status = "orphan";
    }

    const entry: UnifiedSession = {
      name: rawName,
      status,
      diskSession: s,
      lastActivity: s.mtime,
      project: s.decodedPath ?? "",
      lastPrompt: s.lastUserPrompt ?? "",
    };

    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, entry);
    } else {
      const existingPriority = STATUS_PRIORITY[existing.status];
      const newPriority = STATUS_PRIORITY[status];
      if (newPriority < existingPriority) {
        byName.set(key, entry);
      } else if (newPriority === existingPriority && entry.lastActivity > existing.lastActivity) {
        // Same priority — keep most recent
        byName.set(key, entry);
      }
    }
  }

  // Sort: live first, then by lastActivity desc
  const entries = Array.from(byName.values());
  entries.sort((a, b) => {
    const pa = STATUS_PRIORITY[a.status];
    const pb = STATUS_PRIORITY[b.status];
    if (pa !== pb) return pa - pb;
    return b.lastActivity - a.lastActivity;
  });

  return entries;
}

// ---------------------------------------------------------------------------
// Probe helper
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
// Launch session (disk-based)
// ---------------------------------------------------------------------------

function launchSession(
  session: ScannedSession,
  allSessions: ScannedSession[],
  dryRun: boolean
): void {
  let resumableUuid: string | undefined;

  if (session.resumable) {
    resumableUuid = session.uuid;
  } else if (session.encodedDir) {
    const sameProject = allSessions.filter(
      (s) => s.encodedDir === session.encodedDir && s.resumable
    );
    sameProject.sort((a, b) => b.mtime - a.mtime);
    if (sameProject.length > 0) {
      resumableUuid = sameProject[0].uuid;
    }
  }

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

function matchToSession(
  match: SessionMatch,
  allSessions: ScannedSession[]
): ScannedSession | null {
  if (!match.sessionId) return null;

  const catalogMatch = allSessions.find((s) => s.uuid === match.sessionId);
  if (catalogMatch) return catalogMatch;

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

function fmtStatus(s: UnifiedStatus): string {
  switch (s) {
    case "live":          return chalk.green("live");
    case "resumable":     return chalk.cyan("resumable");
    case "transcript-only": return chalk.dim("transcript");
    case "stub":          return chalk.dim("stub");
    case "orphan":        return chalk.dim("orphan");
  }
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
  // Case 1: No query → deduped session listing
  // -----------------------------------------------------------------------
  if (!query) {
    let liveSessions: Awaited<ReturnType<typeof fetchLiveSessions>> = [];
    try {
      liveSessions = await fetchLiveSessions();
    } catch {
      // AIBroker not running — show only disk sessions
    }

    const deduped = buildDeduped(liveSessions, allSessions);

    if (deduped.length === 0) {
      console.log(warn("No sessions found. Start Claude Code in a project directory first."));
      return;
    }

    console.log("\n" + header("Sessions") + "\n");
    const tableHeaders = ["#", "name", "status", "age", "project", "last prompt"];
    const tableRows = deduped.slice(0, maxResults).map((entry, i) => {
      const age =
        entry.status === "live"
          ? chalk.green("now")
          : dim(fmtAge(entry.lastActivity));
      const snippet = entry.lastPrompt.replace(/\n+/g, " ").trim().slice(0, 36);
      const project = entry.diskSession
        ? dim(shortenProject(entry.diskSession.friendlyName ?? entry.diskSession.decodedPath, 28))
        : dim("—");
      return [
        dim(String(i + 1)),
        chalk.white(entry.name),
        fmtStatus(entry.status),
        age,
        project,
        chalk.dim(snippet ? `"${snippet}"` : "—"),
      ];
    });
    console.log(renderTable(tableHeaders, tableRows));

    console.log();
    console.log(dim("  Switch/resume/start: ") + chalk.white("pai <name>") + dim("  or  ") + chalk.white("pai <uuid-prefix>"));
    console.log();
    return;
  }

  // -----------------------------------------------------------------------
  // Case 2: UUID prefix (8+ hex chars) → universal filesystem scan
  // -----------------------------------------------------------------------
  const UUID_PREFIX_RE = /^[0-9a-f-]{8,36}$/i;
  if (UUID_PREFIX_RE.test(query)) {
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
    // Fall through to name match / history search
  }

  // -----------------------------------------------------------------------
  // Case 3: Name match against deduped catalog
  // -----------------------------------------------------------------------
  {
    // Fetch live sessions for the switch path
    let liveSessions: Awaited<ReturnType<typeof fetchLiveSessions>> = [];
    try {
      liveSessions = await fetchLiveSessions();
    } catch {
      // AIBroker not running
    }

    const deduped = buildDeduped(liveSessions, allSessions);
    const qLower = query.toLowerCase();

    // Exact name match first
    const exactMatch = deduped.find((e) => e.name.toLowerCase() === qLower);
    if (exactMatch) {
      if (exactMatch.status === "live" && exactMatch.liveSessionId) {
        // Switch iTerm tab to front
        if (opts.dryRun) {
          console.log("\n" + chalk.bold("Dry run — would switch iTerm tab:") + "\n");
          console.log(`  target: ${exactMatch.name} (${exactMatch.liveSessionId.slice(0, 8)})`);
          console.log(`  action: aibroker_switch + osascript iTerm activate`);
          console.log();
          return;
        }
        const result = await switchToSession(exactMatch.liveSessionId);
        if (result.ok) {
          console.log(ok(`Switched to live session: ${chalk.white(exactMatch.name)}`));
        } else {
          console.error(warn(`Could not switch via AIBroker: ${result.error ?? "unknown error"}`));
          console.error(dim("  Falling back to disk launch..."));
          // Fall through to disk session handling
          if (exactMatch.diskSession) {
            launchSession(exactMatch.diskSession, allSessions, opts.dryRun ?? false);
          }
        }
        return;
      }

      // Disk-based launch (resumable, transcript-only, stub)
      if (exactMatch.diskSession) {
        launchSession(exactMatch.diskSession, allSessions, opts.dryRun ?? false);
        return;
      }
    }

    // Partial name match
    const partialMatches = deduped.filter(
      (e) => e.name.toLowerCase().includes(qLower)
    );
    if (partialMatches.length === 1) {
      const match = partialMatches[0];
      if (match.status === "live" && match.liveSessionId) {
        if (opts.dryRun) {
          console.log("\n" + chalk.bold("Dry run — would switch iTerm tab:") + "\n");
          console.log(`  target: ${match.name} (${match.liveSessionId.slice(0, 8)})`);
          console.log(`  action: aibroker_switch + osascript iTerm activate`);
          console.log();
          return;
        }
        const result = await switchToSession(match.liveSessionId);
        if (result.ok) {
          console.log(ok(`Switched to live session: ${chalk.white(match.name)}`));
        } else {
          console.error(warn(`Could not switch via AIBroker: ${result.error ?? "unknown error"}`));
          if (match.diskSession) {
            launchSession(match.diskSession, allSessions, opts.dryRun ?? false);
          }
        }
        return;
      }
      if (match.diskSession) {
        launchSession(match.diskSession, allSessions, opts.dryRun ?? false);
        return;
      }
    }

    if (partialMatches.length > 1) {
      // Multiple named sessions match — show as candidates
      console.log("\n" + header(`Sessions matching "${query}"`) + "\n");
      const headers = ["#", "name", "status", "age", "project"];
      const rows = partialMatches.slice(0, maxResults).map((entry, i) => {
        const age =
          entry.status === "live"
            ? chalk.green("now")
            : dim(fmtAge(entry.lastActivity));
        const project = entry.diskSession
          ? dim(shortenProject(entry.diskSession.decodedPath, 36))
          : dim("—");
        return [
          dim(String(i + 1)),
          chalk.white(entry.name),
          fmtStatus(entry.status),
          age,
          project,
        ];
      });
      console.log(renderTable(headers, rows));
      console.log();

      if (pickN !== undefined) {
        const idx = pickN - 1;
        if (idx >= 0 && idx < partialMatches.length) {
          const match = partialMatches[idx];
          if (match.status === "live" && match.liveSessionId) {
            if (!opts.dryRun) {
              await switchToSession(match.liveSessionId);
              console.log(ok(`Switched to live session: ${chalk.white(match.name)}`));
            }
            return;
          }
          if (match.diskSession) {
            launchSession(match.diskSession, allSessions, opts.dryRun ?? false);
          }
          return;
        }
        console.error(err(`Invalid choice: ${pickN}`));
        process.exitCode = 1;
        return;
      }

      if (opts.auto) {
        const match = partialMatches[0];
        if (match.status === "live" && match.liveSessionId) {
          if (!opts.dryRun) {
            await switchToSession(match.liveSessionId);
            console.log(ok(`Switched to live session: ${chalk.white(match.name)}`));
          }
          return;
        }
        if (match.diskSession) {
          launchSession(match.diskSession, allSessions, opts.dryRun ?? false);
        }
        return;
      }

      const choice = await askForChoice(Math.min(partialMatches.length, maxResults));
      if (choice !== null) {
        const match = partialMatches[choice - 1];
        if (match.status === "live" && match.liveSessionId) {
          await switchToSession(match.liveSessionId);
          console.log(ok(`Switched to live session: ${chalk.white(match.name)}`));
          return;
        }
        if (match.diskSession) {
          launchSession(match.diskSession, allSessions, opts.dryRun ?? false);
        }
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
    console.error(dim(`  Try: pai  (no args) to see all sessions.`));
    process.exitCode = 1;
    return;
  }

  process.stderr.write(dim(`  Searching prompt history for "${query}"...\n`));
  const matches = await searchHistory(query, maxResults);

  if (matches.length === 0) {
    console.log(warn(`No sessions found matching "${query}".`));
    console.log(dim(`  Try a shorter or different search term.`));
    console.log(dim(`  Or run: `) + chalk.white("pai") + dim(" (no args) to see all sessions."));
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
