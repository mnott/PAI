/**
 * tool-args-convert.ts — router-side tool parsing: a buffered answer (JSON or
 * SSE) whose text holds tool-call markup the engine never parsed becomes an
 * answer with tool_use blocks, via the rules file (parseToolCallText). Used
 * for providers flagged `toolParsing: router`; when the markup cannot be made
 * whole it returns null and the caller keeps the existing malformed-call retry.
 */

import { randomBytes } from "node:crypto";
import { parseToolCallText, type ParsedCall, type ToolSchemas } from "./tool-args.js";
import type { Rule } from "./tool-call-rules.js";
import { hasMalformedToolCall } from "../workers/malformed-toolcall.js";

export interface Converted {
  body: string;
  calls: ParsedCall[];
}

const toolId = (): string => `toolu_${randomBytes(12).toString("hex")}`;

/** Answer text → text before the calls plus the calls; null when it is no markup or cannot be parsed whole. */
function parseAnswerText(text: string, schemas: ToolSchemas, rules: readonly Rule[]) {
  if (!hasMalformedToolCall(text)) return null;
  const parsed = parseToolCallText(text, schemas, rules);
  return parsed && parsed.calls.length ? parsed : null;
}

export function convertTextAnswer(raw: string, contentType: string, schemas: ToolSchemas, rules: readonly Rule[]): Converted | null {
  return /text\/event-stream/i.test(contentType) ? convertSse(raw, schemas, rules) : convertJson(raw, schemas, rules);
}

function convertJson(raw: string, schemas: ToolSchemas, rules: readonly Rule[]): Converted | null {
  try {
    const j = JSON.parse(raw) as { content?: Array<{ type?: string; text?: string }>; stop_reason?: string };
    if (!Array.isArray(j.content) || j.content.some((c) => c?.type === "tool_use")) return null;
    const text = j.content.filter((c) => c?.type === "text").map((c) => c.text ?? "").join("");
    const parsed = parseAnswerText(text, schemas, rules);
    if (!parsed) return null;
    const kept = j.content.filter((c) => c?.type !== "text");
    j.content = [
      ...kept,
      ...(parsed.before ? [{ type: "text", text: parsed.before }] : []),
      ...parsed.calls.map((c) => ({ type: "tool_use", id: toolId(), name: c.name, input: c.input })),
    ];
    j.stop_reason = "tool_use";
    return { body: JSON.stringify(j), calls: parsed.calls };
  } catch {
    return null;
  }
}

function convertSse(raw: string, schemas: ToolSchemas, rules: readonly Rule[]): Converted | null {
  const msgs = raw.split(/\r?\n\r?\n/).filter((m) => m.trim());
  const parsedMsgs = msgs.map((m) => {
    const line = m.split("\n").find((l) => l.startsWith("data:"));
    let ev: { type?: string; index?: number; content_block?: { type?: string }; delta?: { type?: string; text?: string } } | null = null;
    try {
      ev = line ? JSON.parse(line.slice(5)) : null;
    } catch {
      /* keep verbatim */
    }
    return { m, ev };
  });
  const blockType = new Map<number, string>();
  let text = "";
  for (const { ev } of parsedMsgs) {
    if (ev?.type === "content_block_start" && typeof ev.index === "number") blockType.set(ev.index, ev.content_block?.type ?? "");
    if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") text += ev.delta.text ?? "";
    if (ev?.type === "content_block_start" && ev.content_block?.type === "tool_use") return null;
  }
  const parsed = parseAnswerText(text, schemas, rules);
  if (!parsed) return null;
  const out: string[] = [];
  const remap = new Map<number, number>();
  let next = 0;
  const frame = (type: string, body: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}`;
  const emitNew = (): void => {
    if (parsed.before) {
      const i = next++;
      out.push(
        frame("content_block_start", { index: i, content_block: { type: "text", text: "" } }),
        frame("content_block_delta", { index: i, delta: { type: "text_delta", text: parsed.before } }),
        frame("content_block_stop", { index: i })
      );
    }
    for (const c of parsed.calls) {
      const i = next++;
      out.push(
        frame("content_block_start", { index: i, content_block: { type: "tool_use", id: toolId(), name: c.name, input: {} } }),
        frame("content_block_delta", { index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(c.input) } }),
        frame("content_block_stop", { index: i })
      );
    }
  };
  let emitted = false;
  for (const { m, ev } of parsedMsgs) {
    if (!ev) {
      out.push(m);
      continue;
    }
    if ((ev.type === "message_delta" || ev.type === "message_stop") && !emitted) {
      emitNew();
      emitted = true;
    }
    if (ev.type?.startsWith("content_block_") && typeof ev.index === "number") {
      if (blockType.get(ev.index) === "text") continue;
      if (!remap.has(ev.index)) remap.set(ev.index, next++);
      out.push(m.replace(/^data:.*$/m, (l) => `data: ${JSON.stringify({ ...JSON.parse(l.slice(5)), index: remap.get(ev.index as number) })}`));
    } else if (ev.type === "message_delta") {
      out.push(m.replace(/^data:.*$/m, (l) => {
        const d = JSON.parse(l.slice(5));
        d.delta = { ...(d.delta ?? {}), stop_reason: "tool_use" };
        return `data: ${JSON.stringify(d)}`;
      }));
    } else out.push(m);
  }
  if (!emitted) emitNew();
  return { body: out.join("\n\n") + "\n\n", calls: parsed.calls };
}
