/**
 * prompt-tokens.ts — input-token counts for local servers that never report
 * them. vllm-mlx answers /v1/messages with `message_start` usage
 * `input_tokens: 0` and a final `message_delta` usage that carries only
 * `output_tokens` (measured 2026-10-18 against the local30x8 server), so a
 * worker run through the router records 0 input tokens and the A/B token
 * study loses the local arm's input side.
 *
 * The fix has two halves. `promptTokenCount` counts the prompt with the
 * tokenizer of the served model (the same HF tokenizer the server loads from
 * its model directory), rendering the request text the way the Qwen3-Coder
 * chat template does; it is a reconstruction, not the server's own count, and
 * callers must say so. `InputTokensSse` rewrites the `input_tokens` of
 * message_start (and of a message_delta that carries the field as 0) in the
 * stream the client sees — the same line-wise SSE transform style as
 * tool-case.ts. When no tokenizer is installed for the model the count is
 * unknown: the stream is passed through untouched and nothing is invented
 * (the router's own row keeps the chars/4 estimate, flagged input_estimated).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { Transform, type TransformCallback } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { installedModelDirs } from "../workers/local-tiers.js";

// ---- prompt text (a rendering of the Qwen3-Coder chat template) ----------

const TOOL_PREAMBLE =
  "\n\nYou have access to the following functions:\n\n<tools>";
const TOOL_EPILOGUE =
  "\n</tools>" +
  "\n\nIf you choose to call a function ONLY reply in the following format with NO suffix:\n\n" +
  "<tool_call>\n<function=example_function_name>\n<parameter=example_parameter_1>\nvalue_1\n</parameter>\n</function>\n</tool_call>\n\n" +
  "<IMPORTANT>\nReminder:\n- Function calls MUST follow the specified format: an inner <function=...></function> block must be nested within <tool_call></tool_call> XML tags\n" +
  "- Required parameters MUST be specified\n" +
  "- You may provide optional reasoning for your function call in natural language BEFORE the function call, but NOT after\n" +
  "- If there is no function call available, answer the question like normal with your current knowledge and do not tell the user about function calls\n</IMPORTANT>";

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      if (!b || typeof b !== "object") return "";
      const t = b as { type?: unknown; text?: unknown; name?: unknown; input?: unknown; content?: unknown; tool_use_id?: unknown };
      if (t.type === "text" && typeof t.text === "string") return t.text;
      if (t.type === "tool_use") return toolCallText(String(t.name ?? ""), t.input);
      if (t.type === "tool_result") return `<tool_response>\n${textOf(t.content)}\n</tool_response>\n`;
      return "";
    })
    .filter((s) => s !== "")
    .join("\n");
};

const toolCallText = (name: string, input: unknown): string => {
  const args = input && typeof input === "object" && !Array.isArray(input) ? Object.entries(input as Record<string, unknown>) : [];
  const params = args.map(([k, v]) => `<parameter=${k}>\n${typeof v === "string" ? v : JSON.stringify(v)}\n</parameter>\n`).join("");
  return `\n<tool_call>\n<function=${name}>\n${params}</function>\n</tool_call>`;
};

/** One tool schema the way the template's <function> block prints it. */
function toolText(name: unknown, description: unknown, parameters: unknown): string {
  const props = parameters && typeof parameters === "object" ? ((parameters as { properties?: Record<string, unknown> }).properties ?? {}) : {};
  const required = Array.isArray((parameters as { required?: unknown })?.required) ? ((parameters as { required: unknown[] }).required as string[]) : [];
  const params = Object.entries(props)
    .map(([k, f]) => {
      const fields = (f ?? {}) as { type?: unknown; description?: unknown; enum?: unknown };
      const parts = [`\n<name>${k}</name>`];
      if (fields.type !== undefined) parts.push(`\n<type>${String(fields.type)}</type>`);
      if (typeof fields.description === "string") parts.push(`\n<description>${fields.description.trim()}</description>`);
      if (Array.isArray(fields.enum) && fields.enum.length)
        parts.push(`\n<enum>[${fields.enum.map((e) => `\`${String(e)}\``).join(", ")}]</enum>`);
      if (required.length) parts.push(`\n<required>[${required.map((r) => `\`${String(r)}\``).join(", ")}]</required>`);
      return `\n<parameter>${parts.join("")}\n</parameter>`;
    })
    .join("");
  return `\n<function>\n<name>${String(name ?? "")}</name>\n<description>${String(description ?? "").trim()}</description>\n<parameters>${params}\n</parameters>\n</function>`;
}

/**
 * The prompt text a Qwen3-Coder-style chat template builds from an Anthropic
 * messages body: system block, tools section, then one <|im_start|> block per
 * message and the generation prompt. vllm-mlx converts the body to its chat
 * format before templating, so this mirrors that conversion (system blocks
 * joined, tool_result blocks as <tool_response>) — close to, not byte-equal
 * with, what the server renders.
 */
export function promptText(body: Record<string, unknown>): string {
  const system = textOf(body.system);
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const out: string[] = [];
  if (system) out.push(`<|im_start|>system\n${system}${tools.length ? TOOL_PREAMBLE + tools.map((t) => toolText((t as { name?: unknown }).name, (t as { description?: unknown }).description, (t as { input_schema?: unknown }).input_schema)).join("") + TOOL_EPILOGUE : ""}<|im_end|>\n`);
  else if (tools.length) out.push(`<|im_start|>system\nYou are Qwen, a helpful AI assistant that can interact with a computer to solve tasks.${TOOL_PREAMBLE}${tools.map((t) => toolText((t as { name?: unknown }).name, (t as { description?: unknown }).description, (t as { input_schema?: unknown }).input_schema)).join("")}${TOOL_EPILOGUE}<|im_end|>\n`);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const role = String((m as { role?: unknown }).role ?? "");
    out.push(`<|im_start|>${role}\n${textOf((m as { content?: unknown }).content)}<|im_end|>\n`);
  }
  out.push("<|im_start|>assistant\n");
  return out.join("");
}

// ---- the tokenizer the server uses ---------------------------------------

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Installed model directories whose name carries every token of the served id, e.g. "qwen3-coder-30b-8bit". */
export function tokenizerDirCandidates(model: string, dirs: { name: string; path: string }[] = installedModelDirs()): string[] {
  const tokens = norm(model).match(/[a-z]+|\d+/g) ?? [];
  if (!tokens.length) return [];
  return dirs
    .filter((d) => existsSync(join(d.path, "tokenizer.json")))
    .filter((d) => {
      const n = norm(d.name);
      return tokens.every((t) => n.includes(t));
    })
    .map((d) => d.path);
}

interface EncodingTokenizer {
  encode: (text: string) => { length: number };
}

let cached: { model: string; tokenizer: Promise<EncodingTokenizer | null> } | null = null;

async function loadTokenizer(dir: string): Promise<EncodingTokenizer | null> {
  try {
    const { AutoTokenizer } = (await import("@huggingface/transformers")) as { AutoTokenizer: { from_pretrained: (d: string) => Promise<unknown> } };
    const tok = (await AutoTokenizer.from_pretrained(dir)) as unknown;
    const enc = (tok as { encode?: unknown }).encode;
    return typeof enc === "function" ? ({ encode: (t: string) => enc.call(tok, t) } as EncodingTokenizer) : null;
  } catch {
    return null;
  }
}

/**
 * Tokenizer of the served model id, loaded once; null when no installed
 * model directory matches (the count then stays unknown).
 */
export function promptTokenizer(model: string): Promise<EncodingTokenizer | null> {
  if (cached?.model !== model) {
    const dir = tokenizerDirCandidates(model)[0];
    cached = { model, tokenizer: dir ? loadTokenizer(dir) : Promise.resolve(null) };
  }
  return cached.tokenizer;
}

/** For tests: forget the cached tokenizer. */
export function resetPromptTokenizer(): void {
  cached = null;
}

/** Number of tokens the model's tokenizer assigns to the request's prompt text, or null without a tokenizer. */
export async function promptTokenCount(
  body: Record<string, unknown>,
  model: string,
  tokenizer: Promise<EncodingTokenizer | null> = promptTokenizer(model)
): Promise<number | null> {
  const tok = await tokenizer;
  if (!tok) return null;
  const n = tok.encode(promptText(body)).length;
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ---- the client-visible fill ---------------------------------------------

const MAX_WAIT_MS = 10_000;

/**
 * Rewrites `input_tokens` of message_start (and of a message_delta carrying
 * the field as 0) to the counted prompt size before the client sees it. The
 * count loads lazily: lines are held (bounded by MAX_WAIT_MS) until it
 * resolves, then every other line passes through byte for byte. With a null
 * count nothing is rewritten.
 */
export class InputTokensSse extends Transform {
  private line = "";
  private readonly dec = new StringDecoder("utf8");
  private count: number | null = null;
  private settled = false;
  private queue: Array<{ chunk: Buffer; cb: TransformCallback }> = [];

  constructor(private readonly load: () => Promise<number | null>) {
    super();
  }

  private rewrite(raw: string): string {
    if (this.count === null) return raw;
    const cr = raw.endsWith("\r") ? "\r" : "";
    const line = cr ? raw.slice(0, -1) : raw;
    if (!line.includes('"usage"') || !/"message_(start|delta)"/.test(line)) return raw;
    try {
      const ev = JSON.parse(line.slice(5)) as {
        type?: unknown;
        message?: { usage?: { input_tokens?: unknown } };
        usage?: { input_tokens?: unknown };
      };
      const u = ev.type === "message_start" ? ev.message?.usage : ev.usage;
      if (!u || typeof u !== "object") return raw;
      // message_start: fill a missing or zero count. message_delta: only
      // correct a zero the server itself reported — never invent the field.
      if (ev.type === "message_start") {
        if (u.input_tokens !== undefined && u.input_tokens !== 0) return raw;
      } else if (u.input_tokens !== 0) return raw;
      u.input_tokens = this.count;
      return `data: ${JSON.stringify(ev)}${cr}`;
    } catch {
      return raw;
    }
  }

  private pushLine(raw: string): void {
    this.push(this.rewrite(raw) + "\n");
  }

  private drain(): void {
    const q = this.queue;
    this.queue = [];
    for (const { chunk, cb } of q) {
      this.feed(chunk);
      cb();
    }
  }

  private feed(chunk: Buffer): void {
    this.line += this.dec.write(chunk);
    const parts = this.line.split("\n");
    this.line = parts.pop() ?? "";
    for (const l of parts) this.pushLine(l);
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    if (this.settled) {
      this.feed(chunk);
      cb();
      return;
    }
    this.queue.push({ chunk, cb });
    if (this.queue.length > 1) return;
    const timer = setTimeout(() => {
      this.settled = true; // count took too long: stay passive, never block the stream
      this.drain();
    }, MAX_WAIT_MS);
    this.load()
      .catch(() => null)
      .then((c) => {
        clearTimeout(timer);
        if (this.settled) return;
        this.count = c;
        this.settled = true;
        this.drain();
      });
  }

  override _flush(cb: TransformCallback): void {
    const rest = this.line + this.dec.end();
    if (rest) this.pushLine(rest);
    this.line = "";
    cb();
  }
}
