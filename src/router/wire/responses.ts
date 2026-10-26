/**
 * wire/responses.ts — OpenAI /v1/responses. Tool schemas are tools[]
 * {type:"function",name,parameters}; calls are output[] items
 * {type:"function_call",name,arguments,call_id}. Streaming repeats the
 * arguments in response.function_call_arguments.done, response.output_item.done
 * and the final response.completed, so each of them is repaired.
 */

import { randomBytes } from "node:crypto";
import { parseToolCallText, repairJson, type ToolArgsFix, type ToolSchemas } from "../tool-args.js";
import type { Rule } from "../tool-call-rules.js";
import { hasMalformedToolCall } from "../../workers/malformed-toolcall.js";
import { parseBody, SseMessages, sseData, toolSchemaOf, withData, type WireAdapter, type WireConverted } from "./types.js";

const rand = (p: string): string => `${p}_${randomBytes(12).toString("hex")}`;

export function responsesSchemas(body: Buffer | string): ToolSchemas {
  const out: ToolSchemas = new Map();
  const b = parseBody(body);
  for (const t of Array.isArray(b.tools) ? b.tools : []) {
    const x = t as { type?: unknown; name?: unknown; parameters?: unknown; function?: { name?: unknown; parameters?: unknown } };
    const f = typeof x?.name === "string" ? x : x?.function;
    if (typeof f?.name === "string") out.set(f.name, toolSchemaOf(f.parameters));
  }
  return out;
}

type Fix = (args: string, name: string) => string;

/** function_call items of an output array repaired in place; true when any changed. */
function fixOutput(output: unknown, fix: Fix): boolean {
  let changed = false;
  for (const it of Array.isArray(output) ? (output as any[]) : []) {
    if (it?.type !== "function_call" || typeof it.name !== "string" || typeof it.arguments !== "string") continue;
    const after = fix(it.arguments, it.name);
    if (after !== it.arguments) {
      it.arguments = after;
      changed = true;
    }
  }
  return changed;
}

function rewriteJson(reply: string, schemas: ToolSchemas, rules: () => readonly Rule[], onFix: ToolArgsFix): string {
  if (!schemas.size || !reply.includes('"function_call"')) return reply;
  try {
    const j = JSON.parse(reply) as { output?: unknown };
    return fixOutput(j.output, (a, n) => repairJson(a, n, schemas, rules, onFix)) ? JSON.stringify(j) : reply;
  } catch {
    return reply;
  }
}

interface Held {
  name: string;
  json: string;
  queue: Array<{ text: string; sep: string }>;
}

class ResponsesToolArgsSse extends SseMessages {
  private readonly calls = new Map<number, Held>();

  constructor(
    private readonly schemas: ToolSchemas,
    private readonly rules: () => readonly Rule[],
    private readonly onFix: ToolArgsFix
  ) {
    super();
  }

  private fix: Fix = (a, n) => repairJson(a, n, this.schemas, this.rules, this.onFix);

  protected override message(msg: string, sep: string): string {
    if (!msg.includes("function_call") && !msg.includes("response.completed") && !msg.includes("response.incomplete")) return msg + sep;
    const d = sseData(msg);
    const ev = d?.json;
    if (!ev || typeof ev.type !== "string") return msg + sep;
    const oi: number = typeof ev.output_index === "number" ? ev.output_index : 0;
    if (ev.type === "response.output_item.added" && ev.item?.type === "function_call") {
      this.calls.set(oi, { name: String(ev.item.name ?? ""), json: "", queue: [] });
      return msg + sep;
    }
    if (ev.type === "response.function_call_arguments.delta") {
      const h = this.calls.get(oi);
      if (!h) return msg + sep;
      h.json += String(ev.delta ?? "");
      h.queue.push({ text: msg, sep });
      return "";
    }
    if (ev.type === "response.function_call_arguments.done") {
      const h = this.calls.get(oi);
      const name = typeof ev.name === "string" ? ev.name : h?.name ?? "";
      const args = typeof ev.arguments === "string" ? ev.arguments : h?.json ?? "";
      const after = this.fix(args, name);
      this.calls.delete(oi);
      const held = h?.queue ?? [];
      if (after === args) return held.map((x) => x.text + x.sep).join("") + msg + sep;
      // same number of events, so sequence_number stays gapless: the first delta carries everything, the rest are empty
      const out = held.map((x, i) => {
        const dd = sseData(x.text);
        return (dd ? withData(x.text, { ...dd.json, delta: i === 0 ? after : "" }) : x.text) + x.sep;
      });
      return out.join("") + withData(msg, { ...ev, arguments: after }) + sep;
    }
    if (ev.type === "response.output_item.done" && ev.item?.type === "function_call" && typeof ev.item.arguments === "string") {
      const after = this.fix(ev.item.arguments, String(ev.item.name ?? ""));
      return (after === ev.item.arguments ? msg : withData(msg, { ...ev, item: { ...ev.item, arguments: after } })) + sep;
    }
    if (/^response\.(completed|incomplete)$/.test(ev.type) && ev.response) {
      return (fixOutput(ev.response.output, this.fix) ? withData(msg, ev) : msg) + sep;
    }
    return msg + sep;
  }

  protected override finish(): string {
    const rest = [...this.calls.values()].flatMap((h) => h.queue).map((x) => x.text + x.sep).join("");
    this.calls.clear();
    return rest;
  }
}

const textOf = (output: any[]): string =>
  output
    .filter((i) => i?.type === "message")
    .flatMap((i) => (Array.isArray(i.content) ? i.content : []))
    .map((c: any) => (c?.type === "output_text" && typeof c.text === "string" ? c.text : ""))
    .join("");

/** Output items replacing a message whose text held markup. */
function newItems(parsed: { before: string; calls: Array<{ name: string; input: Record<string, unknown> }> }): any[] {
  const items: any[] = [];
  if (parsed.before) {
    items.push({ id: rand("msg"), type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: parsed.before, annotations: [] }] });
  }
  for (const c of parsed.calls) {
    items.push({ id: rand("fc"), type: "function_call", status: "completed", call_id: rand("call"), name: c.name, arguments: JSON.stringify(c.input) });
  }
  return items;
}

function convertJson(raw: string, schemas: ToolSchemas, rules: readonly Rule[]): WireConverted | null {
  try {
    const j = JSON.parse(raw) as { output?: any[] };
    if (!Array.isArray(j.output) || j.output.some((i) => i?.type === "function_call")) return null;
    const text = textOf(j.output);
    if (!hasMalformedToolCall(text)) return null;
    const parsed = parseToolCallText(text, schemas, rules);
    if (!parsed || !parsed.calls.length) return null;
    j.output = [...j.output.filter((i) => i?.type !== "message"), ...newItems(parsed)];
    return { body: JSON.stringify(j), calls: parsed.calls };
  } catch {
    return null;
  }
}

function convertSse(raw: string, schemas: ToolSchemas, rules: readonly Rule[]): WireConverted | null {
  const evs = raw.split(/\r?\n\r?\n/).filter((m) => m.trim()).map((m) => sseData(m)?.json).filter(Boolean);
  const done = evs.find((e) => /^response\.(completed|incomplete)$/.test(e.type));
  const created = evs.find((e) => e.type === "response.created");
  if (!done?.response || !Array.isArray(done.response.output)) return null;
  const output: any[] = done.response.output;
  if (output.some((i) => i?.type === "function_call")) return null;
  const text = textOf(output);
  if (!hasMalformedToolCall(text)) return null;
  const parsed = parseToolCallText(text, schemas, rules);
  if (!parsed || !parsed.calls.length) return null;
  const items = newItems(parsed);
  const final = { ...done.response, output: [...output.filter((i) => i?.type !== "message"), ...items] };
  let seq = 0;
  const out: string[] = [];
  const emit = (type: string, body: object) => out.push(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...body })}`);
  if (created) emit("response.created", { response: created.response });
  items.forEach((it, oi) => {
    emit("response.output_item.added", { output_index: oi, item: it.type === "function_call" ? { ...it, arguments: "", status: "in_progress" } : { ...it, content: [] } });
    if (it.type === "function_call") {
      emit("response.function_call_arguments.delta", { output_index: oi, item_id: it.id, delta: it.arguments });
      emit("response.function_call_arguments.done", { output_index: oi, item_id: it.id, name: it.name, arguments: it.arguments });
    } else {
      emit("response.output_text.delta", { output_index: oi, item_id: it.id, content_index: 0, delta: it.content[0].text });
      emit("response.output_text.done", { output_index: oi, item_id: it.id, content_index: 0, text: it.content[0].text });
    }
    emit("response.output_item.done", { output_index: oi, item: it });
  });
  emit(done.type, { response: final });
  return { body: out.join("\n\n") + "\n\n", calls: parsed.calls };
}

export const responsesAdapter: WireAdapter = {
  id: "responses",
  matches: (method, path) => method === "POST" && /^\/v1\/responses(\?.*)?$/.test(path),
  schemas: responsesSchemas,
  rewriteJson,
  rewriteStream: (schemas, rules, onFix) => new ResponsesToolArgsSse(schemas, rules, onFix),
  convertMarkup: (raw, ct, schemas, rules) => (/text\/event-stream/i.test(ct) ? convertSse(raw, schemas, rules) : convertJson(raw, schemas, rules)),
};
