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

export const PARAM_ALIASES: Record<string, Record<string, string>> = {
  Read: { path: "file_path", filePath: "file_path", file: "file_path" },
  Edit: { path: "file_path", filePath: "file_path", file: "file_path" },
  Write: { path: "file_path", filePath: "file_path", file: "file_path" },
  Bash: { cmd: "command" },
  Grep: { regex: "pattern" },
};

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

export const INVENTED_TOOL_DIRECTIVES: Record<string, string> = {
  Git: "there is no Git tool; use Bash with git ...",
  R: R_TOOL_DENY_REASON,
};

export function reportToolDenial(input: ToolNameRepairInput, env: NodeJS.ProcessEnv): string | null {
  if (env.PAI_WORKER !== "1") return null;
  const name = input.tool_name ?? "";
  // Match exact "R" or "functions.R" (with dots)
  if (name === "R" || name === "functions.R") {
    return R_TOOL_DENY_REASON;
  }
  return null;
}

export function repairParams(input: ToolNameRepairInput, env: NodeJS.ProcessEnv): ToolNameRepair | null {
  if (env.PAI_WORKER !== "1") return null;
  const tool = input.tool_name;
  if (!tool) return null;

  const aliases = PARAM_ALIASES[tool];
  if (!aliases) return null;

  const tool_input = input.tool_input ?? {};
  const updatedInput = { ...tool_input };
  const renames: string[] = [];

  for (const [alias, declared] of Object.entries(aliases)) {
    if (alias in tool_input && !(declared in tool_input)) {
      updatedInput[declared] = tool_input[alias];
      delete updatedInput[alias];
      renames.push(`${alias}→${declared}`);
    }
  }

  if (renames.length === 0) return null;

  // For the new string, we want to show only the final declared parameters
  // We should only include the actual parameters that are present, not all aliases
  const declaredParams = Object.keys(updatedInput).filter(key => Object.values(aliases).includes(key));
  return {
    old: `${tool}(${renames.join(",")})`,
    new: `${tool}(${declaredParams.join(",")})`,
    updatedInput
  };
}

export function inventedToolDirective(input: ToolNameRepairInput, env: NodeJS.ProcessEnv): string | null {
  if (env.PAI_WORKER !== "1") return null;
  const name = input.tool_name ?? "";
  // Strip leading "functions." prefix if present
  const cleanName = name.startsWith("functions.") ? name.slice(10) : name;
  return INVENTED_TOOL_DIRECTIVES[cleanName] ?? null;
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
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}

export function renderParamRepair(r: ToolNameRepair): string {
  const msg = `tool parameters repaired: ${r.old} → ${r.new}`;
  return JSON.stringify({
    systemMessage: msg,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: r.updatedInput,
      additionalContext: `${msg}. Use the declared parameter names (Read/Edit/Write: file_path, Bash: command, Grep: pattern).`,
    },
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
