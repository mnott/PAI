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
    return changed ? JSON.stringify(j) : text;
  } catch {
    return text;
  }
}

/**
 * Line-wise SSE transform: a `data:` line holding a content_block_start
 * tool_use is parsed and re-serialised when its name needs correcting; all
 * other lines are forwarded as they arrive, byte for byte.
 */
export class ToolCaseSse extends Transform {
  private line = "";
  private readonly dec = new StringDecoder("utf8");

  constructor(
    private readonly declared: readonly string[],
    private readonly onFix: ToolCaseFix
  ) {
    super();
  }

  private fix(raw: string): string {
    const cr = raw.endsWith("\r") ? "\r" : "";
    const line = cr ? raw.slice(0, -1) : raw;
    if (!line.startsWith("data:") || !line.includes('"tool_use"')) return raw;
    try {
      const ev = JSON.parse(line.slice(5)) as { type?: unknown; content_block?: unknown };
      if (ev.type !== "content_block_start") return raw;
      return fixBlock(ev.content_block, this.declared, this.onFix) ? `data: ${JSON.stringify(ev)}${cr}` : raw;
    } catch {
      return raw;
    }
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.line += this.dec.write(chunk);
    const parts = this.line.split("\n");
    this.line = parts.pop() ?? "";
    if (parts.length) this.push(parts.map((l) => this.fix(l)).join("\n") + "\n");
    cb();
  }

  override _flush(cb: TransformCallback): void {
    const rest = this.line + this.dec.end();
    if (rest) this.push(this.fix(rest));
    cb();
  }
}
