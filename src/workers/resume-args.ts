/**
 * resume-args.ts — the claude args and workspace for `pai worker resume`.
 * `claude --resume <id>` fails when the session transcript is gone, so a
 * missing transcript starts a fresh thread in the same workspace instead
 * (the Claude Code adapter finding from the UHP evaluation). uhp workers
 * resume by response id, not a transcript, and are passed through as-is.
 */

import { existsSync } from "node:fs";
import { claudeSessionTranscript } from "./scan.js";
import type { WorkerStatus } from "./status.js";

export interface ResumePlan {
  claudeArgs: string[];
  /** The old worker's workspace when it still exists (the transcript lives under it). */
  cwd?: string;
  /** Set when the resume could not continue the old thread. */
  note?: string;
}

export function resumePlan(
  old: Pick<WorkerStatus, "id" | "claudeSession" | "cwd" | "uhpResponseId"> & { engine?: string },
  text: string,
  transcriptFor: (session: string, cwd: string) => string | null = claudeSessionTranscript,
): ResumePlan {
  const session = old.claudeSession ?? "";
  const cwd = old.cwd && existsSync(old.cwd) ? old.cwd : undefined;
  // engines with no resumable transcript (codex, image) never get --resume: always a fresh thread
  if (old.engine) {
    return {
      claudeArgs: ["-p", `(Continuing worker ${old.id}: its ${old.engine} conversation cannot be resumed, so this is a fresh thread.)\n\n${text}`],
      ...(cwd ? { cwd } : {}),
      note: `resume: ${old.engine} sessions are not resumable — starting a fresh thread in the same workspace`,
    };
  }
  if (old.uhpResponseId || transcriptFor(session, old.cwd ?? process.cwd())) {
    return { claudeArgs: ["--resume", session, "-p", text], ...(cwd ? { cwd } : {}) };
  }
  return {
    claudeArgs: ["-p", `(Continuing worker ${old.id}: its conversation is no longer available, so this is a fresh thread.)\n\n${text}`],
    ...(cwd ? { cwd } : {}),
    note: `transcript of session ${session} not found — starting a fresh thread in the same workspace`,
  };
}
