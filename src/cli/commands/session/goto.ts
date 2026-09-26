/**
 * pai resume <name>  /  pai sessions goto <name>  [--dry-run]
 *
 * Smart session launcher with auto-fallback:
 *
 *   1. Resolve name → (uuid?, projectDir, friendlyName)
 *   2. chdir(projectDir)
 *   3. If uuid is set:
 *        a. Probe: is a transcript for <uuid> on disk under this cwd?
 *                  (see probeResume in lib/launch.ts — the filesystem answers,
 *                   and only an unrecognised layout falls back to spawning claude)
 *        b. If probe succeeds:
 *             exec  claude --resume <uuid> --name "<friendlyName>" "/Name <friendlyName>\ngo"
 *                  — through the provider the transcript ran on, when its model
 *                  matches one (providerResumePlan in lib/launch.ts)
 *        c. Else (probe failed):
 *             print clear stderr line: "Resume failed. Starting fresh session in same dir."
 *             exec  claude --name "<friendlyName>" "/Name <friendlyName>\ngo"
 *   4. Else (no uuid known):
 *        exec  claude --name "<friendlyName>" "/Name <friendlyName>\ngo"
 *
 * Steps 3 and 4 are launchInDir's, shared — this file no longer carries its
 * own copy of the spawn dance.
 *
 * Why both --name AND /Name?
 *   --name <friendlyName>       → sets Claude Code's internal session label
 *   "/Name <friendlyName>\ngo"  → runs the /Name slash command via AIBroker, which updates
 *                                  iTerm tab title, statusline, and AIBroker session registry;
 *                                  the \ngo on the next line triggers PAI's ## Continue resume
 *
 * The probe is two `existsSync` calls on the happy path. On the fallback path, total latency
 * is the same as a fresh start.
 */

import { realpathSync } from "node:fs";
import chalk from "chalk";
import { err } from "../../utils.js";
import {
  scanSessions,
  resolveSessionByNameOrId,
  fmtAge,
  type ScannedSession,
} from "../../lib/session-scan.js";
import {
  launchInDir,
  providerResumePlan,
  resumeArgvText,
} from "../../lib/launch.js";

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function cmdGoto(
  query: string,
  opts: { dryRun?: boolean; noName?: boolean; noGo?: boolean }
): Promise<void> {
  // ---- 1. Resolve name → session ----
  const allSessions = await scanSessions({ limit: 500, filter: "named" });

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
    process.exitCode = 1;
    return;
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
    process.exitCode = 1;
    return;
  }

  // ---- 4. Build argv components ----
  const name = friendlyName ?? query;

  // ---- 5. Dry-run mode ----
  if (opts.dryRun) {
    if (resumableUuid) {
      const plan = providerResumePlan(resumableUuid, projectDir);
      const argvResume = resumeArgvText(resumableUuid, name, plan);
      const argvFresh = `claude --name "${name}" "/Name ${name}\\ngo"`;
      console.log(
        "\n" + chalk.bold("Dry run — would probe then exec (RESUME path):") + "\n"
      );
      console.log(`  cwd:      ${chalk.cyan(projectDir)}`);
      console.log(`  probe:    claude --resume ${resumableUuid} --print --output-format=json "_"`);
      if (plan) {
        console.log(`  route:    ${plan.provider} (${plan.model})`);
      }
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
  // The whole probe → resume → fresh-fallback dance lives in launchInDir and
  // nowhere else. This file carried a near-verbatim copy of it, which is how
  // probeResume was once fixed in one copy while `pai resume <name>` kept the
  // bug. `engine: "claude"` keeps goto's fresh paths exactly what they were —
  // plain claude, no worker routing — while the resume inherits the provider
  // the transcript actually ran on.
  launchInDir(projectDir, name, { resumableUuid, engine: "claude" });
}
