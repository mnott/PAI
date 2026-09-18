/**
 * mcp-deferred-gate.ts — pure pieces of the deferred MCP tool gate.
 *
 * Claude Code defers MCP tool schemas: an mcp__server__tool call fails input
 * validation unless the session surfaced the schema via ToolSearch first.
 * Sessions misread that error as "MCP server disconnected" and report an
 * outage that never happened (observed with a rename tool while every server
 * was connected).
 *
 * The decision is evidence-based: the session transcript either shows the tool
 * was surfaced (a ToolSearch mentioning it) or already ran successfully — in
 * which case the schema is loaded and the call passes through untouched — or
 * it shows neither, in which case the call is about to hit the gate (or is a
 * retry that just did) and gets the corrective instruction.
 *
 * Split out of the pre-tool-use entrypoint (which calls main() at import
 * time) so the decision is testable without spawning a hook process, per the
 * transcript-text.ts precedent.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GateHookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: unknown;
}

export interface GateEvidence {
  /** A ToolSearch call in the transcript mentions this tool by full name. */
  surfacedByToolSearch: boolean;
  /** This tool already ran successfully — its schema must be loaded. */
  succeededBefore: boolean;
}

export interface GateObservation {
  type: "decision";
  title: string;
  narrative: string;
  tool_name: string;
  tool_input_summary: string;
  files_read: string[];
  files_modified: string[];
  concepts: string[];
}

export interface GateDecision {
  action: "pass" | "correct";
  /** The JSON string to write to stdout, same shape as sibling PreToolUse hooks. */
  output: string;
  /** Observation payload for the daemon when a correction fired, else null. */
  observation: GateObservation | null;
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export const PASS_OUTPUT = JSON.stringify({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
});

/** True for MCP tool names (`mcp__<server>__<tool>`), false for everything else. */
export function isMcpTool(name: string): boolean {
  return name.startsWith("mcp__") && name.split("__").length >= 3 && !!name.split("__")[2];
}

/**
 * Scan transcript text (JSONL, one entry per line, tolerant of junk) for
 * evidence that `toolName` is loadable in this session.
 */
export function scanTranscriptEvidence(transcriptText: string, toolName: string): GateEvidence {
  const toolUseIds = new Set<string>();
  let surfacedByToolSearch = false;
  let succeededBefore = false;

  for (const line of transcriptText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const message = (entry as { message?: { content?: unknown } })?.message;
    const content = message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content as Array<Record<string, unknown>>) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "tool_use" && typeof block.name === "string") {
        if (block.name === toolName && typeof block.id === "string") {
          toolUseIds.add(block.id);
        } else if (block.name === "ToolSearch") {
          // Liberal match: the query may be "select:<tool>" or a keyword list.
          if (JSON.stringify(block.input ?? "").includes(toolName)) {
            surfacedByToolSearch = true;
          }
        }
      } else if (
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string" &&
        toolUseIds.has(block.tool_use_id) &&
        !block.is_error
      ) {
        succeededBefore = true;
      }
    }
  }

  return { surfacedByToolSearch, succeededBefore };
}

/** The corrective instruction fed back to the session on a deny. */
export function buildCorrection(toolName: string): string {
  return (
    `${toolName} is a deferred MCP tool: its schema is not loaded in this session yet, so this ` +
    `call would fail input validation. The MCP server is NOT disconnected — do not report an ` +
    `outage and do not retry the call unchanged. Remedy: call ToolSearch with query ` +
    `"select:${toolName}" to load the schema, then call ${toolName} again with the same arguments.`
  );
}

/**
 * The whole gate: given hook input and the session transcript, decide whether
 * this mcp__ call passes through or gets the deferred-schema correction.
 */
export function decideMcpGate(input: GateHookInput, transcriptText: string): GateDecision {
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  if (!isMcpTool(toolName)) {
    return { action: "pass", output: PASS_OUTPUT, observation: null };
  }

  const evidence = scanTranscriptEvidence(transcriptText, toolName);
  if (evidence.surfacedByToolSearch || evidence.succeededBefore) {
    return { action: "pass", output: PASS_OUTPUT, observation: null };
  }

  return {
    action: "correct",
    output: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: buildCorrection(toolName),
      },
    }),
    observation: {
      type: "decision",
      title: `MCP deferred-tool gate corrected: ${toolName}`,
      narrative:
        `Blocked a call to deferred MCP tool ${toolName} and issued the ToolSearch remedy ` +
        "(server not disconnected)",
      tool_name: toolName,
      tool_input_summary: toolName,
      files_read: [],
      files_modified: [],
      concepts: ["mcp", "deferred", "toolsearch"],
    },
  };
}
