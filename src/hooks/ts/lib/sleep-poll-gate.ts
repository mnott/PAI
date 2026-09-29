/**
 * sleep-poll-gate.ts — the decision behind the PreToolUse Bash sleep-poll gate.
 *
 * Pure: no stdin, no filesystem, no process.env read of its own — the hook
 * entry (pre-tool-use/block-sleep-poll.ts) does the I/O, this module decides,
 * same split as lib/agent-gate.ts and lib/edit-gate.ts.
 *
 * CLAUDE.md already says "never sleep-poll"; prose does not enforce it, a
 * PreToolUse deny does. `run_in_background: true` is always allowed — a
 * backgrounded sleep blocks nothing, it is the harness's own long-command
 * pattern.
 */

import { longestSleepSecs } from "../../../workers/status.js";

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
      "In a worker, run the long command in the FOREGROUND with a Bash timeout up to 600000 ms. " +
      "If it can run longer, start it in the background and wait with a foreground loop that ends " +
      "when the job ends: while kill -0 <pid> 2>/dev/null; do sleep 15; done"
    );
  }
  return (
    lead +
    "Run the long command itself with run_in_background: true (the harness notifies when it exits), " +
    "or wait on a specific condition with a bounded loop under 60s per step."
  );
}

export function decideSleepPollGate(
  input: SleepPollGateInput,
  env: Record<string, string | undefined>
): GateDecision {
  if (input.tool_name && input.tool_name !== "Bash") return { decision: "allow" };
  if (input.tool_input?.run_in_background === true) return { decision: "allow" };

  const command = input.tool_input?.command;
  if (typeof command !== "string") return { decision: "allow" };

  const secs = longestSleepSecs(command);
  if (secs === null) return { decision: "allow" };

  return { decision: "deny", reason: denyReason(secs, env.PAI_WORKER === "1") };
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
