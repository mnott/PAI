#!/usr/bin/env node

/**
 * route-agents-to-worker.ts — PreToolUse hook on the in-process subagent tool.
 *
 * Denies every in-process subagent, in every project, so that delegated work
 * always goes through `pai worker run` and therefore shows up in
 * `pai worker ps`, in the status line and in the worker log dir. The deny
 * reason names the replacement command, `--provider anthropic` included, so
 * there is never a reason to reach for the built-in tool.
 *
 * This file is only I/O: read stdin, ask lib/agent-gate for the decision,
 * ledger it, print it. The decision itself lives in lib/agent-gate.ts and is
 * tested there.
 *
 * Registered in ~/.claude/settings.json under a PreToolUse matcher that covers
 * both tool names ("Agent|Task") — see src/workers/install.ts, which owns that
 * registration.
 */

import { readWorkersSection } from "../../../workers/config.js";
import { workersLogDir, ledgerPath } from "../../../workers/paths.js";
import { appendLedger } from "../../../workers/ledger.js";
import {
  decideAgentGate,
  renderDecision,
  shortLabel,
  type AgentGateInput,
} from "../lib/agent-gate.js";

/**
 * What to print when the hook cannot read or parse its own input. This hook is
 * matcher-scoped to the subagent tool, so anything that reaches it *is* a
 * subagent launch: a broken event denies rather than allows, and the bypass
 * env var is still honoured. A gate that opens whenever it stumbles is the
 * failure this hook exists to prevent.
 */
function fallback(): string {
  return renderDecision(decideAgentGate({}, process.env));
}

async function main(): Promise<void> {
  let text = "";
  try {
    for await (const chunk of process.stdin) text += chunk;
  } catch {
    process.stdout.write(fallback());
    return;
  }

  let input: AgentGateInput = {};
  if (text.trim()) {
    try {
      input = JSON.parse(text) as AgentGateInput;
    } catch {
      // A malformed event on a matcher-scoped hook is still a subagent launch;
      // an empty input denies, which is the safe direction here.
      input = {};
    }
  }

  const decision = decideAgentGate(input, process.env);

  if (decision.ledger) {
    const label = shortLabel(input);
    try {
      appendLedger(ledgerPath(workersLogDir(readWorkersSection().workers)), decision.ledger, {
        cwd: input.cwd ?? process.cwd(),
        ...(label ? { label } : {}),
      });
    } catch {
      // no config / no log dir yet — the decision still stands
    }
  }

  process.stdout.write(renderDecision(decision));
}

main().catch(() => process.stdout.write(fallback()));
