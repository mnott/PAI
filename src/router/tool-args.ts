/**
 * tool-args.ts — repairs a local model's tool-call arguments before the
 * client sees them, driven by the rules file (tool-call-rules.ts).
 *
 * Local models emit tool calls whose values swallowed the next parameter
 * ("true\n</parameter\n<parameter=-C>\n15"), carry junk tails
 * ("…\n</parameter>\n</end_parameter>\n</invoke>"), spell numbers and
 * booleans as strings ("120000", "True"), or name a parameter
 * "command </parameter". One engine serves two inputs: an already parsed
 * tool_use input (repairToolInput) and tool-call markup an engine left as
 * answer text (parseToolCallText). Nothing is touched without a rule hit:
 * a value no rule matches stays byte for byte, file content included.
 */

import { randomBytes } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { correctToolName } from "./tool-case.js";
import { activeRules, type Rule } from "./tool-call-rules.js";

export interface ToolSchema {
  properties: Record<string, { type?: string | string[] }>;
  required: string[];
}

export type ToolSchemas = Map<string, ToolSchema>;

export interface RepairResult {
  input: Record<string, unknown>;
  /** Rule ids (and coerce:number / coerce:boolean) that fired; empty = input returned as given. */
  hits: string[];
}

/** The request's declared tools with their parameter types and required lists. */
export function declaredToolSchemas(requestBody: Buffer | string): ToolSchemas {
  const out: ToolSchemas = new Map();
  try {
    const b = JSON.parse(typeof requestBody === "string" ? requestBody : requestBody.toString("utf8")) as { tools?: unknown };
    for (const t of Array.isArray(b.tools) ? b.tools : []) {
      const tool = t as { name?: unknown; input_schema?: { properties?: unknown; required?: unknown } };
      if (typeof tool?.name !== "string") continue;
      const props = tool.input_schema?.properties;
      const req = tool.input_schema?.required;
      out.set(tool.name, {
        properties: props && typeof props === "object" ? (props as ToolSchema["properties"]) : {},
        required: Array.isArray(req) ? req.filter((r): r is string => typeof r === "string") : [],
      });
    }
  } catch {
    /* no schemas */
  }
  return out;
}

const NUL = "\0";

function typeOf(schema: ToolSchema, key: string): string | undefined {
  const t = schema.properties[key]?.type;
  return Array.isArray(t) ? t.find((x) => x !== "null") : t;
}

const NUMERIC = /^\s*-?\d+(?:\.\d+)?\s*$/;

interface Opener {
  idx: number;
  len: number;
  name: string;
  id: string;
}

/** True when the string or any nested key/value still shows tool-call markup. */
export const MARKUP = /<\/?(?:parameter|function|invoke|tool_call|arguments|end_parameter|end_of_turn)\b|<parameter\s*=|<\|[a-z_]+\|>/;

/**
 * Repairs one tool_use input against its schema. `text` also applies rules
 * scoped to markup parsing (bare `<name>` openers); parsed inputs never use them.
 */
export function repairToolInput(
  input: Record<string, unknown>,
  schema: ToolSchema | undefined,
  allRules: readonly Rule[],
  opts: { text?: boolean } = {}
): RepairResult {
  if (!schema || !input || typeof input !== "object" || Array.isArray(input)) return { input, hits: [] };
  const rules = allRules.filter((r) => opts.text || r.scope !== "text");
  const of = (kind: Rule["kind"]) => rules.filter((r) => r.kind === kind);
  const openers = of("opener");
  const closers = of("closer");
  const junk = of("junk_line");
  const nameCuts = of("name_cut");
  const hits = new Set<string>();
  const declared = (k: string) => Object.prototype.hasOwnProperty.call(schema.properties, k);
  const hasProps = Object.keys(schema.properties).length > 0;

  // (c) parameter names cut at markup; a cut name that is not declared is dropped
  const named: Array<[string, unknown]> = [];
  const seenNames = new Set<string>();
  for (const [k, v] of Object.entries(input)) {
    let nk = k;
    for (const r of nameCuts) {
      const m = r.re.exec(k);
      if (m && m[1] && m[1] !== k) {
        nk = m[1];
        hits.add(r.id);
        break;
      }
    }
    if (nk !== k && ((hasProps && !declared(nk)) || seenNames.has(nk) || Object.prototype.hasOwnProperty.call(input, nk))) continue;
    seenNames.add(nk);
    named.push([nk, v]);
  }

  const taken = new Set(named.map(([k]) => k));
  // `{params}` in a pattern stands for the tool's declared parameter names
  const paramNames = Object.keys(schema.properties).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") || "(?!)";
  const compiled = (r: Rule, flags: string): RegExp => (r.pattern.includes("{params}") ? new RegExp(r.pattern.split("{params}").join(paramNames), flags) : new RegExp(r.re.source, flags));

  const firstOpener = (s: string, key: string): Opener | null => {
    let best: Opener | null = null;
    for (const r of openers) {
      const g = compiled(r, "gm");
      let m: RegExpExecArray | null;
      while ((m = g.exec(s))) {
        if (!m[0].length) {
          g.lastIndex++;
          continue;
        }
        const name = m[1];
        const selfAtStart = name === key && s.slice(0, m.index).trim() === "";
        if (name && declared(name) && (!taken.has(name) || selfAtStart)) {
          if (!best || m.index < best.idx || (m.index === best.idx && m[0].length > best.len)) best = { idx: m.index, len: m[0].length, name, id: r.id };
          break;
        }
      }
    }
    return best;
  };

  // (a) values that swallowed another declared, unset parameter are re-split
  const split = (key: string, s: string): Array<{ key: string; raw: string }> => {
    const o = firstOpener(s, key);
    if (!o) return [{ key, raw: s }];
    hits.add(o.id);
    const prefix = s.slice(0, o.idx);
    const rest = s.slice(o.idx + o.len);
    if (o.name === key && prefix.trim() === "") return split(key, rest);
    const head = prefix.trim() === "" ? [] : [{ key, raw: prefix }];
    taken.add(o.name);
    return [...head, ...split(o.name, rest)];
  };

  const firstCloser = (s: string): { idx: number; id: string } | null => {
    let best: { idx: number; id: string } | null = null;
    for (const r of closers) {
      const m = compiled(r, "m").exec(s);
      if (m && (!best || m.index < best.idx)) best = { idx: m.index, id: r.id };
    }
    return best;
  };

  const isJunk = (line: string, typed: boolean): string | null => junk.find((r) => (typed || !r.typed_only) && r.re.test(line))?.id ?? null;

  // (b) closer line ends the value; junk lines are stripped from its tail (or everywhere for a typed value)
  const clean = (key: string, raw: string): string => {
    let v = raw;
    const c = firstCloser(v);
    if (c) {
      hits.add(c.id);
      v = v.slice(0, c.idx).replace(/\r?\n$/, "");
    }
    const t = typeOf(schema, key);
    const typed = t === "number" || t === "integer" || t === "boolean";
    const lines = v.split("\n");
    if (typed) {
      const kept = lines.filter((l) => {
        const id = isJunk(l, true);
        if (id) hits.add(id);
        return !id;
      });
      if (kept.length !== lines.length) v = kept.join("\n");
    } else {
      let end = lines.length;
      let dropped = false;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].trim() === "") continue;
        const id = isJunk(lines[i], false);
        if (!id) break;
        hits.add(id);
        dropped = true;
        end = i;
      }
      if (dropped) v = lines.slice(0, end).join("\n");
    }
    return v;
  };

  // (d) declared JSON types: a value whose schema type is boolean/number/integer arrives as that
  // type. Rule-file bool_true/bool_false spellings fire first (their ids count in the rule stats);
  // any other case spelling coerces under the pseudo id coerce:boolean, numeric strings under
  // coerce:number — and a value already parsed to the wrong JSON type (a "true" for a declared
  // boolean) is coerced the same way: a local model sends it and the client rejects a string.
  const BOOL_RE = /^(?:true|false)$/i;
  const INT_RE = /^-?\d+$/;
  const coerce = (key: string, v: string): unknown => {
    const t = typeOf(schema, key);
    const s = v.trim();
    if (t === "boolean") {
      const tr = of("bool_true").find((r) => r.re.test(s));
      if (tr) return hits.add(tr.id), true;
      const fr = of("bool_false").find((r) => r.re.test(s));
      if (fr) return hits.add(fr.id), false;
      // any case spelling the rules do not list still has to arrive as a boolean
      if (BOOL_RE.test(s)) {
        hits.add("coerce:boolean");
        return s.toLowerCase() === "true";
      }
    } else if ((t === "number" || t === "integer") && NUMERIC.test(s) && (t === "number" || INT_RE.test(s))) {
      hits.add("coerce:number");
      return Number(s);
    }
    return v;
  };

  const out: Record<string, unknown> = {};
  for (const [k, v] of named) {
    if (typeof v !== "string") {
      const t = typeOf(schema, k);
      // wrong JSON type against the declared schema: a number/integer sent as a boolean, a boolean
      // or integer sent as a number; never a string property and never content
      if (t === "boolean" && typeof v === "number") {
        hits.add("coerce:boolean");
        out[k] = v !== 0;
        continue;
      }
      if ((t === "number" || t === "integer") && typeof v === "boolean") {
        hits.add("coerce:number");
        out[k] = v ? 1 : 0;
        continue;
      }
      out[k] = v;
      continue;
    }
    for (const seg of split(k, v)) {
      if (seg.key === NUL) continue;
      out[seg.key] = coerce(seg.key, clean(seg.key, seg.raw));
    }
  }
  if (!hits.size) return { input, hits: [] };
  return { input: out, hits: [...hits] };
}

/** Required parameters missing from an input. */
export function missingRequired(input: Record<string, unknown>, schema: ToolSchema | undefined): string[] {
  return (schema?.required ?? []).filter((k) => input[k] === undefined || input[k] === null || input[k] === "");
}

// ---------------------------------------------------------------------------
// tool-call markup left as answer text

export interface ParsedCall {
  name: string;
  input: Record<string, unknown>;
  hits: string[];
}

export interface ParsedText {
  /** Answer text before the first call (may be empty). */
  before: string;
  calls: ParsedCall[];
}

const START_SRC = String.raw`<function\s*=\s*([^>\s]+)\s*>|<invoke\s+name\s*=\s*["']([^"']+)["']\s*>|<tool_call>\s*(?=\{)`;

/** The JSON object starting at s[from], or null. */
function jsonObjectAt(s: string, from: number): { value: unknown; end: number } | null {
  let depth = 0;
  let inStr = false;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return { value: JSON.parse(s.slice(from, i + 1)), end: i + 1 };
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Turns tool-call markup in answer text into calls of declared tools, or null
 * when any call cannot be made whole (unknown tool, missing required
 * parameter, unparsable JSON): the caller then falls back to the retry.
 */
export function parseToolCallText(text: string, schemas: ToolSchemas, rules: readonly Rule[]): ParsedText | null {
  const active = [...rules];
  const names = [...schemas.keys()];
  const tokens: Array<{ start: number; end: number; name?: string; json?: unknown }> = [];
  // `<Read>` as a bare tag naming a declared tool starts a call too
  const bare = names.length ? `|<(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})>` : "";
  const g = new RegExp(START_SRC + bare, "g");
  let m: RegExpExecArray | null;
  while ((m = g.exec(text))) {
    if (m[1] || m[2] || m[3]) tokens.push({ start: m.index, end: m.index + m[0].length, name: m[1] ?? m[2] ?? m[3] });
    else {
      const o = jsonObjectAt(text, m.index + m[0].length);
      if (!o) return null;
      tokens.push({ start: m.index, end: o.end, json: o.value });
      g.lastIndex = o.end;
    }
  }
  if (!tokens.length) return null;
  let before = text.slice(0, tokens[0].start);
  while (/<tool_call>\s*$/.test(before)) before = before.replace(/<tool_call>\s*$/, "");
  const calls: ParsedCall[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    let name: string;
    let input: Record<string, unknown>;
    let hits: string[] = [];
    if (t.json !== undefined) {
      const j = t.json as { name?: unknown; arguments?: unknown; parameters?: unknown; input?: unknown };
      let a = j.arguments ?? j.parameters ?? j.input ?? {};
      if (typeof a === "string") {
        try {
          a = JSON.parse(a);
        } catch {
          return null;
        }
      }
      if (typeof j.name !== "string" || !a || typeof a !== "object" || Array.isArray(a)) return null;
      name = j.name;
      input = a as Record<string, unknown>;
    } else {
      name = t.name as string;
      const body = text.slice(t.end, i + 1 < tokens.length ? tokens[i + 1].start : text.length);
      const trimmed = body.trim();
      const args = /^<arguments>\s*([\s\S]*?)\s*(?:<\/arguments>|$)/.exec(trimmed);
      const jsonText = args ? args[1] : trimmed.startsWith("{") ? trimmed : null;
      if (jsonText !== null) {
        const o = jsonObjectAt(jsonText, 0);
        if (!o || !o.value || typeof o.value !== "object" || Array.isArray(o.value)) return null;
        input = o.value as Record<string, unknown>;
      } else {
        input = { [NUL]: body };
      }
    }
    const exact = names.includes(name) ? name : correctToolName(name, names);
    if (!exact) return null;
    const schema = schemas.get(exact) as ToolSchema;
    const fixed = repairToolInput(input, schema, active, { text: true });
    const final = { ...fixed.input };
    delete final[NUL];
    if (missingRequired(final, schema).length) return null;
    hits = fixed.hits;
    calls.push({ name: exact, input: final, hits });
  }
  return { before: before.trim(), calls };
}

// ---------------------------------------------------------------------------
// SSE and JSON wiring

/** Text the client sees in place of a tool call whose arguments were cut off (output limit) or are not JSON. */
export const cutOffNote = (tool: string, stopReason?: string): string =>
  stopReason === undefined || stopReason === "max_tokens" || stopReason === "length"
    ? `[The ${tool} call was cut off before its arguments were complete (output limit reached). Nothing was executed. Write large files in several smaller parts.]`
    : `[The ${tool} call was dropped: its arguments were not valid JSON. Nothing was executed. Send the call again with well-formed arguments.]`;

const newToolId = (): string => `toolu_${randomBytes(12).toString("hex")}`;

/** The top-level JSON objects of `s` when it is 2+ of them back to back (whitespace between), else null. */
export function splitJsonObjects(s: string): string[] | null {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    if (s[i] !== "{") return null;
    const o = jsonObjectAt(s, i);
    if (!o || !o.value || typeof o.value !== "object" || Array.isArray(o.value)) return null;
    out.push(s.slice(i, o.end));
    i = o.end;
  }
  return out.length >= 2 ? out : null;
}

/** True when a tool call's assembled arguments are not a complete JSON value (an empty string means no arguments). */
export function argsInvalid(json: string): boolean {
  if (!json) return false;
  try {
    JSON.parse(json);
    return false;
  } catch {
    return true;
  }
}

export type ToolArgsFix = (info: { tool: string; rules: string[] }) => void;

export function repairJson(json: string, tool: string, schemas: ToolSchemas, rules: () => readonly Rule[], onFix: ToolArgsFix): string {
  if (!json) return json;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return json;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json;
  const r = repairToolInput(parsed as Record<string, unknown>, schemas.get(tool), rules());
  if (!r.hits.length) return json;
  onFix({ tool, rules: r.hits });
  return JSON.stringify(r.input);
}

/** Rewrites tool_use inputs of a non-streaming JSON reply; unchanged text when nothing needed repair. */
export function repairJsonReplyArgs(text: string, schemas: ToolSchemas, rules: () => readonly Rule[], onFix: ToolArgsFix): string {
  if (!text.includes('"tool_use"')) return text;
  try {
    const j = JSON.parse(text) as { content?: unknown; stop_reason?: unknown };
    if (!Array.isArray(j.content)) return text;
    let changed = false;
    const out: unknown[] = [];
    for (const c of j.content as Array<{ type?: unknown; id?: unknown; name?: unknown; input?: unknown }>) {
      if (c?.type === "tool_use" && typeof c.name === "string" && typeof c.input === "string" && c.input) {
        // raw argument text the engine could not parse: concatenated objects become separate calls
        const parts = splitJsonObjects(c.input);
        if (parts) {
          parts.forEach((p, k) => out.push({ ...c, id: k === 0 ? c.id : newToolId(), input: JSON.parse(repairJson(p, c.name as string, schemas, rules, onFix)) }));
          changed = true;
        } else if (argsInvalid(c.input)) {
          out.push({ type: "text", text: cutOffNote(c.name, String(j.stop_reason ?? "")) });
          changed = true;
        } else out.push({ ...c, input: JSON.parse(c.input) });
        continue;
      }
      out.push(c);
      if (!schemas.size || c?.type !== "tool_use" || typeof c.name !== "string" || !c.input || typeof c.input !== "object") continue;
      const before = JSON.stringify(c.input);
      const after = repairJson(before, c.name, schemas, rules, onFix);
      if (after !== before) {
        c.input = JSON.parse(after);
        changed = true;
      }
    }
    if (changed) j.content = out;
    return changed ? JSON.stringify(j) : text;
  } catch {
    return text;
  }
}

/**
 * SSE transform: a tool_use block's input_json_delta events are held to its
 * content_block_stop, reassembled, repaired by the rules and emitted as one
 * delta. Every other event passes through byte for byte.
 */
export class ToolArgsSse extends Transform {
  private buf = "";
  private readonly dec = new StringDecoder("utf8");
  private readonly calls = new Map<number, { name: string; json: string; start: string }>();
  private keptTools = 0;
  private droppedTools = 0;
  /** extra blocks emitted so far by splitting: every later index moves up by this */
  private shift = 0;
  /** a dropped call's note, held until the stop_reason (message_delta) is known */
  private pending: { idx: number; name: string; stop: string } | null = null;

  constructor(
    private readonly schemas: ToolSchemas,
    private readonly rules: () => readonly Rule[],
    private readonly onFix: ToolArgsFix
  ) {
    super();
  }

  private noteBlock(idx: number, name: string, stopReason?: string): string {
    const start = { type: "content_block_start", index: idx, content_block: { type: "text", text: "" } };
    const delta = { type: "content_block_delta", index: idx, delta: { type: "text_delta", text: cutOffNote(name, stopReason) } };
    return `event: content_block_start\ndata: ${JSON.stringify(start)}\n\nevent: content_block_delta\ndata: ${JSON.stringify(delta)}\n\n`;
  }

  private static withData(msg: string, ev: unknown): string {
    return msg.split("\n").map((l) => (l.startsWith("data:") ? `data: ${JSON.stringify(ev)}` : l)).join("\n");
  }

  /** Output for one complete SSE message (without its blank-line separator); null drops it. */
  private message(msg: string): string | null {
    if (!msg.includes('"tool_use"') && !this.calls.size && !msg.includes('"message_delta"') && !this.shift && !this.pending) return msg;
    const line = msg.split("\n").find((l) => l.startsWith("data:"));
    if (!line) return msg;
    try {
      const ev = JSON.parse(line.slice(5)) as {
        type?: unknown;
        index?: number;
        content_block?: { type?: unknown; id?: unknown; name?: unknown; input?: unknown };
        delta?: { type?: unknown; partial_json?: unknown; stop_reason?: unknown };
      };
      let pre = "";
      if (this.pending) {
        const pd = this.pending;
        this.pending = null;
        const isDelta = ev.type === "message_delta";
        pre = this.noteBlock(pd.idx, pd.name, isDelta ? String(ev.delta?.stop_reason ?? "") : "") + pd.stop + "\n\n";
      }
      const out = this.event(msg, ev);
      return out === null ? (pre ? pre.replace(/\n\n$/, "") : null) : pre + out;
    } catch {
      /* not JSON: pass through */
    }
    return msg;
  }

  private event(
    msg: string,
    ev: {
      type?: unknown;
      index?: number;
      content_block?: { type?: unknown; id?: unknown; name?: unknown; input?: unknown };
      delta?: { type?: unknown; partial_json?: unknown; stop_reason?: unknown };
    }
  ): string | null {
    const rawIdx = ev.index as number;
    const idx = rawIdx + this.shift;
    if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use" && typeof ev.content_block.name === "string") {
      const init = ev.content_block.input && Object.keys(ev.content_block.input as object).length ? JSON.stringify(ev.content_block.input) : "";
      // the start is held with the arguments: a call that turns out cut off is replaced, not announced
      this.calls.set(rawIdx, { name: ev.content_block.name, json: init, start: msg });
      return null;
    }
    if (ev.type === "message_delta" && this.droppedTools && !this.keptTools && ev.delta?.stop_reason === "tool_use") {
      ev.delta.stop_reason = "end_turn";
      return ToolArgsSse.withData(msg, ev);
    }
    const call = this.calls.get(rawIdx);
    if (!call) {
      if (!this.shift || typeof ev.index !== "number") return msg;
      return ToolArgsSse.withData(msg, { ...ev, index: idx });
    }
    if (ev.type === "content_block_delta" && ev.delta?.type === "input_json_delta") {
      call.json += String(ev.delta.partial_json ?? "");
      return null;
    }
    if (ev.type === "content_block_stop") {
      this.calls.delete(rawIdx);
      const stopMsg = `event: content_block_stop\ndata: ${JSON.stringify({ ...ev, index: idx })}`;
      const parts = splitJsonObjects(call.json);
      if (parts) {
        // several complete objects in one block (parallel calls): one tool_use block per object
        const startEv = JSON.parse((call.start.split("\n").find((l) => l.startsWith("data:")) as string).slice(5)) as { content_block: Record<string, unknown> };
        let out = "";
        parts.forEach((p, k) => {
          const bi = idx + k;
          const cb = { ...startEv.content_block, id: k === 0 ? startEv.content_block.id : newToolId(), input: {} };
          const json = repairJson(p, call.name, this.schemas, this.rules, this.onFix);
          const d = { type: "content_block_delta", index: bi, delta: { type: "input_json_delta", partial_json: json } };
          out += `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: bi, content_block: cb })}\n\n`;
          out += `event: content_block_delta\ndata: ${JSON.stringify(d)}\n\n`;
          out += `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: bi })}` + (k < parts.length - 1 ? "\n\n" : "");
        });
        this.keptTools += parts.length;
        this.shift += parts.length - 1;
        return out;
      }
      if (argsInvalid(call.json)) {
        // cut off mid-arguments or not JSON: never forward half a JSON value, say so as text once stop_reason is known
        this.droppedTools++;
        this.pending = { idx, name: call.name, stop: stopMsg };
        return null;
      }
      this.keptTools++;
      const start = this.shift ? ToolArgsSse.withData(call.start, { ...(JSON.parse((call.start.split("\n").find((l) => l.startsWith("data:")) as string).slice(5)) as object), index: idx }) : call.start;
      if (!call.json) return `${start}\n\n${stopMsg}`;
      const json = repairJson(call.json, call.name, this.schemas, this.rules, this.onFix);
      const delta = { type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: json } };
      return `${start}\n\n` + `event: content_block_delta\ndata: ${JSON.stringify(delta)}\n\n${stopMsg}`;
    }
    return msg;
  }

  private drain(): void {
    const sep = /\r?\n\r?\n/g;
    const out: string[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = sep.exec(this.buf))) {
      const o = this.message(this.buf.slice(last, m.index));
      if (o !== null) out.push(o + m[0]);
      last = m.index + m[0].length;
    }
    this.buf = this.buf.slice(last);
    if (out.length) this.push(out.join(""));
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.buf += this.dec.write(chunk);
    this.drain();
    cb();
  }

  override _flush(cb: TransformCallback): void {
    this.buf += this.dec.end();
    if (this.buf) {
      const tail = this.buf;
      this.buf = "";
      const o = this.message(tail);
      if (o !== null) this.push(o);
    }
    if (this.pending) {
      const pd = this.pending;
      this.pending = null;
      this.push(this.noteBlock(pd.idx, pd.name, "") + pd.stop + "\n\n");
    }
    cb();
  }
}

export { activeRules };
