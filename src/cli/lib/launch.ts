/**
 * launch.ts — Launch Claude Code in a directory, in the CURRENT terminal.
 *
 * Shared by the interactive picker (pick.ts). Deliberately does NOT switch
 * iTerm tabs (aibroker_switch): switching jumps the user to a different — and
 * sometimes wrong — terminal, which is confusing. Picking a place should start
 * a session right here, in the chosen directory.
 *
 * Behaviour:
 *   resume-or-fresh  → if a resumable UUID is given, probe it; on success
 *                      `claude --resume`, otherwise fall back to a fresh session
 *                      in the same dir. With no UUID, start fresh.
 *
 * The `claude` child inherits the tty (stdio: "inherit"), so the session runs
 * in the terminal that launched `pai`. On exit we print the working directory.
 */

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import chalk from "chalk";
import { err } from "../utils.js";
import { printExitDir } from "./exit-dir.js";

export interface ProbeResult {
  ok: boolean;
  reason?: string;
}

/**
 * Probe whether a session UUID is resumable from `cwd` (5s timeout).
 * Mirrors the probe in goto.ts / main-resolver.ts.
 */
export function probeResume(uuid: string, cwd: string): ProbeResult {
  const result = spawnSync(
    "claude",
    ["--resume", uuid, "--print", "--output-format=json", "_"],
    { cwd, timeout: 5_000, env: process.env, stdio: ["ignore", "ignore", "pipe"] }
  );

  if (result.error) return { ok: false, reason: `spawn error: ${result.error.message}` };

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

export interface LaunchOpts {
  /** If set, try to resume this session before falling back to fresh. */
  resumableUuid?: string;
  /** Skip the resume probe and start a brand-new session in the dir. */
  forceFresh?: boolean;
  /** Print what would happen, then return without launching. */
  dryRun?: boolean;
}

/**
 * Launch `claude` in `dir` in the current terminal. `name` is used for both the
 * Claude session label (--name) and the /Name slash command (tab/statusline).
 * Never returns on the live path — it exits the process after claude exits.
 */
export function launchInDir(dir: string, name: string, opts: LaunchOpts = {}): void {
  let cwd: string;
  try {
    cwd = realpathSync(dir);
  } catch {
    console.error(
      err(
        `Directory does not exist or cannot be resolved:\n  ${dir}\n` +
          `  The folder may have moved or been deleted.`
      )
    );
    process.exit(1);
    return;
  }

  const promptArg = `/Name ${name}\ngo`;
  const wantResume = !opts.forceFresh && !!opts.resumableUuid;

  if (opts.dryRun) {
    if (wantResume) {
      console.log("\n" + chalk.bold("Dry run — would probe then exec (RESUME path):") + "\n");
      console.log(`  cwd:      ${chalk.cyan(cwd)}`);
      console.log(`  probe:    claude --resume ${opts.resumableUuid} --print --output-format=json "_"`);
      console.log(`  argv:     claude --resume ${opts.resumableUuid} --name "${name}" "/Name ${name}\\ngo"`);
      console.log(`  fallback: claude --name "${name}" "/Name ${name}\\ngo"`);
    } else {
      console.log("\n" + chalk.bold("Dry run — would exec (FRESH path):") + "\n");
      console.log(`  cwd:  ${chalk.cyan(cwd)}`);
      console.log(`  argv: claude --name "${name}" "/Name ${name}\\ngo"`);
    }
    console.log();
    return;
  }

  const fresh = () => {
    const result = spawnSync("claude", ["--name", name, promptArg], {
      cwd,
      stdio: "inherit",
      env: process.env,
    });
    if (result.error) {
      console.error(err(`Failed to launch claude: ${result.error.message}`));
      process.exit(1);
    }
    printExitDir(cwd);
    process.exit(result.status ?? 0);
  };

  if (wantResume) {
    const probe = probeResume(opts.resumableUuid!, cwd);
    if (probe.ok) {
      const result = spawnSync(
        "claude",
        ["--resume", opts.resumableUuid!, "--name", name, promptArg],
        { cwd, stdio: "inherit", env: process.env }
      );
      if (result.error) {
        console.error(err(`Failed to launch claude: ${result.error.message}`));
        process.exit(1);
      }
      printExitDir(cwd);
      process.exit(result.status ?? 0);
    }
    process.stderr.write(
      chalk.yellow(
        `\n  Resume failed for ${opts.resumableUuid!.slice(0, 8)}: ${probe.reason ?? "unknown error"}\n` +
          `  Starting fresh session in same directory.\n\n`
      )
    );
    fresh();
    return;
  }

  fresh();
}
