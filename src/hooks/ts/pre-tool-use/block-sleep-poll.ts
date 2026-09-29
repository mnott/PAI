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
 * This file is only I/O: read stdin, ask lib/sleep-poll-gate for the
 * decision, print it. The decision itself lives in lib/sleep-poll-gate.ts and
 * is tested there.
 */

import { decideSleepPollGate, renderDecision, type SleepPollGateInput } from "../lib/sleep-poll-gate.js";

function allow(): void {
  process.exit(0);
}

function deny(reason: string): void {
  process.stdout.write(renderDecision({ decision: "deny", reason }) + "\n");
  process.exit(0);
}

async function main(): Promise<void> {
  let text = "";
  try {
    for await (const chunk of process.stdin) text += chunk;
  } catch {
    return allow();
  }
  if (!text.trim()) return allow();

  let input: SleepPollGateInput;
  try {
    input = JSON.parse(text) as SleepPollGateInput;
  } catch {
    return allow();
  }

  const decision = decideSleepPollGate(input, process.env);
  if (decision.decision === "deny") return deny(decision.reason);
  return allow();
}

main().catch(() => process.exit(0));
