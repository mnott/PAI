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
 */

import { existsSync } from "node:fs";
import { claudeSessionTranscript } from "./scan.js";
import type { WorkerStatus } from "./status.js";

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
}

export function resumePlan(
  old: Pick<WorkerStatus, "id" | "claudeSession" | "cwd" | "uhpResponseId">,
  text: string,
  transcriptFor: (session: string, cwd: string) => string | null = claudeSessionTranscript,
): ResumePlan {
  const session = old.claudeSession ?? "";
  const cwd = old.cwd && existsSync(old.cwd) ? old.cwd : undefined;
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
