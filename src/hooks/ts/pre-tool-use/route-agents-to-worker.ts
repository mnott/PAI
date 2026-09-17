#!/usr/bin/env node

/**
 * route-agents-to-worker.ts — PreToolUse hook on the Agent tool.
 *
 * Denies every in-process subagent when worker providers are configured, so no
 * worker ever runs on Anthropic. The deny reason tells the orchestrator how to
 * delegate through `pai worker run` instead — same idea as the old
 * route-agents-to-glm.sh, but provider-neutral and ledgered in the workers
 * log dir.
 *
 * Allows (and does not touch) when:
 *   - the tool is not the Agent tool (this hook is Agent-matched, but stay safe)
 *   - ALLOW_ANTHROPIC_AGENTS=1 is in the environment (one-session bypass)
 *   - workers are off or no provider is configured
 *
 * Every decision is appended to the routing ledger read by `pai worker log`.
 */

import { readWorkersSection } from "../../../workers/config.js";
import { workersLogDir, ledgerPath } from "../../../workers/paths.js";
import { appendLedger } from "../../../workers/ledger.js";

interface HookInput {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: { description?: string; prompt?: string; subagent_type?: string } | string;
}

const ALLOW = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } });

function deny(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}

function shortLabel(input: HookInput): string {
  const desc =
    typeof input.tool_input === "object" && input.tool_input !== null
      ? input.tool_input.description ?? ""
      : "";
  return desc.replace(/\s+/g, " ").trim().slice(0, 60);
}

async function main(): Promise<void> {
  let text = "";
  try {
    for await (const chunk of process.stdin) text += chunk;
  } catch {
    process.stdout.write(ALLOW);
    return;
  }
  if (!text.trim()) {
    process.stdout.write(ALLOW);
    return;
  }

  let input: HookInput;
  try {
    input = JSON.parse(text) as HookInput;
  } catch {
    process.stdout.write(ALLOW);
    return;
  }

  if (input.tool_name && input.tool_name !== "Agent") {
    process.stdout.write(ALLOW);
    return;
  }

  const label = shortLabel(input);
  const cwd = input.cwd ?? process.cwd();

  const ledger = (event: string): void => {
    try {
      appendLedger(ledgerPath(workersLogDir(readWorkersSection().workers)), event, {
        cwd,
        ...(label ? { label } : {}),
      });
    } catch {
      // no config / no log dir yet — the decision below still stands
    }
  };

  if (process.env.ALLOW_ANTHROPIC_AGENTS === "1") {
    ledger("ALLOWED-ANTHROPIC-AGENT");
    process.stdout.write(ALLOW);
    return;
  }

  let workers: ReturnType<typeof readWorkersSection>["workers"];
  try {
    workers = readWorkersSection().workers;
  } catch {
    // broken workers config must not break the session
    process.stdout.write(ALLOW);
    return;
  }
  if (!workers.enabled || Object.keys(workers.providers).length === 0) {
    process.stdout.write(ALLOW);
    return;
  }

  ledger("DENIED-ANTHROPIC-AGENT");
  process.stdout.write(
    deny(
      "Agent tool is disabled: subagents run on the configured worker provider, not Anthropic. " +
        "Delegate with Bash instead, in the background:\n\n" +
        `pai worker run --label "${label || "task"}" --role research -p '<full, self-contained task spec>' ` +
        "--allowedTools 'Read,Edit,Write,Bash,Grep,Glob' --output-format json\n\n" +
        "- Run it with run_in_background: true and always with a timeout.\n" +
        "- Use --role spotcheck (or implement) as the task demands.\n" +
        "- Web research: add WebSearch,WebFetch to --allowedTools.\n" +
        "- The answer is in the `result` field of the JSON it prints. Review the diff yourself.\n" +
        "- pai worker ps lists running workers; pai worker follow <id> shows one live.\n" +
        "Keep only orchestration, review and synthesis in this session. " +
        "To run subagents on Anthropic for one session: start it with ALLOW_ANTHROPIC_AGENTS=1."
    )
  );
}

main().catch(() => process.stdout.write(ALLOW));
