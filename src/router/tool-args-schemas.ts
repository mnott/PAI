/**
 * The Claude Code tool schemas the rule examples, the replay script and the
 * tests repair against: parameter types and required lists of the tools a
 * local model calls most. A request carries its own schemas at run time;
 * this table only stands in for them offline.
 */

import type { ToolSchema } from "./tool-args.js";

const s = { type: "string" };
const n = { type: "number" };
const b = { type: "boolean" };

export const CLAUDE_CODE_TOOL_SCHEMAS: Record<string, ToolSchema> = {
  Bash: { properties: { command: s, description: s, timeout: n, run_in_background: b }, required: ["command"] },
  Read: { properties: { file_path: s, offset: n, limit: n, allow_large: b }, required: ["file_path"] },
  Write: { properties: { file_path: s, content: s }, required: ["file_path", "content"] },
  Edit: { properties: { file_path: s, old_string: s, new_string: s, replace_all: b }, required: ["file_path", "old_string", "new_string"] },
  Grep: {
    properties: {
      pattern: s,
      path: s,
      glob: s,
      output_mode: s,
      "-B": n,
      "-A": n,
      "-C": n,
      "-n": b,
      "-i": b,
      type: s,
      head_limit: n,
      offset: n,
      multiline: b,
    },
    required: ["pattern"],
  },
  Glob: { properties: { pattern: s, path: s }, required: ["pattern"] },
};

/** A request-body `tools` array for the table above. */
export function claudeCodeToolsArray(): Array<{ name: string; input_schema: Record<string, unknown> }> {
  return Object.entries(CLAUDE_CODE_TOOL_SCHEMAS).map(([name, t]) => ({
    name,
    input_schema: { type: "object", properties: t.properties, required: t.required },
  }));
}
