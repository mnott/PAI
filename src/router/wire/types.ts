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

export type WireId = "messages" | "chat" | "responses";

export interface WireConverted {
  body: string;
  calls: Array<{ name: string; hits: string[] }>;
}

export interface WireAdapter {
  id: WireId;
  matches(method: string, path: string): boolean;
  /** Declared tools with parameter types and required lists. */
  schemas(body: Buffer | string): ToolSchemas;
  /** Non-streaming reply: tool-call arguments repaired; the same text when no rule hit. */
  rewriteJson(reply: string, schemas: ToolSchemas, rules: () => readonly Rule[], onFix: ToolArgsFix): string;
  /** SSE transform; every message that needs no repair passes byte for byte. */
  rewriteStream(schemas: ToolSchemas, rules: () => readonly Rule[], onFix: ToolArgsFix): Transform;
  /** Tool-call markup left as answer text (JSON or SSE) becomes structured calls; null when none or not whole. */
  convertMarkup(raw: string, contentType: string, schemas: ToolSchemas, rules: readonly Rule[]): WireConverted | null;
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
