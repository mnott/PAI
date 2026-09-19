/**
 * agent-gate.ts — the decision behind the PreToolUse subagent gate.
 *
 * Pure: no stdin, no filesystem, no config, no process.env read of its own.
 * The hook entry (pre-tool-use/route-agents-to-worker.ts) does the I/O; this
 * module decides, so the decision can be tested directly instead of inferred
 * from a hook that happens to exit 0.
 *
 * The gate is deliberately NOT conditional on the workers config. It used to
 * allow whenever routing was off, no provider was configured, or the active
 * provider was the native Anthropic one — which made the guard silently
 * self-disabling. Observed 2026-09-19 with `workers.active = "anthropic"`:
 * two in-process subagents ran to completion, invisible to `pai worker ps`.
 * Visibility is the point of the gate, and it is worth just as much when the
 * work is meant to run on an Anthropic model — `pai worker run --provider
 * anthropic` delivers exactly that, and shows up in `pai worker ps`.
 */

export interface AgentGateInput {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: { description?: string; prompt?: string; subagent_type?: string } | string;
}

/**
 * Tool names the harness has used for in-process subagents. "Agent" is what
 * the current harness emits (verified against real tool_use records in the
 * session transcripts); "Task" is the older name, matched as well so that a
 * harness rename in either direction cannot silently reopen the hole.
 */
export const SUBAGENT_TOOL_NAMES = ["Agent", "Task"] as const;

/** Environment variable that disables the gate for one session. */
export const BYPASS_ENV = "ALLOW_ANTHROPIC_AGENTS";

export type GateDecision =
  | { decision: "allow"; ledger: string | null }
  | { decision: "deny"; reason: string; ledger: string };

export function isSubagentTool(name: string): boolean {
  return (SUBAGENT_TOOL_NAMES as readonly string[]).includes(name);
}

/** The label the deny message suggests for the replacement worker run. */
export function shortLabel(input: AgentGateInput): string {
  const desc =
    typeof input.tool_input === "object" && input.tool_input !== null
      ? input.tool_input.description ?? ""
      : "";
  return desc.replace(/\s+/g, " ").trim().slice(0, 60);
}

export function denyReason(label: string): string {
  const name = label || "task";
  return (
    "The in-process subagent tool is disabled: every subagent must run through " +
    "`pai worker run`, so that it shows up in `pai worker ps` and the status line and " +
    "can be followed, replayed and killed. Delegate with Bash instead, in the background:\n\n" +
    `pai worker run --provider anthropic --label "${name}" -p '<full, self-contained task spec>' ` +
    "--allowedTools 'Read,Edit,Write,Bash,Grep,Glob' --output-format json\n\n" +
    "- `--provider anthropic` is the supported way to get an Anthropic-model subagent, " +
    "so there is never a reason to reach for the built-in tool.\n" +
    "- Drop `--provider` to use the configured worker provider; pick the job with " +
    "`--class draft|plan|implement|review|research|spotcheck`.\n" +
    "- Run it in the background and always with a timeout.\n" +
    "- Web research: add WebSearch,WebFetch to --allowedTools.\n" +
    "- The answer is in the `result` field of the JSON it prints. Review the diff yourself.\n" +
    "- `pai worker ps` lists running workers; `pai worker follow <id>` shows one live.\n" +
    "Keep only orchestration, review and synthesis in this session. " +
    `To re-enable in-process subagents for one session: start it with ${BYPASS_ENV}=1.`
  );
}

/**
 * Decide. `env` is passed in so the bypass can be exercised without mutating
 * the process environment.
 */
export function decideAgentGate(
  input: AgentGateInput,
  env: Record<string, string | undefined>
): GateDecision {
  const name = input.tool_name;
  // Matcher-scoped hook, but a stray event for another tool must pass through.
  // A *missing* tool_name is not treated as another tool: the gate denies,
  // because the only thing routed here is a subagent launch.
  if (name && !isSubagentTool(name)) return { decision: "allow", ledger: null };

  if (env[BYPASS_ENV] === "1") return { decision: "allow", ledger: "ALLOWED-ANTHROPIC-AGENT" };

  return {
    decision: "deny",
    reason: denyReason(shortLabel(input)),
    ledger: "DENIED-ANTHROPIC-AGENT",
  };
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
