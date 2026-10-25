/**
 * A final assistant text that is (or ends with) a tool call the server returned as plain text, because the
 * model called a tool that was not declared. Claude Code treats that text as the final answer and the run ends.
 */

const FENCE = /```[\s\S]*?```/g;

/** The tool name of an unparsed call the text ends with, or null. Fenced code is ignored. */
export function unparsedToolCall(text: string | undefined): string | null {
  if (!text) return null;
  // an unclosed fence hides everything after it; a closed one is dropped
  const open = text.replace(FENCE, "");
  if (open.includes("```")) return null;
  const t = open.trimEnd();
  const tail = t.slice(-1500);
  // qwen3-coder XML: <tool_call> <function=NAME> ... </tool_call> at the end
  const qwen = /<tool_call>\s*<function=([\w.:-]+)>[\s\S]*?(?:<\/tool_call>\s*)?$/.exec(tail);
  if (qwen) return qwen[1];
  // Anthropic XML: <function_calls> <invoke name="NAME"> ...
  const inv = /<function_calls>\s*<invoke name="([^"]+)">[\s\S]*?(?:<\/function_calls>)?$/.exec(tail) ?? /<invoke name="([^"]+)">[\s\S]*?(?:<\/invoke>\s*)?(?:<\/function_calls>)?$/.exec(tail);
  if (inv) return inv[1];
  // JSON object with name + arguments alone on the last lines
  const lines = t.split("\n");
  for (let i = Math.max(0, lines.length - 12); i < lines.length; i++) {
    if (!lines[i].trimStart().startsWith("{")) continue;
    const obj = lines.slice(i).join("\n").trim();
    try {
      const j = JSON.parse(obj) as Record<string, unknown>;
      if (j && typeof j.name === "string" && j.name && "arguments" in j) return j.name;
    } catch {
      /* not a whole JSON object from this line */
    }
  }
  return null;
}

/** The continuation prompt: names the tool that was not available, lists the ones that are. */
export function unparsedCallPrompt(name: string, allowedTools: string): string {
  return (
    `Your last message was a call to the tool ${name}, which is not available in this task. ` +
    `Available tools: ${allowedTools}. The call was not run. ` +
    "Continue the task with the available tools; when done, send your final report."
  );
}
