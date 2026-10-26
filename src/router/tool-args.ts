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

  // (d) declared JSON types
  const coerce = (key: string, v: string): unknown => {
    const t = typeOf(schema, key);
    const s = v.trim();
    if (t === "boolean") {
      const tr = of("bool_true").find((r) => r.re.test(s));
      if (tr) return hits.add(tr.id), true;
      const fr = of("bool_false").find((r) => r.re.test(s));
      if (fr) return hits.add(fr.id), false;
    } else if ((t === "number" || t === "integer") && NUMERIC.test(s) && (t === "number" || /^-?\d+$/.test(s.trim()))) {
      hits.add("coerce:number");
      return Number(s);
    }
    return v;
  };

  const out: Record<string, unknown> = {};
  for (const [k, v] of named) {
    if (typeof v !== "string") {
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
  if (!schemas.size || !text.includes('"tool_use"')) return text;
  try {
    const j = JSON.parse(text) as { content?: unknown };
    if (!Array.isArray(j.content)) return text;
    let changed = false;
    for (const c of j.content as Array<{ type?: unknown; name?: unknown; input?: unknown }>) {
      if (c?.type !== "tool_use" || typeof c.name !== "string" || !c.input || typeof c.input !== "object") continue;
      const before = JSON.stringify(c.input);
      const after = repairJson(before, c.name, schemas, rules, onFix);
      if (after !== before) {
        c.input = JSON.parse(after);
        changed = true;
      }
    }
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
  private readonly calls = new Map<number, { name: string; json: string }>();

  constructor(
    private readonly schemas: ToolSchemas,
    private readonly rules: () => readonly Rule[],
    private readonly onFix: ToolArgsFix
  ) {
    super();
  }

  /** Output for one complete SSE message (without its blank-line separator); null drops it. */
  private message(msg: string): string | null {
    if (!msg.includes('"tool_use"') && !this.calls.size) return msg;
    const line = msg.split("\n").find((l) => l.startsWith("data:"));
    if (!line) return msg;
    try {
      const ev = JSON.parse(line.slice(5)) as {
        type?: unknown;
        index?: number;
        content_block?: { type?: unknown; name?: unknown; input?: unknown };
        delta?: { type?: unknown; partial_json?: unknown };
      };
      const idx = ev.index as number;
      if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use" && typeof ev.content_block.name === "string") {
        const init = ev.content_block.input && Object.keys(ev.content_block.input as object).length ? JSON.stringify(ev.content_block.input) : "";
        this.calls.set(idx, { name: ev.content_block.name, json: init });
        return msg;
      }
      const call = this.calls.get(idx);
      if (!call) return msg;
      if (ev.type === "content_block_delta" && ev.delta?.type === "input_json_delta") {
        call.json += String(ev.delta.partial_json ?? "");
        return null;
      }
      if (ev.type === "content_block_stop") {
        this.calls.delete(idx);
        if (!call.json) return msg;
        const json = repairJson(call.json, call.name, this.schemas, this.rules, this.onFix);
        const delta = { type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: json } };
        return `event: content_block_delta\ndata: ${JSON.stringify(delta)}\n\n${msg}`;
      }
    } catch {
      /* not JSON: pass through */
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
    cb();
  }
}

export { activeRules };
