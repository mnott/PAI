/**
 * Local providers sometimes answer a tool call as text: the server failed to
 * parse `<tool_call>…<parameter=…>` into a tool_use. This reads a buffered
 * response (JSON or SSE) and builds the one retry request that follows.
 */

import { createHash } from "node:crypto";
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

interface Msg {
  role?: string;
  content?: unknown;
}

function messagesOf(body: Buffer): Msg[] {
  try {
    const msgs = JSON.parse(body.toString("utf8")).messages;
    return Array.isArray(msgs) ? msgs : [];
  } catch {
    return [];
  }
}

const blocks = (m: Msg): { type?: string; text?: string }[] => (Array.isArray(m.content) ? (m.content as { type?: string; text?: string }[]) : []);

/** A user message the human (or task) wrote: not a bare tool_result carrier. */
function isRealUser(m: Msg): boolean {
  if (m.role !== "user") return false;
  if (typeof m.content === "string") return true;
  const bs = blocks(m);
  return bs.length === 0 || bs.some((b) => b?.type !== "tool_result");
}

function textOf(m: Msg | undefined): string {
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  return blocks(m).map((b) => b?.text ?? "").join("\n");
}

/** Index of the last real user message (-1 when none). */
function lastRealUser(msgs: Msg[]): number {
  for (let i = msgs.length - 1; i >= 0; i--) if (isRealUser(msgs[i])) return i;
  return -1;
}

/** Text of the last real user message of a request body ("" when unreadable). */
function lastUserText(body: Buffer): string {
  const msgs = messagesOf(body);
  return textOf(msgs[lastRealUser(msgs)]);
}

/** Completed tool calls (tool_result blocks, or OpenAI role "tool" messages) since the last real user message. */
export function toolWork(body: Buffer): number {
  const msgs = messagesOf(body);
  let n = 0;
  for (let i = lastRealUser(msgs) + 1; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === "tool") n++;
    else n += blocks(m).filter((b) => b?.type === "tool_result").length;
  }
  return n;
}

/** Key of the conversation turn: position and text of the last real user message. */
export function turnKey(body: Buffer): string {
  const msgs = messagesOf(body);
  const i = lastRealUser(msgs);
  return `${i}:${createHash("sha256").update(textOf(msgs[i])).digest("hex").slice(0, 16)}`;
}

/** A turn ended with a stray token (≤ 3 chars) and no tool call, with no tool work done this turn, on a non-trivial user message. */
export function isDegenerate(a: Answer, body: Buffer): boolean {
  return a.stopReason === "end_turn" && !a.toolUse && isDegenerateAnswer(a.text, toolWork(body), lastUserText(body));
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
