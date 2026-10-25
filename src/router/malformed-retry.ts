/**
 * Local providers sometimes answer a tool call as text: the server failed to
 * parse `<tool_call>…<parameter=…>` into a tool_use. This reads a buffered
 * response (JSON or SSE) and builds the one retry request that follows.
 */

import { DEGENERATE_RETRY_TEXT, hasMalformedToolCall, isDegenerateAnswer, MALFORMED_RETRY_TEXT } from "../workers/malformed-toolcall.js";

export interface Answer {
  text: string;
  stopReason: string | undefined;
  toolUse: boolean;
}

/** Text, stop_reason and tool_use presence of a buffered /v1/messages response. */
export function readAnswer(raw: string, contentType: string): Answer {
  const out: Answer = { text: "", stopReason: undefined, toolUse: false };
  if (/text\/event-stream/i.test(contentType)) {
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        const ev = JSON.parse(line.slice(5).trim());
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") out.text += ev.delta.text ?? "";
        else if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") out.toolUse = true;
        else if (ev.type === "message_delta" && ev.delta?.stop_reason) out.stopReason = ev.delta.stop_reason;
      } catch {
        /* partial or non-JSON line */
      }
    }
    return out;
  }
  try {
    const j = JSON.parse(raw);
    out.stopReason = j.stop_reason ?? undefined;
    for (const b of Array.isArray(j.content) ? j.content : []) {
      if (b?.type === "text") out.text += b.text ?? "";
      else if (b?.type === "tool_use") out.toolUse = true;
    }
  } catch {
    /* not a messages body */
  }
  return out;
}

export function isDamaged(a: Answer): boolean {
  return a.stopReason === "end_turn" && !a.toolUse && hasMalformedToolCall(a.text);
}

/** Text of the last user message of a request body ("" when unreadable). */
function lastUserText(body: Buffer): string {
  try {
    const msgs = JSON.parse(body.toString("utf8")).messages;
    const c = Array.isArray(msgs) ? msgs[msgs.length - 1]?.content : undefined;
    if (typeof c === "string") return c;
    return Array.isArray(c) ? c.map((b: { text?: string }) => b?.text ?? "").join("\n") : "";
  } catch {
    return "";
  }
}

/** A turn ended with a stray token (≤ 3 chars) and no tool call, on a request with a non-trivial user message. */
export function isDegenerate(a: Answer, body: Buffer): boolean {
  return a.stopReason === "end_turn" && !a.toolUse && isDegenerateAnswer(a.text, 0, lastUserText(body));
}

/** The same request plus the bad answer and the one extra user message. */
export function retryBody(body: Buffer, badText: string, nudge: string = MALFORMED_RETRY_TEXT): Buffer {
  const j = JSON.parse(body.toString("utf8"));
  const messages = Array.isArray(j.messages) ? j.messages : [];
  return Buffer.from(
    JSON.stringify({
      ...j,
      messages: [...messages, { role: "assistant", content: badText.trim() || "…" }, { role: "user", content: nudge }],
    })
  );
}

export { DEGENERATE_RETRY_TEXT };
