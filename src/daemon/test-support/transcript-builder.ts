/** Synthetic Claude Code JSONL transcripts for lifecycle tests. */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class TranscriptBuilder {
  private n = 0;
  private clock: number;

  constructor(public path: string, public sessionId: string, public cwd: string, startMs = Date.parse("2026-11-26T09:00:00Z")) {
    this.clock = startMs;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
  }

  private put(type: "user" | "assistant", content: unknown): this {
    this.clock += 20_000;
    const e = {
      type, uuid: `u${++this.n}`, sessionId: this.sessionId, cwd: this.cwd,
      timestamp: new Date(this.clock).toISOString(), message: { role: type, content },
    };
    appendFileSync(this.path, JSON.stringify(e) + "\n");
    return this;
  }

  /** Move the session to another working directory (later entries carry it). */
  moveTo(cwd: string): this { this.cwd = cwd; return this; }
  user(text: string): this { return this.put("user", text); }
  assistant(text: string): this { return this.put("assistant", [{ type: "text", text }]); }
  /** A tool call plus its (heavy) result; neither counts as conversation text. */
  tool(name = "Bash", heavyChars = 50_000, filePath?: string): this {
    const id = `toolu_${this.n}`;
    this.put("assistant", [{ type: "tool_use", id, name, input: filePath ? { file_path: filePath } : { command: "ls" } }]);
    return this.put("user", [{ type: "tool_result", tool_use_id: id, content: "x".repeat(heavyChars) }]);
  }
  /** A turn of about `chars` conversation characters (user question + assistant answer). */
  turn(topic: string, chars = 400): this {
    this.user(`Please work on ${topic}. `.padEnd(Math.floor(chars / 2), "details "));
    return this.assistant(`Working on ${topic}. `.padEnd(Math.floor(chars / 2), "progress "));
  }
  advance(ms: number): this { this.clock += ms; return this; }
  get now(): number { return this.clock; }
}
