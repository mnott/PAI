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
import {
  realpathSync,
  existsSync,
  linkSync,
  copyFileSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
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
 * Put a transcript back where `claude --resume` looks for it.
 *
 * `claude --resume <uuid>` reads ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl
 * and ONLY that path. A copy under `sessions/` is invisible to it — measured
 * 2026-08-04, both directions:
 *
 *   b3462801  867 KB, sessions/ only  → "No conversation found with session ID"
 *   a9ecdc1c  top level               → found
 *
 * Location is one of two factors, and this function addresses that one. PAI
 * displaced these files itself, from FOUR movers — a SessionStart hook, a
 * UserPromptSubmit hook, the stop hook, and the work-queue worker — of which
 * the UserPromptSubmit one did most of the damage, because it ran on every
 * prompt of every session and excluded only the caller's own transcript. All
 * four now hardlink (project-utils/paths.ts). So this restores a file PAI
 * displaced rather than inventing a layout Claude Code does not use.
 *
 * The other factor is content, and no amount of relinking helps there — see
 * `hasConversation`.
 *
 * A hard link is preferred over a copy: same inode, no second megabyte on disk,
 * and the archive under `sessions/` keeps working for everything that reads it.
 * Returns whether the top-level path exists afterwards.
 */
export function restoreTopLevel(uuid: string, dir: string): boolean {
  const topLevel = join(dir, `${uuid}.jsonl`);
  if (existsSync(topLevel)) return true;

  const archived = join(dir, "sessions", `${uuid}.jsonl`);
  if (!existsSync(archived)) return false;

  try {
    linkSync(archived, topLevel);
    return true;
  } catch {
    try {
      copyFileSync(archived, topLevel);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Does this transcript hold an exchange, or only session metadata?
 *
 * The second reason `claude --resume` says "No conversation found": the file is
 * there and readable and still holds no conversation. Measured 2026-08-04 on
 * 046bb712 — 537 bytes of last-prompt, custom-title, agent-name, mode and
 * permission-mode, no user line, no assistant line. It was restored to the top
 * level, verified same-inode, and still refused. It was never resumable, and
 * relinking cannot make it so. 30 of PAI's own 50 displaced transcripts are
 * this shape, one of them 745 KB — size proves nothing, because hook context
 * attachments are large.
 *
 * This scans the WHOLE file, and a bounded head will not do. It is tempting —
 * "a real session's first assistant line lands within the first few KB" — and
 * it is false. Measured on b3462801, a session `claude --resume` accepts:
 *
 *   file size            866953
 *   length of LINE 1     762977      <- one hook context attachment
 *   first "type":"user"     766830
 *
 * The first exchange sits past 766 KB because line 1 is a single enormous
 * attachment blob. Any head shorter than that reports a 867 KB working session
 * as an empty stub, which is the exact false negative this function exists to
 * prevent — and it is the shape that produced today's whole incident.
 *
 * Chunked so that a large transcript costs a scan rather than a resident copy,
 * with an overlap so the marker cannot hide across a chunk boundary. Reading a
 * few MB to answer a question about resumability is cheap; being wrong is not.
 *
 * Unreadable counts as real. Claiming a session is empty when it cannot be
 * inspected would talk the caller out of a resume that might have worked.
 */
const CONVERSATION_MARKERS = ['"type":"assistant"', '"type": "assistant"', '"type":"user"', '"type": "user"'];
const OVERLAP = 32; // > longest marker, so none can straddle two chunks

export function hasConversation(path: string, chunkBytes = 1 << 20): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(chunkBytes);
    let carry = "";
    let pos = 0;

    for (;;) {
      const read = readSync(fd, buf, 0, chunkBytes, pos);
      if (read <= 0) return false;
      pos += read;

      const text = carry + buf.subarray(0, read).toString("utf8");
      if (CONVERSATION_MARKERS.some((m) => text.includes(m))) return true;
      carry = text.slice(-OVERLAP);
    }
  } catch {
    return true;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* nothing useful to do */
      }
    }
  }
}

/**
 * Can this session be resumed — and if the only thing standing in the way is
 * where its transcript sits, put it back so that the answer is yes.
 *
 * Returns true/false when it can tell, and null when it cannot — the caller
 * must treat null as "ask something else", never as "no". A path this function
 * fails to recognise would otherwise silently veto a perfectly good resume.
 *
 * Claude Code stores transcripts at ~/.claude/projects/<encoded-cwd>/, where the
 * encoding replaces every non-alphanumeric character with `-`.
 */
function transcriptOnDisk(
  uuid: string,
  cwd: string,
  home = homedir()
): true | "missing" | "stub" | null {
  try {
    const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-");
    const dir = join(home, ".claude", "projects", encoded);
    if (!existsSync(dir)) return null; // unknown layout — not evidence of absence
    if (!restoreTopLevel(uuid, dir)) return "missing";
    // Present is not the same as resumable. A metadata stub survives every
    // location check and still fails at `claude --resume`, and this probe is the
    // only thing standing between that and a caller that exits on the failure
    // instead of falling back to a fresh session.
    return hasConversation(join(dir, `${uuid}.jsonl`)) ? true : "stub";
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
 *
 * "On disk" had to be tightened once. It first accepted a transcript sitting
 * only under `sessions/`, which claude --resume does not read — so the probe
 * swapped a 5s false negative for a confident false positive, and the caller
 * spawned a resume that died with "No conversation found" instead of falling
 * back to a fresh session. `restoreTopLevel` is what makes the permissive
 * reading true rather than merely optimistic.
 */
export function probeResume(uuid: string, cwd: string, home?: string): ProbeResult {
  const onDisk = transcriptOnDisk(uuid, cwd, home);
  if (onDisk === true) return { ok: true };
  if (onDisk === "missing") {
    return { ok: false, reason: "No transcript on disk for this UUID" };
  }
  if (onDisk === "stub") {
    // Say which of the two it is. "No conversation found" from claude tells the
    // user nothing about whether a repair might help; this does.
    return { ok: false, reason: "Transcript holds only session metadata — no conversation to resume" };
  }

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
      console.log(`  probe:    transcript on disk for ${opts.resumableUuid!.slice(0, 8)}?`);
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
