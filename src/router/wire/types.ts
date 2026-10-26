/**
 * wire/types.ts — one interface per client wire format (Anthropic messages,
 * OpenAI chat completions, OpenAI responses). The rules engine (tool-args.ts,
 * tool-call-rules.ts) stays format-free; an adapter only finds the tool schemas
 * and tool-call arguments in its format and hands them to it.
 */

import { Transform, type TransformCallback } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { ToolArgsFix, ToolSchema, ToolSchemas } from "../tool-args.js";
import type { Rule } from "../tool-call-rules.js";
import { blockText, evaluateStreamCall, isEnforceDeny, type ProxyGuardDeps } from "../proxy-guard.js";

export type WireId = "messages" | "chat" | "responses";

export interface WireConverted {
  body: string;
  calls: Array<{ name: string; hits: string[] }>;
}

/** Enforce-mode guard context for a stream: what each completed tool call is evaluated against. */
export interface GuardStreamCtx {
  model: string;
  provider?: string;
  /** The (translated) request body, when known: joins the per-conversation loop state. */
  request?: unknown;
  deps?: ProxyGuardDeps;
  /** Called once per call the guard blocked, with the text the client received in its place. */
  onBlock?: (tool: string, text: string) => void;
}

export interface WireAdapter {
  id: WireId;
  /** Keepalive bytes for a queued stream in this format: an SSE comment every
   *  client ignores on OpenAI wires; the named ping event Claude expects. */
  keepalive(): string;
  matches(method: string, path: string): boolean;
  /** Declared tools with parameter types and required lists. */
  schemas(body: Buffer | string): ToolSchemas;
  /** Non-streaming reply: tool-call arguments repaired; the same text when no rule hit. */
  rewriteJson(reply: string, schemas: ToolSchemas, rules: () => readonly Rule[], onFix: ToolArgsFix): string;
  /** SSE transform; every message that needs no repair passes byte for byte. */
  rewriteStream(schemas: ToolSchemas, rules: () => readonly Rule[], onFix: ToolArgsFix): Transform;
  /** Tool-call markup left as answer text (JSON or SSE) becomes structured calls; null when none or not whole. */
  convertMarkup(raw: string, contentType: string, schemas: ToolSchemas, rules: readonly Rule[]): WireConverted | null;
  /** Enforce-mode SSE transform: a tool call the guard denies is replaced in the stream; every other message passes byte for byte. */
  guardStream(ctx: GuardStreamCtx): Transform;
}

/** Base for SSE transforms: whole messages go to `message()`, which returns the text to emit including the separator. */
export abstract class SseMessages extends Transform {
  private buf = "";
  private readonly dec = new StringDecoder("utf8");

  /** Output for one complete message, separator included; "" drops it. */
  protected abstract message(msg: string, sep: string): string;
  /** Text still held at end of input. */
  protected finish(): string {
    return "";
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.buf += this.dec.write(chunk);
    const { messages, rest } = splitSse(this.buf);
    this.buf = rest;
    const out = messages.map((m) => this.message(m.text, m.sep)).join("");
    if (out) this.push(out);
    cb();
  }

  override _flush(cb: TransformCallback): void {
    this.buf += this.dec.end();
    let out = "";
    if (this.buf) {
      out += this.message(this.buf, "");
      this.buf = "";
    }
    out += this.finish();
    if (out) this.push(out);
    cb();
  }
}

/** Shared engine of the per-format guard transforms: hold tool blocks until complete, evaluate, forward or replace. */
export abstract class GuardToolSse extends SseMessages {
  /** A deny or stop ends the turn: later tool blocks are replaced without evaluating. */
  private stoppedTurn = false;

  constructor(protected readonly ctx: GuardStreamCtx) {
    super();
  }

  /** Read-only: a deny or stop already rewrote a block of this stream. */
  protected get turnStopped(): boolean {
    return this.stoppedTurn;
  }

  /**
   * Hold a tool call a subclass spotted in an opening message. `opening` is the message text to replay when the
   * call survives (a subclass may have stripped the call's parts from it); null holds nothing.
   */
  protected holdCall(index: number, tool: string, opening: string): void {
    this.held.set(index, { tool, json: "", events: [{ text: opening, sep: "\n\n" }], emit: (blocked) => (blocked ? this.replace(index, blocked) : opening + "\n\n") });
  }

  /** One held tool call: the messages from the block's start to its stop, plus what to emit once decided. */
  private readonly held = new Map<number, { tool: string; json: string; events: Array<{ text: string; sep: string }>; emit: (blocked: string | null) => string }>();

  /** True when msg opens a tool block (content_block_start / output_item.added). */
  protected abstract opensTool(d: any): { index: number; name: string } | null;
  /** The argument fragment a msg carries, keyed by the block index; null when msg is not one. */
  protected abstract fragment(d: any): { index: number; part: string } | null;
  /** True when msg closes a held tool block; the index is the one to release. */
  protected abstract closes(d: any): number | null;
  /** The replacement for a denied block at `index`: one text message (or item) in its place. */
  protected abstract replace(index: number, text: string): string;
  /** Called when the turn ends (a deny/stop rewrote a block) so the final stop_reason / finish_reason is fixed. */
  protected stopTurn(): void {
    this.stoppedTurn = true;
  }

  protected override message(msg: string, sep: string): string {
    try {
      return this.route(msg, sep);
    } catch {
      // a malformed or unexpected event must not break the stream: forward it
      return msg + sep;
    }
  }

  private route(msg: string, sep: string): string {
    if (!msg.includes("tool_use") && !msg.includes("function_call") && !msg.includes("input_json_delta") && !msg.includes("function_call_arguments") && !msg.includes("tool_calls")) return msg + sep;
    const d = sseData(msg);
    if (!d) return msg + sep;
    const open = this.opensTool(d.json);
    if (open) {
      this.holdCall(open.index, open.name, msg);
      return "";
    }
    const frag = this.fragment(d.json);
    if (frag) {
      const h = this.held.get(frag.index);
      if (!h) return msg + sep;
      h.json += frag.part;
      h.events.push({ text: msg, sep });
      return "";
    }
    const close = this.closes(d.json);
    if (close !== null) {
      const h = this.held.get(close);
      if (!h) return msg + sep;
      this.held.delete(close);
      const block = h.events.map((x) => x.text + x.sep).join("");
      if (this.stoppedTurn) return h.emit(blockText({ action: "stop", patternId: "guard", message: "the turn was stopped by the PAI guard" }));
      let input: unknown;
      try {
        input = h.json ? JSON.parse(h.json) : {};
      } catch {
        return block; // a damaged input is not a decision
      }
      const decision = evaluateStreamCall({ tool: h.tool, input, model: this.ctx.model, provider: this.ctx.provider, request: this.ctx.request, deps: this.ctx.deps });
      if (!isEnforceDeny(decision)) return block;
      const text = blockText(decision);
      this.ctx.onBlock?.(h.tool, text);
      this.stopTurn();
      return h.emit(text);
    }
    return this.finalize(msg, sep, d.json);
  }

  /** A message after the held blocks were decided (message_delta / response.completed): rewrite it when the turn was stopped. */
  protected finalize(msg: string, sep: string, json: any): string {
    void json;
    return msg + sep;
  }

  protected override finish(): string {
    // a stream cut before the blocks closed: hand back what was held, undecided
    let out = "";
    for (const h of this.held.values()) out += h.emit(null);
    this.held.clear();
    return out;
  }
}

/** A JSON-schema object (`{properties, required}`) as a ToolSchema. */
export function toolSchemaOf(js: unknown): ToolSchema {
  const o = (js && typeof js === "object" ? js : {}) as { properties?: unknown; required?: unknown };
  return {
    properties: o.properties && typeof o.properties === "object" ? (o.properties as ToolSchema["properties"]) : {},
    required: Array.isArray(o.required) ? o.required.filter((r): r is string => typeof r === "string") : [],
  };
}

export function parseBody(body: Buffer | string): { tools?: unknown } {
  try {
    const j = JSON.parse(typeof body === "string" ? body : body.toString("utf8"));
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

/** SSE text split into complete messages (separator kept) and the unfinished tail. */
export function splitSse(buf: string): { messages: Array<{ text: string; sep: string }>; rest: string } {
  const sep = /\r?\n\r?\n/g;
  const messages: Array<{ text: string; sep: string }> = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = sep.exec(buf))) {
    messages.push({ text: buf.slice(last, m.index), sep: m[0] });
    last = m.index + m[0].length;
  }
  return { messages, rest: buf.slice(last) };
}

/** The `data:` payload of an SSE message as JSON, or null. */
export function sseData(msg: string): { json: any } | null {
  const line = msg.split("\n").find((l) => l.startsWith("data:"));
  if (!line) return null;
  try {
    return { json: JSON.parse(line.slice(5)) };
  } catch {
    return null;
  }
}

/** Message with its `data:` line replaced by the given JSON. */
export function withData(msg: string, json: unknown): string {
  return msg.replace(/^data:.*$/m, () => `data: ${JSON.stringify(json)}`);
}
