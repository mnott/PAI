/**
 * pai resume <name>  /  pai sessions goto <name>  [--dry-run]
 *
 * Smart session launcher with auto-fallback:
 *
 *   1. Resolve name → (uuid?, projectDir, friendlyName)
 *   2. chdir(projectDir)
 *   3. If uuid is set:
 *        a. Probe: claude --resume <uuid> --print --output-format=json "_"
 *                  (timeout 5s; exits non-zero / logs "No conversation found" if invalid)
 *        b. If probe succeeds:
 *             exec  claude --resume <uuid> --name "<friendlyName>" "/Name <friendlyName>\ngo"
 *        c. Else (probe failed):
 *             print clear stderr line: "Resume failed. Starting fresh session in same dir."
 *             exec  claude --name "<friendlyName>" "/Name <friendlyName>\ngo"
 *   4. Else (no uuid known):
 *        exec  claude --name "<friendlyName>" "/Name <friendlyName>\ngo"
 *
 * Why both --name AND /Name?
 *   --name <friendlyName>       → sets Claude Code's internal session label
 *   "/Name <friendlyName>\ngo"  → runs the /Name slash command via AIBroker, which updates
 *                                  iTerm tab title, statusline, and AIBroker session registry;
 *                                  the \ngo on the next line triggers PAI's ## Continue resume
 *
 * The probe adds ~300ms on the happy path. On the fallback path, total latency is the same
 * as a fresh start.
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
import { printExitDir } from "../../lib/exit-dir.js";

// ---------------------------------------------------------------------------
// Probe helper
// ---------------------------------------------------------------------------

interface ProbeResult {
  ok: boolean;
  reason?: string;
}

/**
 * Run  claude --resume <uuid> --print --output-format=json "_"  in the given cwd.
 * Returns ok=true if the session is resumable (exit 0 and no "No conversation found"
 * in stderr).  Timeout: 5 seconds.
 */
function probeResume(uuid: string, cwd: string): ProbeResult {
  const result = spawnSync(
    "claude",
    ["--resume", uuid, "--print", "--output-format=json", "_"],
    {
      cwd,
      timeout: 5_000,
      env: process.env,
      // Capture stderr for inspection; suppress stdout (tty)
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
// Command
// ---------------------------------------------------------------------------

export function cmdGoto(
  db: Database,
  query: string,
  opts: { dryRun?: boolean }
): void {
  // ---- 1. Resolve name → session ----
  const allSessions = scanSessions(db, { limit: 500, filter: "named" });

  let resolved;
  try {
    resolved = resolveSessionByNameOrId(allSessions, query);
  } catch (resolveErr) {
    let msg = String(resolveErr).replace(/^Error: /, "");
    // Append pai find suggestion for "not found" errors
    if (msg.includes("No session found matching")) {
      msg += `\n\nTip: pai find "${query}"  — search prompt history by keywords`;
    }
    console.error(err(msg));
    process.exit(1);
  }

  const { session: matchedSession, friendlyName } = resolved;

  // ---- 2. Find best resumable UUID for this project ----
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

  // ---- 3. Determine project dir (realpathSync for --resume cwd correctness) ----
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

  // ---- 4. Build argv components ----
  const name = friendlyName ?? query;
  // Initial prompt: /Name sets tab/statusline via AIBroker; \ngo triggers ## Continue
  const promptArg = `/Name ${name}\ngo`;

  // ---- 5. Dry-run mode ----
  if (opts.dryRun) {
    if (resumableUuid) {
      const argvResume = `claude --resume ${resumableUuid} --name "${name}" "/Name ${name}\\ngo"`;
      const argvFresh = `claude --name "${name}" "/Name ${name}\\ngo"`;
      console.log(
        "\n" + chalk.bold("Dry run — would probe then exec (RESUME path):") + "\n"
      );
      console.log(`  cwd:      ${chalk.cyan(projectDir)}`);
      console.log(`  probe:    claude --resume ${resumableUuid} --print --output-format=json "_"`);
      console.log(`  argv:     ${chalk.white(argvResume)}`);
      console.log(`  fallback: ${chalk.yellow(argvFresh)}`);
      if (resumableSession) {
        console.log(`\n  uuid:     ${resumableSession.uuid}`);
        console.log(`  age:      ${fmtAge(resumableSession.mtime)}`);
        console.log(`  status:   ${resumableSession.sessionStatus}`);
        console.log(`  sys:      ${resumableSession.topLevelSystemLines} system lines`);
      }
    } else {
      const argvFresh = `claude --name "${name}" "/Name ${name}\\ngo"`;
      console.log(
        "\n" + chalk.bold("Dry run — would exec (FRESH path, no resumable UUID):") + "\n"
      );
      console.log(`  cwd:   ${chalk.cyan(projectDir)}`);
      console.log(`  argv:  ${chalk.white(argvFresh)}`);
    }
    console.log();
    return;
  }

  // ---- 6. Live execution ----
  if (resumableUuid) {
    // Probe first
    const probe = probeResume(resumableUuid, projectDir);

    if (probe.ok) {
      // Happy path: session is resumable
      const result = spawnSync(
        "claude",
        ["--resume", resumableUuid, "--name", name, promptArg],
        {
          cwd: projectDir,
          stdio: "inherit",
          env: process.env,
        }
      );
      if (result.error) {
        console.error(err(`Failed to launch claude: ${result.error.message}`));
        process.exit(1);
      }
      printExitDir(projectDir);
      process.exit(result.status ?? 0);
    } else {
      // Fallback path
      process.stderr.write(
        chalk.yellow(
          `\n  Resume failed for ${resumableUuid.slice(0, 8)}: ${probe.reason ?? "unknown error"}\n` +
            `  Starting fresh session in same directory.\n\n`
        )
      );
      const result = spawnSync(
        "claude",
        ["--name", name, promptArg],
        {
          cwd: projectDir,
          stdio: "inherit",
          env: process.env,
        }
      );
      if (result.error) {
        console.error(err(`Failed to launch claude: ${result.error.message}`));
        process.exit(1);
      }
      printExitDir(projectDir);
      process.exit(result.status ?? 0);
    }
  } else {
    // No UUID at all — fresh start
    const result = spawnSync(
      "claude",
      ["--name", name, promptArg],
      {
        cwd: projectDir,
        stdio: "inherit",
        env: process.env,
      }
    );
    if (result.error) {
      console.error(err(`Failed to launch claude: ${result.error.message}`));
      process.exit(1);
    }
    printExitDir(projectDir);
    process.exit(result.status ?? 0);
  }
}
