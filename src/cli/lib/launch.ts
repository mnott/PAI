/**
 * launch.ts — Launch Claude Code in a directory, in the CURRENT terminal.
 *
 * Shared by the interactive picker (pick.ts). Deliberately does NOT switch
 * iTerm tabs (aibroker_switch): switching jumps the user to a different — and
 * sometimes wrong — terminal, which is confusing. Picking a place should start
 * a session right here, in the chosen directory.
 *
 * Behaviour:
 *   engine           → fresh launches follow the workers config: routing on
 *                      starts an interactive `pai worker run` (the glm-shim
 *                      shape) instead of claude. `engine` in opts forces one;
 *                      resume always stays the claude binary.
 *   resume-or-fresh  → if a resumable UUID is given, probe it; on success
 *                      `claude --resume` — through the provider the transcript
 *                      ran on, when its model matches one (providerResumePlan),
 *                      plain otherwise — else fall back to a fresh session in
 *                      the same dir. With no UUID, start fresh.
 *
 * The `claude` child inherits the tty (stdio: "inherit"), so the session runs
 * in the terminal that launched `pai`. On exit we print the working directory.
 */

import { spawnSync } from "node:child_process";
import {
  realpathSync,
  existsSync,
  fstatSync,
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
import { readWorkersSection, type WorkersConfig, type WorkerProvider } from "../../workers/config.js";
import { buildRunEnv, claudeCommand } from "../../workers/run-env.js";
import { stripModelVariant } from "../../utils/model-window.js";
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
function encodedProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function transcriptOnDisk(
  uuid: string,
  cwd: string,
  home = homedir()
): true | "missing" | "stub" | null {
  try {
    const dir = join(home, ".claude", "projects", encodedProjectDir(cwd));
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

// ---------------------------------------------------------------------------
// Provider-aware resume
// ---------------------------------------------------------------------------

/** Tail of a transcript that is enough to name its model: the last assistant
 *  entry sits at the end, and 64 KB covers several whole entries. */
const TRANSCRIPT_TAIL_BYTES = 64 * 1024;

/**
 * The model a transcript actually ran on: the `message.model` of its LAST
 * assistant entry, read from a bounded tail of the JSONL. Null when the file
 * is unreadable, empty, or holds no assistant entry.
 *
 * Why this exists: sessions started through the worker path run on a
 * configured provider, but `claude --resume` with the unmodified environment
 * comes up on the Anthropic login — the session silently flips provider on
 * resume. This is the detection half of the fix.
 */
export function lastTranscriptModel(transcriptPath: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(transcriptPath, "r");
    const { size } = fstatSync(fd);
    const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
    const len = size - start;
    if (len <= 0) return null;
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    const lines = buf.toString("utf8").split("\n");
    // A tail cut mid-line leaves a fragment at the head of the chunk; walk
    // from the end and skip anything that does not parse as an assistant
    // entry — an earlier complete entry names the model just as well.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let entry: { type?: unknown; message?: { model?: unknown } };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry?.type === "assistant" && typeof entry.message?.model === "string" && entry.message.model) {
        return entry.message.model;
      }
    }
    return null;
  } catch {
    return null;
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

/** Which model a session's transcript ran on, wherever PAI's archivers left
 *  it (top level first, then sessions/). Null when neither answers. */
export function transcriptModelFor(
  uuid: string,
  encodedDir: string,
  home = homedir()
): string | null {
  const dir = join(home, ".claude", "projects", encodedDir);
  for (const p of [join(dir, `${uuid}.jsonl`), join(dir, "sessions", `${uuid}.jsonl`)]) {
    if (!existsSync(p)) continue;
    const model = lastTranscriptModel(p);
    if (model) return model;
  }
  return null;
}

export interface TranscriptProviderMatch {
  /** Configured provider whose model table names the transcript's model. */
  provider: string;
  /** Model id as the transcript recorded it — variant suffix kept ("glm-5.3[1m]"). */
  model: string;
}

/**
 * Which configured provider a transcript's model belongs to, or null.
 *
 * The comparison strips the bracketed variant suffix on BOTH sides (the same
 * normalization the statusline context window uses): a session records
 * "glm-5.3" while the provider table says "glm-5.3[1m]" — same model, one
 * names its context window. Anthropic-login transcripts match nothing (the
 * built-in anthropic provider is synthetic and never in the table), which is
 * the point: they resume exactly as before.
 *
 * ponytail: protocol "openai" providers are skipped — their resume needs the
 * local PAI proxy, an async daemon bring-up launchInDir cannot do; they fall
 * back to the plain claude resume (today's behaviour). Add the proxy wait if
 * an openai-protocol provider ever needs interactive resume.
 */
export function matchTranscriptProvider(
  model: string | null,
  providers: Record<string, WorkerProvider>
): TranscriptProviderMatch | null {
  if (!model) return null;
  const base = stripModelVariant(model);
  for (const [name, p] of Object.entries(providers)) {
    if (!p.enabled || p.native || p.protocol !== "anthropic") continue;
    if (Object.values(p.models).some((m) => !!m && stripModelVariant(m) === base)) {
      return { provider: name, model };
    }
  }
  return null;
}

export interface ProviderResumePlan {
  provider: string;
  model: string;
  /** argv head from claudeCommand: the route is pinned in --settings so a
   *  machine-wide proxy cannot override the provider's base URL. */
  cmd: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * The spawn a resume needs when its transcript ran on a configured provider:
 * the SAME env the worker engine builds for an interactive run (run-env.ts,
 * imported — never copied; a duplicated provider-env builder is the known
 * bite-pattern here), plus the claude argv head that pins the route. Null
 * when no provider matches — the caller resumes exactly as before.
 *
 * No `--model`, deliberately: an interactive worker run passes none either
 * (modelFlagArgs, run.ts), so the settings.json model — e.g. the [1m]
 * variant — applies, and buildRunEnv's ANTHROPIC_DEFAULT_*_MODEL pins the
 * capability tiers to the provider's table.
 */
export function providerResumePlan(
  uuid: string,
  cwd: string,
  workers?: Pick<WorkersConfig, "providers" | "caveman">,
  home = homedir()
): ProviderResumePlan | null {
  let w = workers;
  if (!w) {
    try {
      w = readWorkersSection().workers;
    } catch {
      return null; // a broken workers config degrades to the plain resume
    }
  }
  const match = matchTranscriptProvider(
    transcriptModelFor(uuid, encodedProjectDir(cwd), home),
    w.providers
  );
  if (!match) return null;
  const env = buildRunEnv(w.providers[match.provider], false);
  return { ...match, cmd: claudeCommand(env, w.caveman), env };
}

/** Provider match for a session the scanner already located (uuid + its
 *  encoded projects dir), reading the workers config itself. Null on no
 *  match — or a broken config, which must never break the offer. */
export function transcriptProviderFor(
  uuid: string,
  encodedDir: string,
  home = homedir()
): TranscriptProviderMatch | null {
  try {
    return matchTranscriptProvider(
      transcriptModelFor(uuid, encodedDir, home),
      readWorkersSection().workers.providers
    );
  } catch {
    return null;
  }
}

/**
 * The resume offer line, naming the destination when it is known, so the
 * operator can see the resume will come up on glm (glm-5.3[1m]) rather than
 * silently flipping to the Anthropic login. The caller appends "[y/N]".
 */
export function resumeOfferText(match: TranscriptProviderMatch | null): string {
  return match ? `Resume into ${match.model} (${match.provider})?` : "Resume?";
}

/** Display form of the resume argv — shared by the dry-run paths so they
 *  cannot drift from what launchInDir actually spawns. */
export function resumeArgvText(uuid: string, name: string, plan: ProviderResumePlan | null): string {
  return `${(plan ? plan.cmd : ["claude"]).join(" ")} --resume ${uuid} --name "${name}" "/Name ${name}\\ngo"`;
}

export interface LaunchOpts {
  /** If set, try to resume this session before falling back to fresh. */
  resumableUuid?: string;
  /** Skip the resume probe and start a brand-new session in the dir. */
  forceFresh?: boolean;
  /** Print what would happen, then return without launching. */
  dryRun?: boolean;
  /** "auto" follows the workers config; "worker"/"claude" force one engine. */
  engine?: "auto" | "worker" | "claude";
}

/** Which engine a launch runs on, and whether it resumes. */
export interface LaunchRoute {
  engine: "worker" | "claude";
  resume: boolean;
}

/**
 * Decide the engine for a launch. "auto" mirrors the gate the Agent-routing
 * hook uses, so picker and hook never disagree about whether routing is on.
 * An explicit engine wins outright — the picker w/a keys rely on that.
 *
 * Resume stays claude even under a provider: `pai worker run` always starts
 * fresh, so a claude transcript has nothing to resume on. The provider
 * default therefore applies to fresh launches only — a wanted resume pins
 * the engine to claude unless engine "worker" is forced, which drops the
 * resume outright.
 */
export function resolveLaunchRoute(
  workers: Pick<WorkersConfig, "enabled" | "active" | "providers">,
  opts: LaunchOpts
): LaunchRoute {
  const routingOn =
    workers.enabled &&
    workers.active !== null &&
    Object.keys(workers.providers).length > 0;
  const wantsResume = !opts.forceFresh && !!opts.resumableUuid;
  const engine: "worker" | "claude" =
    opts.engine === "worker" ||
    (opts.engine !== "claude" && routingOn && !wantsResume)
      ? "worker"
      : "claude";
  return { engine, resume: engine === "claude" && wantsResume };
}

/**
 * `/Name` labels the tab/statusline through AIBroker; `go` reads the
 * TODO.md handover. Shared by both the claude and worker launch paths.
 */
export function launchPrompt(name: string): string {
  return `/Name ${name}\ngo`;
}

/**
 * Interactive worker run. Like the claude path, it carries `--name` and the
 * opening prompt — `pai worker run` is declared with `.allowUnknownOption`,
 * so both pass straight through to claude. Without them, this path left
 * every fresh session unnamed and the operator typed /Name by hand.
 */
export function workerRunArgv(label: string, cwd: string): string[] {
  return ["worker", "run", "--label", label, "--cwd", cwd, "--name", label, launchPrompt(label)];
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
    process.exitCode = 1;
    return;
  }

  const promptArg = launchPrompt(name);

  // A broken workers config must degrade to claude, never crash the picker.
  let workers: Pick<WorkersConfig, "enabled" | "active" | "providers" | "caveman"> = {
    enabled: false,
    active: null,
    providers: {},
    caveman: false,
  };
  try {
    workers = readWorkersSection().workers;
  } catch {
    /* routing stays off for this launch */
  }
  const route = resolveLaunchRoute(workers, opts);
  const wantResume = route.resume;

  if (opts.dryRun) {
    if (route.engine === "worker") {
      console.log("\n" + chalk.bold("Dry run — would exec (WORKER path):") + "\n");
      console.log(`  cwd:  ${chalk.cyan(cwd)}`);
      console.log(
        `  argv: pai worker run --label "${name}" --cwd ${cwd} --name "${name}" "/Name ${name}\\ngo"`
      );
      console.log();
      return;
    }
    if (wantResume) {
      const plan = providerResumePlan(opts.resumableUuid!, cwd, workers);
      console.log("\n" + chalk.bold("Dry run — would probe then exec (RESUME path):") + "\n");
      console.log(`  cwd:      ${chalk.cyan(cwd)}`);
      console.log(`  probe:    transcript on disk for ${opts.resumableUuid!.slice(0, 8)}?`);
      if (plan) {
        console.log(`  route:    ${plan.provider} (${plan.model})`);
      }
      console.log(`  argv:     ${chalk.white(resumeArgvText(opts.resumableUuid!, name, plan))}`);
      console.log(`  fallback: claude --name "${name}" "/Name ${name}\\ngo"`);
    } else {
      console.log("\n" + chalk.bold("Dry run — would exec (FRESH path):") + "\n");
      console.log(`  cwd:  ${chalk.cyan(cwd)}`);
      console.log(`  argv: claude --name "${name}" "/Name ${name}\\ngo"`);
    }
    console.log();
    return;
  }

  // Worker path: interactive `pai worker run`, fresh by design — no resume.
  if (route.engine === "worker") {
    const result = spawnSync("pai", workerRunArgv(name, cwd), {
      cwd,
      stdio: "inherit",
      env: process.env,
    });
    if (result.error) {
      console.error(err(`Failed to launch pai worker run: ${result.error.message}`));
      process.exitCode = 1;
      return;
    }
    printExitDir(cwd);
    process.exitCode = result.status ?? 0;
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
      process.exitCode = 1;
      return;
    }
    printExitDir(cwd);
    process.exitCode = result.status ?? 0;
  };

  if (wantResume) {
    const probe = probeResume(opts.resumableUuid!, cwd);
    if (probe.ok) {
      // A transcript that ran on a configured provider must resume on it:
      // plain `claude --resume` with the inherited environment comes up on
      // the Anthropic login and the session silently flips provider.
      const plan = providerResumePlan(opts.resumableUuid!, cwd, workers);
      const result = plan
        ? spawnSync(
            plan.cmd[0],
            [...plan.cmd.slice(1), "--resume", opts.resumableUuid!, "--name", name, promptArg],
            { cwd, stdio: "inherit", env: plan.env }
          )
        : spawnSync("claude", ["--resume", opts.resumableUuid!, "--name", name, promptArg], {
            cwd,
            stdio: "inherit",
            env: process.env,
          });
      if (result.error) {
        console.error(err(`Failed to launch claude: ${result.error.message}`));
        process.exitCode = 1;
        return;
      }
      printExitDir(cwd);
      process.exitCode = result.status ?? 0;
      return;
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
