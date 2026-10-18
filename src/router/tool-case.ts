/**
 * tool-case.ts — corrects wrong-case tool names in the model's response.
 *
 * Models call `bash` for the declared `Bash`; the harness answers "No such
 * tool available" and the run loses a turn. The router knows the request's
 * declared tools, so a tool_use whose name matches a declared tool
 * case-insensitively but not exactly is rewritten to the declared spelling
 * before the client sees it. Only `tool_use` content blocks are touched
 * (SSE content_block_start, or content[] of a JSON reply); every other byte
 * passes through unchanged.
 */

import { Transform, type TransformCallback } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/** Names in the request's `tools` array. */
export function declaredToolNames(requestBody: Buffer | string): string[] {
  try {
    const b = JSON.parse(typeof requestBody === "string" ? requestBody : requestBody.toString("utf8")) as { tools?: unknown };
    if (!Array.isArray(b.tools)) return [];
    return b.tools.flatMap((t) => (t && typeof (t as { name?: unknown }).name === "string" ? [(t as { name: string }).name] : []));
  } catch {
    return [];
  }
}

/** The declared spelling for a wrong-case name; null when exact, unknown or ambiguous. */
export function correctToolName(name: string, declared: readonly string[]): string | null {
  if (declared.includes(name)) return null;
  const hits = declared.filter((d) => d.toLowerCase() === name.toLowerCase());
  return hits.length === 1 ? hits[0] : null;
}

export type ToolCaseFix = (from: string, to: string) => void;

function fixBlock(block: unknown, declared: readonly string[], onFix: ToolCaseFix): boolean {
  const b = block as { type?: unknown; name?: unknown } | null;
  if (!b || b.type !== "tool_use" || typeof b.name !== "string") return false;
  const to = correctToolName(b.name, declared);
  if (!to) return false;
  onFix(b.name, to);
  b.name = to;
  return true;
}

/** Rewrites a non-streaming JSON reply; returns the input unchanged when nothing needed fixing. */
export function fixJsonReply(text: string, declared: readonly string[], onFix: ToolCaseFix): string {
  if (!declared.length || !text.includes('"tool_use"')) return text;
  try {
    const j = JSON.parse(text) as { content?: unknown };
    if (!Array.isArray(j.content)) return text;
    let changed = false;
    for (const c of j.content) changed = fixBlock(c, declared, onFix) || changed;
    changed = fixAg2Json(j, declared, onFix) || changed;
    return changed ? JSON.stringify(j) : text;
  } catch {
    return text;
  }
}

/** AG2 message kinds a model sometimes emits as a tool name instead of text. */
const AG2_KINDS = new Set(["R", "T", "Q", "S", "A", "X"]);

/** The AG2 message text for a tool_use named by a kind: kind line, then the input as key=value lines. */
export function renderAg2Call(kind: string, input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return kind;
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 1 && typeof entries[0][1] === "string") {
    const v = entries[0][1];
    return v.split("\n", 1)[0].trim() === kind ? v : `${kind}\n${v}`;
  }
  return [kind, ...entries.map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)].join("\n");
}

const isAg2Call = (b: { type?: unknown; name?: unknown }, declared: readonly string[]): boolean =>
  b.type === "tool_use" && typeof b.name === "string" && AG2_KINDS.has(b.name) && !declared.includes(b.name);

function parseInput(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

/** Rewrites AG2-kind tool_use blocks of a JSON reply to text blocks. */
function fixAg2Json(j: { content?: unknown }, declared: readonly string[], onFix: ToolCaseFix): boolean {
  if (!Array.isArray(j.content)) return false;
  let changed = false;
  j.content = j.content.map((c: { type?: unknown; name?: string; input?: unknown }) => {
    if (!c || !isAg2Call(c, declared)) return c;
    onFix(c.name as string, "text");
    changed = true;
    return { type: "text", text: renderAg2Call(c.name as string, c.input) };
  });
  return changed;
}

/**
 * Line-wise SSE transform: a `data:` line holding a content_block_start
 * tool_use is parsed and re-serialised when its name needs correcting; all
 * other lines are forwarded as they arrive, byte for byte. A tool_use named
 * by an AG2 kind (R, T, Q, S, A, X) that is not a declared tool is buffered
 * to its content_block_stop and emitted as a text block instead.
 */
export class ToolCaseSse extends Transform {
  private line = "";
  private readonly dec = new StringDecoder("utf8");
  private held: string | null = null;
  private dropHeld = false;
  private swallowBlank = false;
  private readonly calls = new Map<number, { name: string; json: string }>();
  private converted = false;
  private realTool = false;

  constructor(
    private readonly declared: readonly string[],
    private readonly onFix: ToolCaseFix
  ) {
    super();
  }

  /** Handles one line; null drops it. */
  private lineOut(raw: string): string | null {
    const bare = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (bare === "") {
      if (this.swallowBlank) {
        this.swallowBlank = false;
        return null;
      }
      return this.flushHeld(raw);
    }
    if (bare.startsWith("event:")) {
      const prev = this.held;
      this.held = raw;
      return prev;
    }
    if (!bare.startsWith("data:")) return this.flushHeld(raw);
    const out = this.data(raw);
    const held = this.held;
    this.held = null;
    if (out === null) {
      this.swallowBlank = true;
      return null;
    }
    if (this.dropHeld) {
      this.dropHeld = false;
      return out;
    }
    return held === null ? out : `${held}\n${out}`;
  }

  private flushHeld(raw: string): string {
    const held = this.held;
    this.held = null;
    return held === null ? raw : `${held}\n${raw}`;
  }

  private data(raw: string): string | null {
    const cr = raw.endsWith("\r") ? "\r" : "";
    const line = cr ? raw.slice(0, -1) : raw;
    if (!line.includes('"tool_use"') && !this.calls.size) return raw;
    try {
      const ev = JSON.parse(line.slice(5)) as {
        type?: unknown;
        index?: number;
        content_block?: { type?: unknown; name?: unknown; input?: unknown };
        delta?: { type?: unknown; partial_json?: unknown; stop_reason?: unknown };
      };
      const idx = ev.index as number;
      if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
        const b = ev.content_block;
        if (isAg2Call(b, this.declared)) {
          const init = b.input && Object.keys(b.input as object).length ? JSON.stringify(b.input) : "";
          this.calls.set(idx, { name: b.name as string, json: init });
          return null;
        }
        this.realTool = true;
        return fixBlock(ev.content_block, this.declared, this.onFix) ? `data: ${JSON.stringify(ev)}${cr}` : raw;
      }
      const call = this.calls.get(idx);
      if (call && ev.type === "content_block_delta" && ev.delta?.type === "input_json_delta") {
        call.json += String(ev.delta.partial_json ?? "");
        return null;
      }
      if (call && ev.type === "content_block_stop") {
        this.calls.delete(idx);
        this.converted = true;
        this.onFix(call.name, "text");
        const text = renderAg2Call(call.name, call.json ? parseInput(call.json) : {});
        const e = (type: string, body: object) => `event: ${type}\ndata: ${JSON.stringify({ type, index: idx, ...body })}${cr}`;
        this.dropHeld = true;
        return [
          e("content_block_start", { content_block: { type: "text", text: "" } }),
          e("content_block_delta", { delta: { type: "text_delta", text } }),
          e("content_block_stop", {}),
        ].join("\n\n");
      }
      if (this.converted && !this.realTool && ev.type === "message_delta" && ev.delta?.stop_reason === "tool_use") {
        ev.delta.stop_reason = "end_turn";
        return `data: ${JSON.stringify(ev)}${cr}`;
      }
      return raw;
    } catch {
      return raw;
    }
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.line += this.dec.write(chunk);
    const parts = this.line.split("\n");
    this.line = parts.pop() ?? "";
    const out = parts.map((l) => this.lineOut(l)).filter((l): l is string => l !== null);
    if (out.length) this.push(out.join("\n") + "\n");
    cb();
  }

  override _flush(cb: TransformCallback): void {
    const rest = this.line + this.dec.end();
    const out = rest ? this.lineOut(rest) : null;
    if (this.held !== null) this.push(this.held + "\n");
    if (out !== null) this.push(out);
    cb();
  }
}
