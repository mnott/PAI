/**
 * tool-name-repair.ts — deterministic repair of dotted tool names in worker
 * tool calls.
 *
 * Local models hallucinate a namespaced tool name (`Glob.glob`, `Read.read`,
 * `Bash.Bash`), each call dies with "No such tool available" — a tool_result
 * error no hook sees — and the run thrashes on the same mistake (measured:
 * seven in a row, worker 20261016-184402-57942). The decision: worker run,
 * the name contains a dot, and the last dot-segment names a known tool
 * case-insensitively; the call is rewritten to that bare name. Nothing beyond
 * that rule is guessed — `foo.bar` stays untouched.
 *
 * Pure, same split as lib/path-repair.ts: the hook (pre-tool-use/
 * worker-tool-name-repair.ts) does only I/O.
 */

export const R_TOOL_DENY_REASON = "write your R report as plain text in your final answer, not as a tool call";

export interface ToolNameRepairInput {
  tool_name?: string;
  cwd?: string;
  tool_input?: Record<string, unknown>;
}

export interface ToolNameRepair {
  old: string;
  new: string;
  updatedInput: Record<string, unknown>;
}

/**
 * The tools a worker run actually loads: the file-tool set of the
 * worker-path-repair matcher plus Bash. No Task/Agent — a misrouted agent
 * call is a routing decision, not a typo.
 */
export const KNOWN_TOOLS: readonly string[] = [
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "Bash",
];

/** The bare tool a dotted name points at, or null when there is none. */
export function bareToolName(name: string, known: readonly string[] = KNOWN_TOOLS): string | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  const bare = name.slice(dot + 1);
  return known.find((t) => t.toLowerCase() === bare.toLowerCase()) ?? null;
}

export function reportToolDenial(input: ToolNameRepairInput, env: NodeJS.ProcessEnv): string | null {
  if (env.PAI_WORKER !== "1") return null;
  const name = input.tool_name ?? "";
  // Match exact "R" or "functions.R" (with dots)
  if (name === "R" || name === "functions.R") {
    return R_TOOL_DENY_REASON;
  }
  return null;
}

export function repairToolName(input: ToolNameRepairInput, env: NodeJS.ProcessEnv): ToolNameRepair | null {
  if (env.PAI_WORKER !== "1") return null;
  const name = input.tool_name ?? "";
  const known = bareToolName(name);
  if (!known) return null;
  return { old: name, new: known, updatedInput: { ...(input.tool_input ?? {}) } };
}

export function renderToolDenial(reason: string): string {
  return JSON.stringify({
    decision: "deny",
    reason,
  });
}

export function renderRepair(r: ToolNameRepair): string {
  const msg = `tool name repaired: ${r.old} → ${r.new}`;
  const context = `${msg}. Call tools by their bare names: ${r.new}, never ${r.old} — dotted names do not exist.`;
  return JSON.stringify({
    systemMessage: msg,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: r.updatedInput,
      additionalContext: context,
    },
  });
}
