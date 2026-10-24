/**
 * Local providers sometimes answer a tool call as text: the server failed to
 * parse `<tool_call>…<parameter=…>` into a tool_use. This reads a buffered
 * response (JSON or SSE) and builds the one retry request that follows.
 */

import { hasMalformedToolCall, MALFORMED_RETRY_TEXT } from "../workers/malformed-toolcall.js";

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

/** The same request plus the damaged answer and the one extra user message. */
export function retryBody(body: Buffer, damagedText: string): Buffer {
  const j = JSON.parse(body.toString("utf8"));
  const messages = Array.isArray(j.messages) ? j.messages : [];
  return Buffer.from(
    JSON.stringify({
      ...j,
      messages: [...messages, { role: "assistant", content: damagedText }, { role: "user", content: MALFORMED_RETRY_TEXT }],
    })
  );
}
