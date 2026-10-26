/**
 * Worker `.jsonl` (Claude stream-json shape) -> UHP output items and events.
 * One assembler feeds both paths: the stream emits the events as they come,
 * the non-streaming read takes `items` once the run ended, so the two cannot
 * disagree on `output` (streaming.md section 6).
 */

export type UhpEventBody = { type: string } & Record<string, unknown>;
export type OutputItem = { type: string; id: string } & Record<string, unknown>;

export interface AssemblerUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

interface Block {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content.map((c) => (c && typeof c === "object" && typeof (c as Block).text === "string" ? (c as Block).text : "")).join("");
}

export class Assembler {
  readonly items: OutputItem[] = [];
  /** Session id of the engine (system/init), the model that ran, the final `result` line. */
  model: string | null = null;
  result: { text: string; isError: boolean; subtype: string; usage: AssemblerUsage | null } | null = null;
  private started = false;
  private n = 0;

  /** True once the run announced itself (system/init). */
  get initialised(): boolean {
    return this.started;
  }

  private add(item: OutputItem, events: UhpEventBody[], build: (index: number) => UhpEventBody[]): void {
    const index = this.items.length;
    this.items.push(item);
    events.push(...build(index));
  }

  /** Events for one `.jsonl` line (already parsed); [] for lines that map to nothing. */
  push(line: unknown): UhpEventBody[] {
    if (!line || typeof line !== "object") return [];
    const e = line as Record<string, any>;
    const out: UhpEventBody[] = [];
    if (e.type === "system" && e.subtype === "init") {
      this.started = true;
      if (typeof e.model === "string") this.model = e.model;
      return out;
    }
    if (e.type === "result") {
      const u = e.usage ?? {};
      const input = Number(u.input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0);
      const output = Number(u.output_tokens ?? 0);
      this.result = {
        text: typeof e.result === "string" ? e.result : "",
        isError: e.is_error === true,
        subtype: typeof e.subtype === "string" ? e.subtype : "",
        usage: e.usage
          ? {
              input_tokens: input,
              output_tokens: output,
              total_tokens: input + output,
              cache_read_tokens: Number(u.cache_read_input_tokens ?? 0),
              cache_write_tokens: Number(u.cache_creation_input_tokens ?? 0),
            }
          : null,
      };
      return out;
    }
    const content = e.message?.content;
    if (!Array.isArray(content) || (e.type !== "assistant" && e.type !== "user")) return out;
    if (e.type === "assistant" && typeof e.message?.model === "string" && !this.model) this.model = e.message.model;
    for (const b of content as Block[]) {
      if (e.type === "assistant" && b.type === "text" && b.text) this.text(b.text, out);
      else if (e.type === "assistant" && b.type === "thinking" && b.thinking) this.reasoning(b.thinking, out);
      else if (e.type === "assistant" && b.type === "tool_use" && b.id) this.toolUse(b, out);
      else if (e.type === "user" && b.type === "tool_result" && b.tool_use_id) this.toolResult(b, out);
    }
    return out;
  }

  private text(text: string, events: UhpEventBody[]): void {
    const id = `msg_${++this.n}`;
    const part = { type: "output_text", text, annotations: [] };
    const done = { id, type: "message", role: "assistant", status: "completed", content: [part] };
    this.add(done, events, (oi) => [
      { type: "response.output_item.added", output_index: oi, item: { id, type: "message", role: "assistant", status: "in_progress", content: [] } },
      { type: "response.content_part.added", item_id: id, output_index: oi, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", item_id: id, output_index: oi, content_index: 0, delta: text },
      { type: "response.output_text.done", item_id: id, output_index: oi, content_index: 0, text },
      { type: "response.content_part.done", item_id: id, output_index: oi, content_index: 0, part },
      { type: "response.output_item.done", output_index: oi, item: done },
    ]);
  }

  private reasoning(text: string, events: UhpEventBody[]): void {
    const id = `rs_${++this.n}`;
    const part = { type: "summary_text", text };
    const done = { id, type: "reasoning", status: "completed", summary: [part] };
    this.add(done, events, (oi) => [
      { type: "response.output_item.added", output_index: oi, item: { id, type: "reasoning", status: "in_progress", summary: [] } },
      { type: "response.reasoning_summary_part.added", item_id: id, output_index: oi, summary_index: 0, part: { type: "summary_text", text: "" } },
      { type: "response.reasoning_summary_text.delta", item_id: id, output_index: oi, summary_index: 0, delta: text },
      { type: "response.reasoning_summary_part.done", item_id: id, output_index: oi, summary_index: 0, part },
      { type: "response.output_item.done", output_index: oi, item: done },
    ]);
  }

  private toolUse(b: Block, events: UhpEventBody[]): void {
    const id = `fc_${b.id}`;
    const args = JSON.stringify(b.input ?? {});
    const done = { id, type: "function_call", status: "completed", call_id: b.id!, name: b.name ?? "tool", arguments: args };
    this.add(done, events, (oi) => [
      { type: "response.output_item.added", output_index: oi, item: { ...done, status: "in_progress", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: id, output_index: oi, delta: args },
      { type: "response.function_call_arguments.done", item_id: id, output_index: oi, arguments: args },
      { type: "response.output_item.done", output_index: oi, item: done },
    ]);
  }

  private toolResult(b: Block, events: UhpEventBody[]): void {
    const id = `fco_${b.tool_use_id}`;
    const done = { id, type: "function_call_output", status: "completed", call_id: b.tool_use_id!, output: blockText(b.content) };
    this.add(done, events, (oi) => [
      { type: "response.output_item.added", output_index: oi, item: { ...done, status: "in_progress", output: "" } },
      { type: "response.output_item.done", output_index: oi, item: done },
    ]);
  }

  /** The final assistant text, for status derivation (the worker's AG2 report). */
  finalText(): string {
    if (this.result?.text) return this.result.text;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (it.type === "message") return blockText((it.content as Block[])[0]?.text ?? "");
    }
    return "";
  }
}

/** Parse the complete lines of a growing `.jsonl`; `rest` is the unfinished tail to carry over. */
export function splitLines(buf: string): { lines: unknown[]; rest: string } {
  const parts = buf.split("\n");
  const rest = parts.pop() ?? "";
  const lines: unknown[] = [];
  for (const p of parts) {
    if (!p.trim()) continue;
    try {
      lines.push(JSON.parse(p));
    } catch {
      // a torn or foreign line is skipped, like the other .jsonl readers
    }
  }
  return { lines, rest };
}
