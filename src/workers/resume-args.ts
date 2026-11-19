/**
 * resume-args.ts — the claude args and workspace for `pai worker resume`.
 * `claude --resume <id>` fails when the session transcript is gone, so a
 * missing transcript starts a fresh thread in the same workspace instead
 * (the Claude Code adapter finding from the UHP evaluation). uhp workers
 * resume by response id, not a transcript, and are passed through as-is.
 *
 * A resumed worker runs in the ORIGIN's worktree (adoptTree hands the tree to
 * the new id) but carries a NEW worker id, and models build worktree paths
 * from their own id — live 2026-11-19 an Edit targeted …/worktrees/<new id>/…
 * which does not exist. So every resume prompt names the worktree it actually
 * runs in and says to edit files there (see worktreeContinuationPrompt).
 *
 * A LOCAL provider whose previous conversation exceeds workers.localContextTokens
 * never continues with --resume: each turn would carry the whole 130k+ history
 * forward on one engine. It starts a fresh thread instead — original spec + the
 * operator's text + an auto summary of the previous run (its final report /
 * last line, git log and diff --stat of its branch), same worktree/branch
 * (see previousRunSummary). Cloud resumes are untouched.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { getProviderOrNative, isLocalProvider, readWorkersCached } from "./config.js";
import { claudeSessionTranscript } from "./scan.js";
import { parseWorkerReport } from "./report.js";
import type { WorkerStatus } from "./status.js";

/** The shape resumePlan reads off the old worker's status. */
export type ResumeOld = Pick<
  WorkerStatus,
  "id" | "claudeSession" | "cwd" | "uhpResponseId" | "provider" | "last" | "state" | "rc" | "branch" | "commits" | "promptFile" | "spec" | "contextTokens" | "worktreeBase"
>;

/**
 * Git for the resume summary: never throws — a failed git call simply
 * contributes nothing to the summary (a missing tree must not stop a resume).
 */
function gitSafe(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function readText(path?: string | null): string {
  if (!path || path === "-" || !existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Trims a block to `max` chars on whole lines (head kept: the summary's start is its point). */
function clip(text: string, max: number): string {
  const out: string[] = [];
  let n = 0;
  for (const line of text.split("\n")) {
    if (n + line.length + 1 > max) {
      out.push("…");
      break;
    }
    n += line.length + 1;
    out.push(line);
  }
  return out.join("\n");
}

/**
 * The auto summary of the previous run for a fresh-thread resume: its final
 * report / last line, and git log + diff --stat of its branch. Cheap inputs
 * only — everything already recorded on the status plus two git calls.
 */
export function previousRunSummary(old: ResumeOld, cwd?: string): string {
  const parts: string[] = [];
  const outcome = `outcome: ${old.state}${old.rc !== null && old.rc !== undefined ? ` (rc ${old.rc})` : ""}`;
  const report = parseWorkerReport(old.last ?? "");
  if (report) {
    const lines = [`final report of the previous run (${outcome}):`, `R ${clip(old.last.trim(), 1500)}`];
    if (report.why) lines.push(`y=${report.why}`);
    parts.push(lines.join("\n"));
  } else if (old.last) {
    parts.push(`${outcome}; its last line: ${clip(old.last, 500)}`);
  } else {
    parts.push(outcome);
  }
  const spec = readText(old.promptFile ?? old.spec);
  if (spec.trim()) parts.push(`original spec:\n${clip(spec.trim(), 4000)}`);
  if (cwd) {
    const branch = old.branch ? gitSafe(cwd, ["log", "--oneline", "-15", old.branch]) : "";
    if (branch) parts.push(`commits on ${old.branch}:\n${branch}`);
    // the branch's own diff: against its base when one was recorded, else HEAD
    const stat = old.branch && old.worktreeBase
      ? gitSafe(cwd, ["diff", "--stat", `${old.worktreeBase}...${old.branch}`])
      : gitSafe(cwd, ["diff", "--stat", "HEAD"]);
    if (stat) parts.push(`diff --stat:\n${clip(stat, 1500)}`);
  }
  return parts.join("\n\n");
}

/** A resume whose old run went past this many context tokens starts fresh on a local provider. */
export function localResumeFreshTokens(): number {
  // an unreadable config resumes the old way (--resume) rather than refusing
  try {
    return readWorkersCached().localContextTokens ?? 0;
  } catch {
    return 0;
  }
}

/** Whether the old worker ran on a local (loopback) provider. A provider that cannot be resolved reads as cloud. */
function oldRanLocal(old: ResumeOld): boolean {
  try {
    const p = getProviderOrNative(readWorkersCached(), old.provider);
    return !!p && !!p.baseUrl && isLocalProvider(p.baseUrl);
  } catch {
    return false;
  }
}

/** The cap above which a local resume starts fresh; null when the old run was not local (or no cap is readable). */
export function localResumeCap(old: ResumeOld): number | null {
  if (!oldRanLocal(old)) return null;
  const cap = localResumeFreshTokens();
  return cap > 0 ? cap : null;
}

/**
 * Told to every resumed worker, on both resume paths (the --resume continuation
 * and the fresh thread): the worktree it actually runs in is the origin's, not
 * one named after its own new id. `dir` is the tree adoptTree hands over — only
 * stated when it exists; without it this still warns against deriving a path
 * from the worker id.
 */
export function worktreeContinuationPrompt(dir?: string): string {
  return dir
    ? `(Your worktree: ${dir} — the origin worker's tree, which your run took over; edit files there. It is NOT a directory named after your own worker id: never build a worktree path from your id.)`
    : `(Your worktree is the origin worker's tree, not a directory named after your own worker id: never build a worktree path from your id — use paths relative to your working directory.)`;
}

export interface ResumePlan {
  claudeArgs: string[];
  /** The old worker's workspace when it still exists (the transcript lives under it). */
  cwd?: string;
  /** Set when the resume could not continue the old thread. */
  note?: string;
  /** Set when the fresh path was chosen by the local context cap (not a missing transcript): the prompt carries its own spec + summary, so no --spec file applies to this thread. */
  freshPrompt?: boolean;
}

export function resumePlan(
  old: ResumeOld,
  text: string,
  transcriptFor: (session: string, cwd: string) => string | null = claudeSessionTranscript,
): ResumePlan {
  const session = old.claudeSession ?? "";
  const cwd = old.cwd && existsSync(old.cwd) ? old.cwd : undefined;
  // a local provider whose previous conversation exceeds workers.localContextTokens
  // starts fresh instead of carrying the whole history forward each turn: the
  // prompt is the original spec + this text + an auto summary of the last run.
  const cap = localResumeCap(old);
  if (cap !== null && !old.uhpResponseId && (old.contextTokens ?? 0) > cap) {
    const summary = previousRunSummary(old, cwd);
    return {
      claudeArgs: [
        "-p",
        `(Continuing worker ${old.id}: its conversation reached ${old.contextTokens} tokens, past the local context cap (${cap}), so this is a fresh thread.\n\n${summary}\n\n${worktreeContinuationPrompt(cwd)})\n\n${text}`,
      ],
      ...(cwd ? { cwd } : {}),
      note: `previous conversation at ${old.contextTokens} tokens, past the local cap ${cap} — starting a fresh thread with its summary in the same workspace`,
      freshPrompt: true,
    };
  }
  if (old.uhpResponseId || transcriptFor(session, old.cwd ?? process.cwd())) {
    return { claudeArgs: ["--resume", session, "-p", `${worktreeContinuationPrompt(cwd)}\n\n${text}`], ...(cwd ? { cwd } : {}) };
  }
  return {
    claudeArgs: [
      "-p",
      `(Continuing worker ${old.id}: its conversation is no longer available, so this is a fresh thread.)\n${worktreeContinuationPrompt(cwd)}\n\n${text}`,
    ],
    ...(cwd ? { cwd } : {}),
    note: `transcript of session ${session} not found — starting a fresh thread in the same workspace`,
  };
}
