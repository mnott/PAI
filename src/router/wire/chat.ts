/**
 * wire/chat.ts — OpenAI /v1/chat/completions. Tool schemas live in
 * tools[].function.parameters; calls in choices[].message.tool_calls[]
 * .function.arguments (a JSON string); streaming delivers the arguments as
 * choices[].delta.tool_calls[index].function.arguments fragments.
 */

import { randomBytes } from "node:crypto";
import { parseToolCallText, repairJson, type ToolArgsFix, type ToolSchemas } from "../tool-args.js";
import type { Rule } from "../tool-call-rules.js";
import { hasMalformedToolCall } from "../../workers/malformed-toolcall.js";
import { GuardToolSse, parseBody, SseMessages, sseData, toolSchemaOf, withData, type GuardStreamCtx, type WireAdapter, type WireConverted } from "./types.js";

const callId = (): string => `call_${randomBytes(12).toString("hex")}`;

export function chatSchemas(body: Buffer | string): ToolSchemas {
  const out: ToolSchemas = new Map();
  const b = parseBody(body);
  for (const t of Array.isArray(b.tools) ? b.tools : []) {
    const f = (t as { function?: { name?: unknown; parameters?: unknown } })?.function;
    if (typeof f?.name === "string") out.set(f.name, toolSchemaOf(f.parameters));
  }
  return out;
}

function rewriteJson(reply: string, schemas: ToolSchemas, rules: () => readonly Rule[], onFix: ToolArgsFix): string {
  if (!schemas.size || !reply.includes('"tool_calls"')) return reply;
  try {
    const j = JSON.parse(reply) as { choices?: Array<{ message?: { tool_calls?: Array<{ function?: { name?: unknown; arguments?: unknown } }> } }> };
    let changed = false;
    for (const ch of Array.isArray(j.choices) ? j.choices : []) {
      for (const tc of ch?.message?.tool_calls ?? []) {
        const f = tc?.function;
        if (!f || typeof f.name !== "string" || typeof f.arguments !== "string") continue;
        const after = repairJson(f.arguments, f.name, schemas, rules, onFix);
        if (after !== f.arguments) {
          f.arguments = after;
          changed = true;
        }
      }
    }
    return changed ? JSON.stringify(j) : reply;
  } catch {
    return reply;
  }
}

interface Held {
  name: string;
  json: string;
}

/**
 * Messages that touch a choice's tool_calls are held until that choice's
 * finish_reason; the arguments are then repaired as a whole. No rule hit: the
 * held messages go out verbatim. A hit: the same messages with the argument
 * fragments removed, then one delta carrying the repaired arguments.
 */
class ChatToolArgsSse extends SseMessages {
  private readonly queue = new Map<number, Array<{ text: string; sep: string }>>();
  private readonly calls = new Map<number, Map<number, Held>>();

  constructor(
    private readonly schemas: ToolSchemas,
    private readonly rules: () => readonly Rule[],
    private readonly onFix: ToolArgsFix
  ) {
    super();
  }

  protected override message(msg: string, sep: string): string {
    if (!msg.includes("tool_calls") && !msg.includes("finish_reason")) return msg + sep;
    const d = sseData(msg);
    const choices: any[] | undefined = d?.json?.choices;
    if (!d || !Array.isArray(choices) || choices.length !== 1) return msg + sep;
    const ch = choices[0];
    const ci: number = typeof ch.index === "number" ? ch.index : 0;
    const tcs = ch.delta?.tool_calls;
    if (Array.isArray(tcs) && tcs.length) {
      const m = this.calls.get(ci) ?? new Map<number, Held>();
      this.calls.set(ci, m);
      for (const tc of tcs) {
        const i: number = typeof tc.index === "number" ? tc.index : 0;
        const h = m.get(i) ?? { name: "", json: "" };
        if (typeof tc.function?.name === "string") h.name = tc.function.name;
        if (typeof tc.function?.arguments === "string") h.json += tc.function.arguments;
        m.set(i, h);
      }
      const q = this.queue.get(ci) ?? [];
      q.push({ text: msg, sep });
      this.queue.set(ci, q);
      return "";
    }
    if (ch.finish_reason && this.queue.has(ci)) return this.release(ci, d.json, msg, sep);
    return msg + sep;
  }

  private release(ci: number, tpl: any, msg: string, sep: string): string {
    const q = this.queue.get(ci) ?? [];
    const calls = this.calls.get(ci) ?? new Map<number, Held>();
    this.queue.delete(ci);
    this.calls.delete(ci);
    const fixed = new Map<number, string>();
    let hit = false;
    for (const [i, h] of calls) {
      const after = repairJson(h.json, h.name, this.schemas, this.rules, this.onFix);
      fixed.set(i, after);
      if (after !== h.json) hit = true;
    }
    if (!hit) return q.map((x) => x.text + x.sep).join("") + msg + sep;
    const out: string[] = [];
    for (const x of q) {
      const dd = sseData(x.text);
      if (!dd) continue;
      const choice = dd.json.choices[0];
      const kept = (choice.delta.tool_calls as any[])
        .map((tc) => (tc.function && "arguments" in tc.function ? { ...tc, function: { ...tc.function, arguments: "" } } : tc))
        // a fragment that carried only arguments has nothing left to say
        .filter((tc) => tc.id || tc.type || tc.function?.name);
      const hasOther = Object.keys(choice.delta).some((k) => k !== "tool_calls");
      if (!kept.length && !hasOther) continue;
      out.push(withData(x.text, { ...dd.json, choices: [{ ...choice, delta: { ...choice.delta, tool_calls: kept } }] }) + x.sep);
    }
    for (const [i, json] of fixed) {
      if (!json) continue;
      const delta = { ...tpl, choices: [{ index: ci, delta: { tool_calls: [{ index: i, function: { arguments: json } }] }, finish_reason: null }] };
      out.push(`data: ${JSON.stringify(delta)}\n\n`);
    }
    return out.join("") + msg + sep;
  }

  protected override finish(): string {
    // stream ended without finish_reason: hand back what was held
    const rest = [...this.queue.values()].flat().map((x) => x.text + x.sep).join("");
    this.queue.clear();
    this.calls.clear();
    return rest;
  }
}

function convertJson(raw: string, schemas: ToolSchemas, rules: readonly Rule[]): WireConverted | null {
  try {
    const j = JSON.parse(raw) as { choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown[] }; finish_reason?: string }> };
    const ch = j.choices?.[0];
    const msg = ch?.message;
    if (!ch || !msg || typeof msg.content !== "string" || msg.tool_calls?.length || !hasMalformedToolCall(msg.content)) return null;
    const parsed = parseToolCallText(msg.content, schemas, rules);
    if (!parsed || !parsed.calls.length) return null;
    msg.content = parsed.before || null;
    msg.tool_calls = parsed.calls.map((c) => ({ id: callId(), type: "function", function: { name: c.name, arguments: JSON.stringify(c.input) } }));
    ch.finish_reason = "tool_calls";
    return { body: JSON.stringify(j), calls: parsed.calls };
  } catch {
    return null;
  }
}

function convertSse(raw: string, schemas: ToolSchemas, rules: readonly Rule[]): WireConverted | null {
  const msgs = raw.split(/\r?\n\r?\n/).filter((m) => m.trim());
  const evs = msgs.map((m) => ({ m, d: sseData(m) }));
  let text = "";
  for (const { d } of evs) {
    const c = d?.json?.choices?.[0];
    if (!c) continue;
    if (c.delta?.tool_calls?.length) return null;
    if (typeof c.delta?.content === "string") text += c.delta.content;
  }
  if (!hasMalformedToolCall(text)) return null;
  const parsed = parseToolCallText(text, schemas, rules);
  if (!parsed || !parsed.calls.length) return null;
  const tpl = evs.find((e) => e.d?.json?.choices)?.d?.json ?? {};
  const mk = (delta: object) => ({ ...tpl, choices: [{ index: 0, delta, finish_reason: null }] });
  const out: string[] = [];
  let emitted = false;
  const emitNew = (): void => {
    if (emitted) return;
    emitted = true;
    if (parsed.before) out.push(`data: ${JSON.stringify(mk({ content: parsed.before }))}`);
    parsed.calls.forEach((c, i) =>
      out.push(`data: ${JSON.stringify(mk({ tool_calls: [{ index: i, id: callId(), type: "function", function: { name: c.name, arguments: JSON.stringify(c.input) } }] }))}`)
    );
  };
  for (const { m, d } of evs) {
    const c = d?.json?.choices?.[0];
    if (c && typeof c.delta?.content === "string" && c.delta.content !== "" && !c.finish_reason) continue;
    if (c?.finish_reason) {
      emitNew();
      out.push(withData(m, { ...d!.json, choices: [{ ...c, finish_reason: "tool_calls" }] }));
      continue;
    }
    if (/^data:\s*\[DONE\]/m.test(m)) emitNew();
    out.push(m);
  }
  emitNew();
  return { body: out.join("\n\n") + "\n\n", calls: parsed.calls };
}

/**
 * Enforce mode: a tool call the guard denies is replaced by a content delta carrying the guard text; the
 * finish_reason becomes "stop" when no tool call survives the choice. The call's opening message (id, type) is
 * dropped with its fragments, so the client never sees a call that was blocked.
 */
class ChatGuardSse extends GuardToolSse {
  /** choice index -> whether a tool call of it reached the client */
  private readonly sawTool = new Map<number, boolean>();

  protected opensTool(d: any): { index: number; name: string } | null {
    const choices: any[] | undefined = d?.choices;
    if (!Array.isArray(choices) || choices.length !== 1) return null;
    const tcs = choices[0]?.delta?.tool_calls;
    if (!Array.isArray(tcs) || !tcs.length) return null;
    const ci: number = typeof choices[0].index === "number" ? choices[0].index : 0;
    const name = tcs.map((tc: any) => (typeof tc?.function?.name === "string" ? tc.function.name : "")).join("");
    return { index: ci, name };
  }

  protected fragment(d: any): { index: number; part: string } | null {
    const choices: any[] | undefined = d?.choices;
    if (!Array.isArray(choices) || choices.length !== 1) return null;
    const tcs = choices[0]?.delta?.tool_calls;
    if (!Array.isArray(tcs) || !tcs.length) return null;
    const ci: number = typeof choices[0].index === "number" ? choices[0].index : 0;
    const part = tcs.map((tc: any) => (typeof tc?.function?.arguments === "string" ? tc.function.arguments : "")).join("");
    return { index: ci, part };
  }

  /** The choice's finish_reason closes its calls (no per-call end event exists in chat completions). */
  protected closes(d: any): number | null {
    const choices: any[] | undefined = d?.choices;
    if (!Array.isArray(choices) || choices.length !== 1) return null;
    const ci: number = typeof choices[0].index === "number" ? choices[0].index : 0;
    return choices[0]?.finish_reason ? ci : null;
  }

  protected replace(index: number, text: string): string {
    return `data: ${JSON.stringify({ choices: [{ index, delta: { role: "assistant", content: text } }] })}\n\n`;
  }

  protected override stopTurn(): void {
    this.sawTool.clear();
    super.stopTurn();
  }

  protected override finalize(msg: string, sep: string, json: any): string {
    const ch = Array.isArray(json?.choices) ? json.choices[0] : undefined;
    const ci: number = typeof ch?.index === "number" ? ch.index : 0;
    if (!ch?.finish_reason) return msg + sep;
    if (ch.finish_reason === "tool_calls") {
      // the turn ended on a guard block: the client sees a plain stop
      if (this.turnStopped) return withData(msg, { ...json, choices: [{ ...ch, finish_reason: "stop" }] }) + sep;
      // every call of this choice was denied (or none survived): also a stop
      if (!this.sawTool.get(ci)) return withData(msg, { ...json, choices: [{ ...ch, finish_reason: "stop" }] }) + sep;
    }
    return msg + sep;
  }

  /**
   * An opening message may carry other content (role, text) beside the call: those parts are emitted at once and
   * the call's parts are held, so a blocked call never reaches the client. The surviving-call bookkeeping happens
   * here, where the full message is still visible.
   */
  protected override message(msg: string, sep: string): string {
    const d = sseData(msg);
    const choices = Array.isArray(d?.json?.choices) ? d.json.choices : undefined;
    if (choices?.length === 1 && Array.isArray(choices[0]?.delta?.tool_calls) && choices[0].delta.tool_calls.length) {
      const ch = choices[0];
      const ci: number = typeof ch.index === "number" ? ch.index : 0;
      this.sawTool.set(ci, true);
      // the call's parts (id, type, name) are dropped with it; only non-call content (role, text) survives
      const keptDelta = { ...ch.delta };
      delete keptDelta.tool_calls;
      const kept = Object.keys(keptDelta).length ? withData(msg, { ...d!.json, choices: [{ ...ch, delta: keptDelta }] }) : null;
      if (kept !== null) {
        this.holdCall(ci, this.callName(ch), kept);
        return kept + sep;
      }
      this.holdCall(ci, this.callName(ch), msg);
      return "";
    }
    return super.message(msg, sep);
  }

  private callName(ch: any): string {
    return (ch.delta.tool_calls as any[]).map((tc: any) => (typeof tc?.function?.name === "string" ? tc.function.name : "")).join("");
  }
}

export const chatAdapter: WireAdapter = {
  id: "chat",
  matches: (method, path) => method === "POST" && /^\/v1\/chat\/completions(\?.*)?$/.test(path),
  schemas: chatSchemas,
  rewriteJson,
  rewriteStream: (schemas, rules, onFix) => new ChatToolArgsSse(schemas, rules, onFix),
  convertMarkup: (raw, ct, schemas, rules) => (/text\/event-stream/i.test(ct) ? convertSse(raw, schemas, rules) : convertJson(raw, schemas, rules)),
  guardStream: (ctx) => new ChatGuardSse(ctx),
};
