/**
 * events.ts — worker .jsonl lines (Claude-shaped) -> UHP output items and
 * Responses-shaped stream events. One assembler serves both the stream and the
 * non-streaming/GET paths, so their `output` is identical by construction
 * (streaming.md §6). Sequence numbers are assigned by the caller's counter.
 */

export type UhpOutputItem = Record<string, unknown>;
export type UhpStatusName = "in_progress" | "completed" | "failed" | "incomplete" | "cancelled";
/** A stream event before its sequence number is assigned. */
export type EventBody = { type: string; [k: string]: unknown };

export interface ResponseFacts {
  id: string;
  model: string;
  sessionId: string;
  previousResponseId: string | null;
  store: boolean;
  createdAt: number;
  metadata: Record<string, unknown>;
}

export interface Terminal {
  status: Exclude<UhpStatusName, "in_progress">;
  error?: { type: string; code: string; message: string } | null;
  incompleteReason?: string;
}

type Block = { type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown };
type Line = {
  type?: string;
  subtype?: string;
  message?: { content?: Block[] | string };
  result?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
};

export class ResponseAssembler {
  readonly output: UhpOutputItem[] = [];
  usage: Record<string, number> | null = null;
  resultText = "";
  resultSubtype = "";
  private n = 0;

  constructor(private readonly facts: ResponseFacts) {}

  private id(prefix: string): string {
    this.n += 1;
    return `${prefix}_${this.n}`;
  }

  /** Events that open every stream. */
  opening(): EventBody[] {
    const r = this.response("in_progress");
    return [
      { type: "response.created", response: r },
      { type: "response.in_progress", response: r },
    ];
  }

  /** Feed one parsed line; returns the stream events it produces and records its items. */
  push(line: Line): EventBody[] {
    const out: EventBody[] = [];
    if (line.type === "result") {
      this.resultText = typeof line.result === "string" ? line.result : "";
      this.resultSubtype = line.subtype ?? "";
      if (line.usage) {
        const i = line.usage.input_tokens ?? 0;
        const o = line.usage.output_tokens ?? 0;
        this.usage = { input_tokens: i, output_tokens: o, total_tokens: i + o };
      }
      return out;
    }
    const content = line.message?.content;
    if (!Array.isArray(content)) return out;
    for (const b of content) {
      if (line.type === "assistant") {
        if (b.type === "text" && b.text) out.push(...this.message(b.text));
        else if (b.type === "thinking" && b.thinking) out.push(...this.reasoning(b.thinking));
        else if (b.type === "tool_use") out.push(...this.call(b));
      } else if (line.type === "user" && b.type === "tool_result") {
        out.push(...this.callOutput(b));
      }
    }
    return out;
  }

  private message(text: string): EventBody[] {
    const idx = this.output.length;
    const id = this.id("msg");
    const part = { type: "output_text", text: "", annotations: [] as unknown[] };
    const donePart = { ...part, text };
    const item = { id, type: "message", role: "assistant", status: "completed", content: [donePart] };
    this.output.push(item);
    return [
      { type: "response.output_item.added", output_index: idx, item: { ...item, status: "in_progress", content: [] } },
      { type: "response.content_part.added", item_id: id, output_index: idx, content_index: 0, part },
      { type: "response.output_text.delta", item_id: id, output_index: idx, content_index: 0, delta: text },
      { type: "response.output_text.done", item_id: id, output_index: idx, content_index: 0, text },
      { type: "response.content_part.done", item_id: id, output_index: idx, content_index: 0, part: donePart },
      { type: "response.output_item.done", output_index: idx, item },
    ];
  }

  private reasoning(text: string): EventBody[] {
    const idx = this.output.length;
    const id = this.id("rs");
    const summary = [{ type: "summary_text", text }];
    const item = { id, type: "reasoning", summary };
    this.output.push(item);
    return [
      { type: "response.output_item.added", output_index: idx, item: { id, type: "reasoning", summary: [] } },
      { type: "response.reasoning_summary_part.added", item_id: id, output_index: idx, summary_index: 0, part: { type: "summary_text", text: "" } },
      { type: "response.reasoning_summary_text.delta", item_id: id, output_index: idx, summary_index: 0, delta: text },
      { type: "response.reasoning_summary_part.done", item_id: id, output_index: idx, summary_index: 0, part: summary[0] },
      { type: "response.output_item.done", output_index: idx, item },
    ];
  }

  private call(b: Block): EventBody[] {
    const idx = this.output.length;
    const id = this.id("fc");
    const args = JSON.stringify(b.input ?? {});
    const item = { id, type: "function_call", status: "completed", call_id: b.id ?? id, name: b.name ?? "tool", arguments: args };
    this.output.push(item);
    return [
      { type: "response.output_item.added", output_index: idx, item: { ...item, status: "in_progress", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: id, output_index: idx, delta: args },
      { type: "response.function_call_arguments.done", item_id: id, output_index: idx, arguments: args },
      { type: "response.output_item.done", output_index: idx, item },
    ];
  }

  private callOutput(b: Block): EventBody[] {
    const idx = this.output.length;
    const id = this.id("fco");
    const c = b.content;
    const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (typeof x === "object" && x && "text" in x ? String((x as Block).text) : "")).join("") : "";
    const item = { id, type: "function_call_output", call_id: b.tool_use_id ?? id, output: text };
    this.output.push(item);
    return [
      { type: "response.output_item.added", output_index: idx, item },
      { type: "response.output_item.done", output_index: idx, item },
    ];
  }

  /** The Response object in its current state. */
  response(status: UhpStatusName, term?: Terminal): Record<string, unknown> {
    const f = this.facts;
    return {
      id: f.id,
      object: "response",
      created_at: f.createdAt,
      status,
      model: f.model,
      output: this.output,
      error: term?.error ?? null,
      usage: this.usage,
      incomplete_details: status === "incomplete" ? { reason: term?.incompleteReason ?? "max_step" } : null,
      previous_response_id: f.previousResponseId,
      store: f.store,
      metadata: { ...f.metadata, session_id: f.sessionId },
    };
  }

  /** The terminal event for a status; cancelled ends as response.failed (the status field is authoritative). */
  terminal(term: Terminal): EventBody {
    const type = term.status === "completed" ? "response.completed" : term.status === "incomplete" ? "response.incomplete" : "response.failed";
    return { type, response: this.response(term.status, term) };
  }
}

/** Parse a .jsonl chunk's complete lines; returns lines and the unconsumed rest. */
export function splitLines(buf: string): { lines: Line[]; rest: string } {
  const parts = buf.split("\n");
  const rest = parts.pop() ?? "";
  const lines: Line[] = [];
  for (const p of parts) {
    if (!p.trim()) continue;
    try {
      lines.push(JSON.parse(p) as Line);
    } catch {
      // a torn or foreign line is skipped
    }
  }
  return { lines, rest };
}

export function sseFrame(seq: number, ev: EventBody): string {
  return `data: ${JSON.stringify({ ...ev, sequence_number: seq })}\n\n`;
}
