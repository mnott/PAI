/**
 * wire/index.ts — the adapters by request path. `messages` wraps the existing
 * Anthropic-format functions so the router asks one interface for all three.
 */

import { convertTextAnswer } from "../tool-args-convert.js";
import { declaredToolSchemas, repairJsonReplyArgs, ToolArgsSse } from "../tool-args.js";
import { blockText, evaluateStreamCall, isEnforceDeny } from "../proxy-guard.js";
import { Transform } from "node:stream";
import { chatAdapter } from "./chat.js";
import { responsesAdapter } from "./responses.js";
import { splitSse, type GuardStreamCtx, type WireAdapter } from "./types.js";

/**
 * Enforce mode on an Anthropic messages stream: a tool_use block the guard denies is held until its input is
 * complete, then replaced by a text block at the same index; message_delta's stop_reason becomes end_turn when
 * no tool_use block survives. Every other event passes byte for byte. The messages format needs its own engine
 * (per-block start/delta/stop events), so it lives here rather than on the shared GuardToolSse.
 */
class MessagesGuard extends Transform {
  private buf = "";
  private readonly held = new Map<number, { name: string; json: string; events: string[] }>();
  private toolUseLeft = true;
  private stoppedTurn = false;

  constructor(private readonly ctx: GuardStreamCtx) {
    super();
  }

  private writeOut(text: string): void {
    if (text) this.push(text);
  }

  private handle(msg: string, sep: string): string {
    const line = msg.split("\n").find((l) => l.startsWith("data:"));
    if (!line) return msg + sep;
    let d: any;
    try {
      d = JSON.parse(line.slice(5));
    } catch {
      return msg + sep;
    }
    if (d?.type === "content_block_start" && d.content_block?.type === "tool_use") {
      this.held.set(typeof d.index === "number" ? d.index : 0, { name: String(d.content_block.name ?? ""), json: "", events: [msg + sep] });
      return "";
    }
    if (d?.type === "content_block_delta" && d.delta?.type === "input_json_delta") {
      const h = this.held.get(typeof d.index === "number" ? d.index : 0);
      if (!h) return msg + sep;
      h.json += String(d.delta.partial_json ?? "");
      h.events.push(msg + sep);
      return "";
    }
    if (d?.type === "content_block_stop") {
      const i = typeof d.index === "number" ? d.index : 0;
      const h = this.held.get(i);
      if (!h) return msg + sep;
      this.held.delete(i);
      const block = h.events.join("") + msg + sep;
      if (this.stoppedTurn) return this.replace(i, blockText({ action: "stop", patternId: "guard", message: "the turn was stopped by the PAI guard" }));
      let input: unknown;
      try {
        input = h.json ? JSON.parse(h.json) : {};
      } catch {
        return block; // a damaged input is not a decision
      }
      const decision = evaluateStreamCall({ tool: h.name, input, model: this.ctx.model, provider: this.ctx.provider, request: this.ctx.request, deps: this.ctx.deps });
      if (!isEnforceDeny(decision)) return block;
      const text = blockText(decision);
      this.toolUseLeft = false;
      this.stoppedTurn = true;
      this.ctx.onBlock?.(h.name, text);
      return this.replace(i, text);
    }
    if (d?.type === "message_delta" && d.delta?.stop_reason === "tool_use" && !this.toolUseLeft) {
      return msg.replace(/^data:.*$/m, () => `data: ${JSON.stringify({ ...d, delta: { ...d.delta, stop_reason: "end_turn" } })}`) + sep;
    }
    return msg + sep;
  }

  private replace(index: number, text: string): string {
    const ev = (type: string, body: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;
    return ev("content_block_start", { index, content_block: { type: "text", text: "" } }) + ev("content_block_delta", { index, delta: { type: "text_delta", text } }) + ev("content_block_stop", { index });
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: () => void): void {
    this.buf += chunk.toString("utf8");
    const { messages, rest } = splitSse(this.buf);
    this.buf = rest;
    this.writeOut(messages.map((m) => this.handle(m.text, m.sep)).join(""));
    cb();
  }

  override _flush(cb: () => void): void {
    // a stream cut before a block closed: hand back what was held, undecided
    this.writeOut(this.buf + [...this.held.values()].flatMap((h) => h.events).join(""));
    this.held.clear();
    cb();
  }
}

export const messagesAdapter: WireAdapter = {
  id: "messages",
  matches: (method, path) => method === "POST" && /^\/v1\/messages(\/count_tokens)?(\?.*)?$/.test(path),
  schemas: declaredToolSchemas,
  rewriteJson: repairJsonReplyArgs,
  rewriteStream: (schemas, rules, onFix) => new ToolArgsSse(schemas, rules, onFix),
  convertMarkup: (raw, ct, schemas, rules) => convertTextAnswer(raw, ct, schemas, rules),
  guardStream: (ctx) => new MessagesGuard(ctx),
};

export const WIRE_ADAPTERS: readonly WireAdapter[] = [messagesAdapter, chatAdapter, responsesAdapter];

/** `/p/<provider>/v1/...` names the provider in the path (clients whose base URL cannot carry a header). */
export function splitProviderPrefix(path: string): { path: string; provider?: string } {
  const m = /^\/p\/([^/?]+)(\/.*)$/.exec(path);
  return m ? { path: m[2]!, provider: decodeURIComponent(m[1]!) } : { path };
}

export function adapterFor(method: string, path: string): WireAdapter | undefined {
  return WIRE_ADAPTERS.find((a) => a.matches(method, path));
}
