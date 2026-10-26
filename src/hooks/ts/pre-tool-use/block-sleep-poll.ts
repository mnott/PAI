#!/usr/bin/env node

/**
 * block-sleep-poll.ts — PreToolUse (Bash)
 *
 * Denies a Bash command that contains a `sleep N` of SLEEP_FLOOR_SECS or more
 * as its own command segment — anywhere in the command, not only leading it —
 * unless the call is backgrounded (`run_in_background: true`), which blocks
 * nothing. CLAUDE.md already says "never sleep-poll"; this hook is the
 * enforcement, prose alone does not stop it (observed 2026-09-29: sessions and
 * workers kept running `sleep 590` waits on a background job anyway).
 *
 * It also hosts the main-session git gate (lib/main-session-git-gate): no git
 * mutation in slot worktrees, no ad-hoc worktree/worker-branch removal.
 *
 * This file is only I/O: read stdin, ask lib/sleep-poll-gate for the
 * decision, print it. The decision itself lives in lib/sleep-poll-gate.ts and
 * is tested there.
 */

import { type SleepPollGateInput } from "../lib/sleep-poll-gate.js";
import { renderDecision } from "../lib/render-decision.js";
import { allow, deny, readGateInput } from "../lib/gate-io.js";
import { cachedLocalAnswer } from "../lib/local-answer.js";
import { evaluate } from "../../../guard/evaluate.js";

async function main(): Promise<void> {
  const input = await readGateInput<SleepPollGateInput>();
  if (!input) return allow();

  // main-session git, build doors, model servers, background and sleep-poll: decided by evaluate()
  const d = evaluate(
    { kind: "tool_call", tool: input.tool_name ?? "Bash", input: input.tool_input, cwd: (input as { cwd?: string }).cwd ?? process.cwd() },
    { env: process.env, gates: { bash: { localAnswer: cachedLocalAnswer } } },
  );
  if (d.action === "deny") return deny(d.message!);
  if (d.updatedInput) process.stdout.write(renderDecision({ decision: "allow", updatedInput: d.updatedInput }) + "\n");
  return allow();
}

main().catch(() => process.exit(0));
