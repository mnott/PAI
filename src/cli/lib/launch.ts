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
import { realpathSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { err } from "../utils.js";
import { printExitDir } from "./exit-dir.js";

export interface ProbeResult {
  ok: boolean;
  reason?: string;
}

/**
 * Does a transcript for this session exist on disk?
 *
 * Returns true/false when it can tell, and null when it cannot — the caller
 * must treat null as "ask something else", never as "no". A path this function
 * fails to recognise would otherwise silently veto a perfectly good resume.
 *
 * Claude Code stores transcripts at ~/.claude/projects/<encoded-cwd>/, where the
 * encoding replaces every non-alphanumeric character with `-`. Finished sessions
 * are moved into a `sessions/` subdirectory by the stop hook, so both are checked.
 */
function transcriptOnDisk(uuid: string, cwd: string): boolean | null {
  try {
    const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-");
    const dir = join(homedir(), ".claude", "projects", encoded);
    if (!existsSync(dir)) return null; // unknown layout — not evidence of absence
    return (
      existsSync(join(dir, `${uuid}.jsonl`)) ||
      existsSync(join(dir, "sessions", `${uuid}.jsonl`))
    );
  } catch {
    return null;
  }
}

/**
 * Probe whether a session UUID is resumable from `cwd`.
 *
 * The filesystem is asked first, and usually answers.
 *
 * This used to run `claude --resume <uuid> --print --output-format=json "_"`
 * with a 5s timeout, which is not a probe: it resumes the session AND sends a
 * prompt to the model, then waits for a complete JSON reply. That costs a model
 * round-trip per probe, and 5s is not enough time for one — for a LARGE session
 * least of all, because the transcript has to be loaded first.
 *
 * So the check failed precisely for the sessions most worth resuming, and the
 * caller's fallback quietly started a fresh session in their place. Observed
 * 2026-08-04: `pai Paperfull` reported `spawn error: spawnSync claude ETIMEDOUT`
 * for fb76a6c3 and started over, while
 * `~/.claude/projects/…-Paperfull/sessions/fb76a6c3-….jsonl` sat on disk the
 * whole time.
 *
 * A transcript on disk is what resumable MEANS, and reading a directory entry is
 * free. The spawn remains only for the case the filesystem cannot answer, and
 * now gets a timeout that a real answer can fit inside.
 */
export function probeResume(uuid: string, cwd: string): ProbeResult {
  const onDisk = transcriptOnDisk(uuid, cwd);
  if (onDisk === true) return { ok: true };
  if (onDisk === false) return { ok: false, reason: "No transcript on disk for this UUID" };

  const result = spawnSync(
    "claude",
    ["--resume", uuid, "--print", "--output-format=json", "_"],
    { cwd, timeout: 30_000, env: process.env, stdio: ["ignore", "ignore", "pipe"] }
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
