/**
 * pai session goto <name-or-id> [--no-name] [--no-go] [--dry-run]
 *
 * Smart session launcher:
 *   - Resolves the name across ALL named sessions (clc registry + resumable).
 *   - If a resumable UUID is found for the matching project:
 *       claude --resume <uuid> "/Name <friendlyName>\ngo"
 *   - Else (project exists but no resumable session):
 *       claude "/Name <friendlyName>\ngo"   — fresh session, same project dir
 *   - If the name cannot be resolved at all, exits with an error.
 *
 * Prompt arg mechanic (mirrors clc's combined_prompt):
 *   The initial-prompt positional is ONE string. It contains:
 *     /Name <friendlyName>\ngo
 *   where \n is a real newline. The /Name sets the session chrome; the "go"
 *   on the next line triggers PAI's session-commands hook (## Continue resume).
 *
 *   Use --no-name to skip the /Name prefix (omits name restoration).
 *   Use --no-go  to skip the trailing "go" (no auto-resume trigger).
 *   Use both to pass no initial prompt at all.
 *
 * cwd mechanic:
 *   Claude Code resolves symlinks before encoding the project dir. We must
 *   realpathSync() the directory so the encoding matches and --resume works.
 *   Priority: clcDirectory → registryRootPath → decodedPath (all realpathSync'd).
 */

import type { Database } from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import chalk from "chalk";
import { err } from "../../utils.js";
import {
  scanSessions,
  resolveSessionByNameOrId,
  fmtAge,
  type ScannedSession,
} from "../../lib/session-scan.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1_048_576) return `${Math.round(bytes / 1024)}K`;
  return `${(bytes / 1_048_576).toFixed(1)}M`;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export function cmdGoto(
  db: Database,
  query: string,
  opts: { noName?: boolean; noGo?: boolean; dryRun?: boolean }
): void {
  // Scan all named sessions (resumable + stubs + transcript-only from clc registry).
  const allSessions = scanSessions(db, { limit: 500, filter: "named" });

  let resolved;
  try {
    resolved = resolveSessionByNameOrId(allSessions, query);
  } catch (resolveErr) {
    console.error(err(String(resolveErr).replace(/^Error: /, "")));
    process.exit(1);
  }

  const { session: matchedSession, friendlyName } = resolved;

  // If the matched session itself is resumable, use it directly.
  // Otherwise, look for another resumable session in the same encodedDir.
  let resumableUuid: string | undefined;
  let resumableSession: ScannedSession | undefined;

  if (matchedSession.resumable) {
    resumableUuid = matchedSession.uuid;
    resumableSession = matchedSession;
  } else if (matchedSession.encodedDir) {
    // Find the most-recently-modified resumable session in the same project dir
    const sameProject = allSessions.filter(
      (s) => s.encodedDir === matchedSession.encodedDir && s.resumable
    );
    sameProject.sort((a, b) => b.mtime - a.mtime);
    if (sameProject.length > 0) {
      resumableSession = sameProject[0];
      resumableUuid = resumableSession.uuid;
    }
  }

  // Determine cwd for claude.
  // Priority: clcDirectory → registryRootPath → decodedPath, all realpathSync'd.
  // If realpathSync throws (directory moved/deleted), error with a clear message.
  const rawDir =
    matchedSession.clcDirectory ??
    matchedSession.registryRootPath ??
    matchedSession.decodedPath;

  let projectDir: string;
  try {
    projectDir = realpathSync(rawDir);
  } catch {
    console.error(
      err(
        `session "${query}": directory does not exist or cannot be resolved.\n` +
          `  Registry says: ${rawDir}\n` +
          `  The directory may have moved or been deleted.`
      )
    );
    process.exit(1);
  }

  // Build the initial-prompt arg.
  // Structure:  /Name <friendlyName>\ngo
  //   - /Name part: only when --no-name is NOT set AND friendlyName is known
  //   - go part:    only when --no-go is NOT set
  //   - If both parts absent: no prompt arg at all
  const useName = !opts.noName && !!friendlyName;
  const useGo = !opts.noGo;

  let promptArg: string | null = null;
  if (useName && friendlyName) {
    promptArg = useGo ? `/Name ${friendlyName}\ngo` : `/Name ${friendlyName}`;
  } else if (useGo) {
    promptArg = "go";
  }

  const fullArgv: string[] = resumableUuid
    ? ["claude", "--resume", resumableUuid, ...(promptArg ? [promptArg] : [])]
    : ["claude", ...(promptArg ? [promptArg] : [])];

  if (opts.dryRun) {
    const mode = resumableUuid ? "RESUME" : "FRESH";
    console.log("\n" + chalk.bold(`Dry run — would execute (${mode}):`) + "\n");
    console.log(`  cwd:            ${chalk.cyan(projectDir)}`);
    // Show the prompt arg with \n escaped for readability
    const argDisplay = fullArgv
      .map((a) =>
        a.includes("\n") ? `"${a.replace(/\n/g, "\\n")}"` : a.startsWith("/Name") ? `"${a}"` : a
      )
      .join(" ");
    console.log(`  argv:           ${chalk.white(argDisplay)}`);
    if (useName && friendlyName) {
      console.log(`  name:           ${chalk.green(friendlyName)}`);
    }
    if (resumableSession) {
      console.log(`\n  session:        ${resumableSession.uuid}`);
      console.log(`  age:            ${fmtAge(resumableSession.mtime)}`);
      console.log(`  system lines:   ${resumableSession.topLevelSystemLines}`);
      console.log(
        `  user msgs:      ${resumableSession.userLines > 0 ? resumableSession.userLines : "—"}`
      );
    } else {
      console.log(
        `\n  mode:           ${chalk.yellow("fresh session (no resumable snapshot)")}`
      );
    }
    console.log(`  project path:   ${matchedSession.decodedPath}`);
    console.log();
    return;
  }

  // Replace current process with claude
  const result = spawnSync(fullArgv[0], fullArgv.slice(1), {
    cwd: projectDir,
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    console.error(err(`Failed to launch claude: ${result.error.message}`));
    process.exit(1);
  }

  process.exit(result.status ?? 0);
}
