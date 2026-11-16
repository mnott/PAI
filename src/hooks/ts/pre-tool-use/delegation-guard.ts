#!/usr/bin/env node

/**
 * delegation-guard.ts — PreToolUse (Bash): PAI's delegation rules (L0 routes, worker pane rule,
 * no recursive search from / or ~, mode chain: --model/--provider only when the operator names
 * one). The decision lives in lib/delegation-gate.ts; this entry only does the I/O.
 */

import { decideDelegationGate, latestOperatorPrompt } from "../lib/delegation-gate.js";
import { allow, deny, readGateInput } from "../lib/gate-io.js";

async function main(): Promise<void> {
  const input = await readGateInput<{ tool_name?: string; transcript_path?: string; tool_input?: { command?: string } }>();
  const command = input?.tool_input?.command;
  if (!input || (input.tool_name && input.tool_name !== "Bash") || typeof command !== "string") return allow();
  const d = decideDelegationGate(command, process.env, latestOperatorPrompt(input.transcript_path));
  if (d.decision === "deny") return deny(d.reason!);
  return allow();
}

main().catch(() => process.exit(0));
