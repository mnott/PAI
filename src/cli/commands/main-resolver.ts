/**
 * main-resolver.ts
 *
 * `pai [<query>]`  —  topic-first session discovery and launcher (v0.11.1)
 *
 * Decision tree:
 *   1. No arg          → show deduped session listing (one row per name)
 *   2. UUID prefix     → universal filesystem scan; auto-launch the match
 *   3. Any string:
 *      a. Live match (by normalized paiName) → aibroker_switch → iTerm tab to front. Done.
 *      b. Resumable match                    → probe + claude --resume <uuid>
 *      c. Transcript/stub match              → fresh claude in same project dir
 *      d. No name match                      → free-text history search → picker
 *
 * Dedup + name normalization logic: src/cli/lib/dedup-sessions.ts (shared with listing).
 */

import type { Database } from "better-sqlite3";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import chalk from "chalk";
import { err, dim, warn, ok, header, renderTable } from "../utils.js";
import {
  scanSessions,
  fmtAge,
  type ScannedSession,
} from "../lib/session-scan.js";
import { searchHistory, HISTORY_FILE, type SessionMatch } from "../lib/history-search.js";
import { fetchLiveSessions, fetchLiveSessionsWithPrompts, switchToSession } from "../lib/aibroker-client.js";
import { basename } from "node:path";
import { printExitDir } from "../lib/exit-dir.js";
import { probeResume, launchInDir } from "../lib/launch.js";
import {
  buildDeduped,
  normalizeName,
  STATUS_PRIORITY,
  fmtUnifiedStatus,
  renderDedupedSessions,
  type UnifiedSession,
  type RegisteredProject,
} from "../lib/dedup-sessions.js";

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

  // A session is named for a human to recognise, so a UUID prefix is never an
  // acceptable answer. `friendlyName` is undefined for the sessions synthesized
  // from a prompt-history match, and picking one of those used to open a tab
  // called "7fdbb9a8" — for a project plainly called Paperfull, sitting right
  // there in the path we already resolved. The directory is the better fallback
  // in every case, so shortId is now only reached for a path with no basename.
  const name = session.friendlyName ?? (basename(projectDir) || session.shortId);
  const promptArg = `/Name ${name}\ngo`;

  if (dryRun) {
    if (resumableUuid) {
      console.log("\n" + chalk.bold("Dry run — would probe then exec (RESUME path):") + "\n");
      console.log(`  cwd:      ${chalk.cyan(projectDir)}`);
      console.log(`  probe:    transcript on disk for ${resumableUuid.slice(0, 8)}?`);
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
      printExitDir(projectDir);
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
      printExitDir(projectDir);
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
    printExitDir(projectDir);
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
// Shared switch helper (live session → iTerm tab)
// ---------------------------------------------------------------------------

async function doSwitch(
  entry: UnifiedSession,
  dryRun: boolean
): Promise<boolean> {
  if (!entry.liveSessionId) return false;
  if (dryRun) {
    console.log("\n" + chalk.bold("Dry run — would switch iTerm tab:") + "\n");
    console.log(`  target: ${entry.name} (${entry.liveSessionId.slice(0, 8)})`);
    console.log(`  action: aibroker_switch + osascript iTerm activate`);
    console.log();
    return true;
  }
  const result = await switchToSession(entry.liveSessionId);
  if (result.ok) {
    // Name AND id. "Switched to live session: pai" was reported three times on
    // 2026-08-04 by a user watching nothing happen, and the message gave no way
    // to tell WHICH session had been revealed — so there was nothing to check
    // against the tabs actually on screen. The id makes the claim falsifiable.
    console.log(
      ok(
        `Switched to live session: ${chalk.white(entry.name)} ` +
          chalk.dim(`(${entry.liveSessionId.slice(0, 8)})`),
      ),
    );
    return true;
  }
  console.error(warn(`Could not switch via AIBroker: ${result.error ?? "unknown error"}`));
  return false;
}

/**
 * Act on a matched catalog entry: switch to it, resume it, or start it.
 *
 * The third case is the one that was missing. A registered project whose
 * sessions have all ended matches by name perfectly well, but carries no
 * `diskSession`, and the old code simply ran off the end of both the exact and
 * the partial branch — past the picker, into a free-text search of prompt
 * history. So `pai Paperfull` answered a request to open a project with a list
 * of five old conversations that merely mentioned the word, while the project's
 * own directory was sitting in `entry.project` the whole time.
 *
 * Returns false only when there is genuinely nothing to open, which is the one
 * case where falling through to a history search is the right thing to do.
 */
async function openMatch(
  entry: UnifiedSession,
  allSessions: ScannedSession[],
  dryRun: boolean
): Promise<boolean> {
  if (entry.status === "live") {
    if (await doSwitch(entry, dryRun)) return true;
    // Switch failed — fall through and try to open it from disk instead.
  }
  if (entry.diskSession) {
    launchSession(entry.diskSession, allSessions, dryRun);
    return true;
  }
  if (entry.project && existsSync(entry.project)) {
    launchInDir(entry.project, entry.name, { dryRun });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export interface MainResolverOpts {
  auto?: boolean;    // -y / --auto: pick #1 without prompting
  dryRun?: boolean;  // --dry-run: show what would happen
  n?: string;        // --n <count>: max candidates for history search
  all?: boolean;     // --all: show cold / 0-session / archived projects too
}

function getRegisteredProjects(db: Database, all = false): RegisteredProject[] {
  try {
    const statusClause = all ? "" : "WHERE p.status = 'active'";
    return db
      .prepare(`
        SELECT
          p.slug,
          p.display_name,
          p.root_path,
          p.status,
          COUNT(s.id) AS session_count,
          MAX(s.created_at) AS last_active
        FROM projects p
        LEFT JOIN sessions s ON s.project_id = p.id
        ${statusClause}
        GROUP BY p.id
        ORDER BY last_active DESC NULLS LAST, p.updated_at DESC
      `)
      .all() as RegisteredProject[];
  } catch {
    return [];
  }
}

export async function cmdMain(
  db: Database,
  query: string | undefined,
  pickN: number | undefined,
  opts: MainResolverOpts
): Promise<void> {
  const maxResults = parseInt(opts.n ?? "20", 10);
  const showAll = opts.all ?? false;
  // Live sessions: metadata-only fetch (1s) — last-prompt fetch is too slow
  // (~8s for AppleScript per-session scrollback). For live entries, last-prompt
  // stays empty; user can `pai <name>` to switch into the tab and see context.
  const livePromise = !query
    ? fetchLiveSessions().catch(() => [] as Awaited<ReturnType<typeof fetchLiveSessions>>)
    : Promise.resolve([]);
  const allSessions = scanSessions(db, { limit: 500, filter: "named" });
  const registeredProjects = getRegisteredProjects(db, showAll);

  // -----------------------------------------------------------------------
  // Case 1: No query → deduped session listing (shared renderer)
  // -----------------------------------------------------------------------
  if (!query) {
    const liveSessions = await livePromise;
    const deduped = buildDeduped(liveSessions, allSessions, registeredProjects, showAll);
    renderDedupedSessions(deduped, showAll ? undefined : maxResults);
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
  // Case 3: Name match against deduped catalog (normalized + slug matching)
  // -----------------------------------------------------------------------
  {
    let liveSessions: Awaited<ReturnType<typeof fetchLiveSessions>> = [];
    try {
      liveSessions = await fetchLiveSessions();
    } catch {
      // AIBroker not running
    }

    const deduped = buildDeduped(liveSessions, allSessions, registeredProjects, showAll);
    // Normalize the query the same way we normalize session names
    // Also support slug form: "jobs-grazyna" → "jobs grazyna" for matching
    const qNorm = normalizeName(query).toLowerCase();
    const qSlug = query.toLowerCase().replace(/\s+/g, "-"); // words → slug form for slug lookup

    // Match helper: checks normalized display name AND slug
    const nameMatches = (e: UnifiedSession, q: string) =>
      e.name.toLowerCase() === q ||
      (e.slug !== undefined && e.slug.toLowerCase() === qSlug);
    const nameIncludes = (e: UnifiedSession, q: string) =>
      e.name.toLowerCase().includes(q) ||
      (e.slug !== undefined && e.slug.toLowerCase().includes(qSlug));

    // Exact normalized-name match first (display_name or slug)
    const exactMatch = deduped.find((e) => nameMatches(e, qNorm));
    if (exactMatch) {
      if (await openMatch(exactMatch, allSessions, opts.dryRun ?? false)) return;
    }

    // Partial normalized-name match (display_name or slug)
    const partialMatches = deduped.filter((e) => nameIncludes(e, qNorm));

    if (partialMatches.length === 1) {
      if (await openMatch(partialMatches[0], allSessions, opts.dryRun ?? false)) return;
    }

    if (partialMatches.length > 1) {
      // Multiple matches — show picker
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
          fmtUnifiedStatus(entry.status),
          age,
          project,
        ];
      });
      console.log(renderTable(headers, rows));
      console.log();

      const pickMatch = async (match: UnifiedSession) => {
        if (await openMatch(match, allSessions, opts.dryRun ?? false)) return;
        console.error(err(`Nothing to open for "${match.name}" — no live session, no transcript, no directory.`));
        process.exitCode = 1;
      };

      if (pickN !== undefined) {
        const idx = pickN - 1;
        if (idx >= 0 && idx < partialMatches.length) {
          await pickMatch(partialMatches[idx]);
          return;
        }
        console.error(err(`Invalid choice: ${pickN}`));
        process.exitCode = 1;
        return;
      }

      if (opts.auto) {
        await pickMatch(partialMatches[0]);
        return;
      }

      const choice = await askForChoice(Math.min(partialMatches.length, maxResults));
      if (choice !== null) {
        await pickMatch(partialMatches[choice - 1]);
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
    console.error(dim("  Try: pai  (no args) to see all sessions."));
    process.exitCode = 1;
    return;
  }

  process.stderr.write(dim(`  Searching prompt history for "${query}"...\n`));
  const matches = await searchHistory(query, maxResults);

  if (matches.length === 0) {
    console.log(warn(`No sessions found matching "${query}".`));
    console.log(dim("  Try a shorter or different search term."));
    console.log(dim("  Or run: ") + chalk.white("pai") + dim(" (no args) to see all sessions."));
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

  const launchHistoryMatch = (match: SessionMatch) => {
    const session = matchToSession(match, allSessions);
    if (!session) {
      console.error(err("Could not resolve session for launch (no project path)."));
      process.exitCode = 1;
      return;
    }
    launchSession(session, allSessions, opts.dryRun ?? false);
  };

  if (pickN !== undefined) {
    const idx = pickN - 1;
    if (idx >= 0 && idx < matches.length) {
      launchHistoryMatch(matches[idx]);
      return;
    }
    console.error(err(`Invalid choice: ${pickN}`));
    process.exitCode = 1;
    return;
  }

  if (opts.auto) {
    launchHistoryMatch(matches[0]);
    return;
  }

  const choice = await askForChoice(matches.length);
  if (choice !== null) {
    launchHistoryMatch(matches[choice - 1]);
  }
}
