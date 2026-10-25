/**
 * A final assistant text that is (or ends with) a tool call the server returned as plain text, because the
 * model called a tool that was not declared. Claude Code treats that text as the final answer and the run ends.
 */

import { activeAntipattern, fillMessage } from "../../hooks/ts/lib/antipatterns.js";
import { dispositionOf } from "../../hooks/ts/lib/antipattern-lifecycle.js";

const FENCE = /```[\s\S]*?```/g;

/** The tool name of an unparsed call the text ends with, or null. Fenced code is ignored. Forms come from antipatterns/final-text/unparsed-tool-call.yaml. */
export function unparsedToolCall(text: string | undefined): string | null {
  if (!text) return null;
  const { regexes, tail_chars, json_window_lines } = activeAntipattern("unparsed-tool-call").detector.params as { regexes: string[]; tail_chars: number; json_window_lines: number };
  // an unclosed fence hides everything after it; a closed one is dropped
  const open = text.replace(FENCE, "");
  if (open.includes("```")) return null;
  const t = open.trimEnd();
  const tail = t.slice(-tail_chars);
  // tagged forms (qwen3-coder XML, Anthropic XML): the first regex that matches names the tool
  for (const r of regexes) {
    const m = new RegExp(r).exec(tail);
    if (m) return m[1];
  }
  // JSON object with name + arguments alone on the last lines
  const lines = t.split("\n");
  for (let i = Math.max(0, lines.length - json_window_lines); i < lines.length; i++) {
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
  return fillMessage(activeAntipattern("unparsed-tool-call").message, { name, allowed: allowedTools });
}

/** The unparsed call in the text and what the pattern does about it now (monitor: record only); null when none, or the pattern is off. */
export function unparsedCallDecision(text: string | undefined): { name: string; mode: "enforce" | "monitor"; version: number } | null {
  const name = unparsedToolCall(text);
  if (!name) return null;
  const ap = activeAntipattern("unparsed-tool-call");
  const mode = dispositionOf(ap, text ?? "");
  return mode === "off" ? null : { name, mode, version: ap.version };
}
