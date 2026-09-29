/**
 * sleep-poll-gate.ts — the decision behind the PreToolUse Bash sleep-poll gate.
 *
 * Pure: no stdin, no filesystem, no process.env read of its own — the hook
 * entry (pre-tool-use/block-sleep-poll.ts) does the I/O, this module decides,
 * same split as lib/agent-gate.ts and lib/edit-gate.ts.
 *
 * CLAUDE.md already says "never sleep-poll"; prose does not enforce it, a
 * PreToolUse deny does. `run_in_background: true` is allowed in an interactive session (denied in a worker) — a
 * backgrounded sleep blocks nothing, it is the harness's own long-command
 * pattern.
 */

import { SLEEP_FLOOR_SECS, totalSleepSecs } from "../../../workers/status.js";

export interface SleepPollGateInput {
  tool_name?: string;
  tool_input?: { command?: string; run_in_background?: boolean };
}

export type GateDecision = { decision: "allow" } | { decision: "deny"; reason: string };

/**
 * A headless worker has no owner to deliver a background-exit notification
 * to — ending its turn ends the process, so the interactive session's advice
 * ("background it, the harness notifies you") does not apply. Text mirrors
 * the worker contract's own sleep-poll line (workerContractPrompt in
 * src/workers/report.ts) so a denied worker sees the same instruction twice.
 */
export function denyReason(secs: number, isWorker: boolean): string {
  const lead = `sleep ${secs}s blocked: do not sleep-poll. `;
  if (isWorker) {
    return (
      lead +
      "In a worker, run the long command in the FOREGROUND with a Bash timeout up to 600000 ms " +
        "and split longer jobs into steps; run_in_background is denied here."
    );
  }
  return (
    lead +
    "Run the long command itself with run_in_background: true (the harness notifies when it exits), " +
    "or wait on a specific condition with a bounded loop under 60s per step."
  );
}

/**
 * A headless worker (`claude -p`) has no re-invocation: ending its turn ends
 * the process and kills the background job, whatever it says about waiting for
 * a completion notification.
 */
const BACKGROUND_WORKER_REASON =
  "run_in_background is blocked in a worker: ending your turn ends this process and kills the job, " +
  "there is no completion notification. Run the command in the FOREGROUND with a Bash timeout up to " +
  "600000 ms, and split a longer job into steps that each fit in that.";

export function decideSleepPollGate(
  input: SleepPollGateInput,
  env: Record<string, string | undefined>
): GateDecision {
  if (input.tool_name && input.tool_name !== "Bash") return { decision: "allow" };
  const isWorker = env.PAI_WORKER === "1";
  if (input.tool_input?.run_in_background === true) {
    return isWorker ? { decision: "deny", reason: BACKGROUND_WORKER_REASON } : { decision: "allow" };
  }

  const command = input.tool_input?.command;
  if (typeof command !== "string") return { decision: "allow" };

  const secs = totalSleepSecs(command);
  if (secs < SLEEP_FLOOR_SECS) return { decision: "allow" };

  return { decision: "deny", reason: denyReason(secs, isWorker) };
}

/** Render a decision as the JSON the harness reads on the hook's stdout. */
export function renderDecision(d: GateDecision): string {
  if (d.decision === "allow") {
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
    });
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: d.reason,
    },
  });
}
