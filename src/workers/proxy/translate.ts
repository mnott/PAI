/**
 * translate.ts — Anthropic Messages API ↔ OpenAI Chat Completions, in pure
 * functions. The proxy server (server.ts) is a thin shell over these; the
 * tests feed recorded request/response pairs straight in.
 *
 * Mapping table:
 *
 *   Anthropic                          OpenAI
 *   ─────────────────────────────────  ─────────────────────────────────
 *   system (string | blocks)           messages[0] {role:"system"}
 *   user text block                    {role:"user", content:"…"}
 *   assistant text block               {role:"assistant", content:"…"}
 *   assistant tool_use                 assistant.tool_calls[{id,type:
 *                                      "function",function:{name,arguments}}]
 *   user tool_result                   {role:"tool", tool_call_id, content}
 *   tools[].input_schema              tools[].function.parameters
 *   max_tokens / temperature           max_tokens / temperature
 *   stop_sequences                     stop
 *   stream                             stream (+ stream_options.usage)
 *   stop_reason end_turn/tool_use/…    finish_reason stop/tool_calls/length
 *   usage input/output_tokens          usage prompt/completion_tokens
 */

// ---------------------------------------------------------------------------
// Types (only the fields the translation touches)
// ---------------------------------------------------------------------------

export interface AnthropicContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicRequest {
  model?: string;
  max_tokens?: number;
  temperature?: number;
  stop_sequences?: string[];
  stream?: boolean;
  system?: string | AnthropicContentBlock[];
  messages?: AnthropicMessage[];
  tools?: Array<{ name?: string; description?: string; input_schema?: unknown }>;
}

export interface OpenAiFunctionCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
  index?: number;
}

export interface OpenAiRequest {
  model?: string;
  max_tokens?: number;
  temperature?: number;
  stop?: string[];
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  messages: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
}

export interface OpenAiResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: { role?: string; content?: string | null; tool_calls?: OpenAiFunctionCall[] };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; type?: string; code?: unknown };
}

export interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

// ---------------------------------------------------------------------------
// Request: Anthropic → OpenAI
// ---------------------------------------------------------------------------

function systemText(system: AnthropicRequest["system"]): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n")
    .trim();
}

/** One OpenAI message from one assistant tool_use block's arguments. */
function toolCallFromBlock(b: AnthropicContentBlock): Record<string, unknown> {
  return {
    id: b.id ?? "",
    type: "function",
    function: { name: b.name ?? "", arguments: JSON.stringify(b.input ?? {}) },
  };
}

function toolResultText(b: AnthropicContentBlock): string {
  if (typeof b.content === "string") return b.content;
  if (Array.isArray(b.content)) {
    return b.content
      .map((x) => (typeof x === "object" && x !== null && "text" in x ? String((x as { text?: string }).text ?? "") : ""))
      .join("\n");
  }
  return "";
}

/** Translate an Anthropic Messages request into a Chat Completions request. */
export function anthropicToOpenAi(req: AnthropicRequest, model: string): OpenAiRequest {
  const messages: Array<Record<string, unknown>> = [];
  const sys = systemText(req.system);
  if (sys) messages.push({ role: "system", content: sys });

  for (const m of req.messages ?? []) {
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    if (m.role === "assistant") {
      const text = (blocks ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      const calls = (blocks ?? []).filter((b) => b.type === "tool_use").map(toolCallFromBlock);
      const msg: Record<string, unknown> = { role: "assistant", content: text || null };
      if (calls.length) msg.tool_calls = calls;
      messages.push(msg);
    } else {
      // user: tool_result blocks become their own role:"tool" messages (in
      // order), plain text blocks join into one user message
      const texts: string[] = [];
      for (const b of blocks ?? []) {
        if (b.type === "tool_result") {
          messages.push({
            role: "tool",
            tool_call_id: b.tool_use_id ?? "",
            content: toolResultText(b),
          });
        } else if (b.type === "text" && (b.text ?? "").trim()) {
          texts.push(b.text ?? "");
        }
      }
      if (texts.length) messages.push({ role: "user", content: texts.join("\n") });
    }
  }

  const out: OpenAiRequest = {
    model,
    max_tokens: req.max_tokens ?? 8192,
    messages,
  };
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.stop_sequences?.length) out.stop = req.stop_sequences;
  if (req.stream) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  if (req.tools?.length) {
    out.tools = req.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name ?? "",
        description: t.description ?? "",
        parameters: t.input_schema ?? { type: "object", properties: {} },
      },
    }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Response: OpenAI → Anthropic (non-streaming)
// ---------------------------------------------------------------------------

function stopReasonFrom(finish: string | null | undefined): AnthropicResponse["stop_reason"] {
  switch (finish) {
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "stop":
      return "stop_sequence";
    default:
      return "end_turn";
  }
}

/** Translate a Chat Completions response into an Anthropic message. */
export function openAiToAnthropic(res: OpenAiResponse, model: string): AnthropicResponse {
  const choice = res.choices?.[0];
  const msg = choice?.message;
  const content: AnthropicContentBlock[] = [];
  if (msg?.content) content.push({ type: "text", text: msg.content });
  for (const call of msg?.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = JSON.parse(call.function?.arguments || "{}") as unknown;
    } catch {
      input = { _raw: call.function?.arguments ?? "" };
    }
    content.push({ type: "tool_use", id: call.id ?? "", name: call.function?.name ?? "", input });
  }
  return {
    id: `msg_${res.id ?? Date.now().toString(36)}`,
    type: "message",
    role: "assistant",
    model: res.model ?? model,
    content,
    stop_reason: stopReasonFrom(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: res.usage?.prompt_tokens ?? 0,
      output_tokens: res.usage?.completion_tokens ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Errors: OpenAI → Anthropic error JSON
// ---------------------------------------------------------------------------

export interface AnthropicErrorBody {
  type: "error";
  error: { type: string; message: string };
}

/** Anthropic-style error for an upstream status + body. */
export function anthropicError(status: number, upstreamBody: string): AnthropicErrorBody {
  let message = upstreamBody.slice(0, 2000);
  let upstreamType = "";
  try {
    const parsed = JSON.parse(upstreamBody) as { error?: { message?: string; type?: string }; message?: string };
    message = parsed.error?.message ?? parsed.message ?? message;
    upstreamType = parsed.error?.type ?? "";
  } catch {
    // non-JSON error body — keep the raw text
  }
  let type: string;
  if (status === 429) type = "rate_limit_error";
  else if (status === 401 || status === 403) type = "authentication_error";
  else if (status === 400 || status === 404 || status === 422) type = "invalid_request_error";
  else if (status === 402 || status >= 500) type = "api_error";
  else if (upstreamType) type = upstreamType;
  else type = "api_error";
  return { type: "error", error: { type, message } };
}

// ---------------------------------------------------------------------------
// Streaming: OpenAI chunk stream → Anthropic SSE event stream
// ---------------------------------------------------------------------------

interface ToolCallAccumulator {
  id: string;
  name: string;
  args: string;
  /** Anthropic content-block index once the block was opened. */
  blockIndex: number | null;
}

/**
 * State machine turning parsed OpenAI stream chunks into Anthropic SSE event
 * strings ("event: …\ndata: …\n\n"). Feed every chunk in arrival order, call
 * finish() after the "[DONE]" sentinel (or upstream end) — never both mid-
 * stream and again later; the instance is single-use.
 */
export class OpenAiStreamTranslator {
  private messageStarted = false;
  private openBlock: { index: number; kind: "text" } | null = null;
  private toolCalls = new Map<number, ToolCallAccumulator>();
  private nextBlockIndex = 0;
  private outputTokens = 0;
  private stopReason: AnthropicResponse["stop_reason"] = "end_turn";
  private finished = false;
  private model: string;
  private id: string;

  constructor(model: string, id = `msg_${Date.now().toString(36)}`) {
    this.model = model;
    this.id = id;
  }

  /** SSE wire form of one Anthropic stream event. */
  static sse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  /** Consume one parsed OpenAI chunk; returns SSE text to forward (may be ""). */
  feed(chunk: {
    choices?: Array<{
      delta?: { content?: string | null; tool_calls?: OpenAiFunctionCall[] };
      finish_reason?: string | null;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  }): string {
    if (this.finished) return "";
    const out: string[] = [];
    if (!this.messageStarted) {
      this.messageStarted = true;
      out.push(
        OpenAiStreamTranslator.sse("message_start", {
          type: "message_start",
          message: {
            id: this.id,
            type: "message",
            role: "assistant",
            model: this.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: chunk.usage?.prompt_tokens ?? 0, output_tokens: 0 },
          },
        })
      );
    }
    if (chunk.usage?.completion_tokens) this.outputTokens = chunk.usage.completion_tokens;

    const choice = chunk.choices?.[0];
    if (choice) {
      const text = choice.delta?.content;
      if (typeof text === "string" && text) {
        if (!this.openBlock) {
          this.openBlock = { index: this.nextBlockIndex++, kind: "text" };
          out.push(
            OpenAiStreamTranslator.sse("content_block_start", {
              type: "content_block_start",
              index: this.openBlock.index,
              content_block: { type: "text", text: "" },
            })
          );
        }
        out.push(
          OpenAiStreamTranslator.sse("content_block_delta", {
            type: "content_block_delta",
            index: this.openBlock.index,
            delta: { type: "text_delta", text },
          })
        );
      }
      for (const call of choice.delta?.tool_calls ?? []) {
        const idx = call.index ?? 0;
        let acc = this.toolCalls.get(idx);
        if (!acc) {
          // name/args arrive as fragments; start empty and accumulate below
          acc = { id: call.id ?? "", name: "", args: "", blockIndex: null };
          this.toolCalls.set(idx, acc);
        }
        if (call.id) acc.id = call.id;
        if (call.function?.name) acc.name += call.function.name;
        if (call.function?.arguments) acc.args += call.function.arguments;
        // argument deltas only stream after the block was opened; open on the
        // first fragment that carries an id or a name
        if (acc.blockIndex === null && (acc.id || acc.name)) {
          this.closeTextBlock(out);
          acc.blockIndex = this.nextBlockIndex++;
          out.push(
            OpenAiStreamTranslator.sse("content_block_start", {
              type: "content_block_start",
              index: acc.blockIndex,
              content_block: { type: "tool_use", id: acc.id, name: acc.name, input: {} },
            })
          );
        }
        if (acc.blockIndex !== null && call.function?.arguments) {
          out.push(
            OpenAiStreamTranslator.sse("content_block_delta", {
              type: "content_block_delta",
              index: acc.blockIndex,
              delta: { type: "input_json_delta", partial_json: call.function.arguments },
            })
          );
        }
      }
      if (choice.finish_reason) this.stopReason = stopReasonFrom(choice.finish_reason);
    }
    return out.join("");
  }

  private closeTextBlock(out: string[]): void {
    if (!this.openBlock) return;
    out.push(
      OpenAiStreamTranslator.sse("content_block_stop", {
        type: "content_block_stop",
        index: this.openBlock.index,
      })
    );
    this.openBlock = null;
  }

  /** Close everything and emit the tail events. Single call at stream end. */
  finish(): string {
    if (this.finished) return "";
    this.finished = true;
    const out: string[] = [];
    this.closeTextBlock(out);
    for (const acc of [...this.toolCalls.values()].sort((a, b) => (a.blockIndex ?? 0) - (b.blockIndex ?? 0))) {
      if (acc.blockIndex === null) continue;
      out.push(
        OpenAiStreamTranslator.sse("content_block_stop", {
          type: "content_block_stop",
          index: acc.blockIndex,
        })
      );
    }
    out.push(
      OpenAiStreamTranslator.sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: this.stopReason, stop_sequence: null },
        usage: { output_tokens: this.outputTokens },
      })
    );
    out.push(OpenAiStreamTranslator.sse("message_stop", { type: "message_stop" }));
    return out.join("");
  }
}
