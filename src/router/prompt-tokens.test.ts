import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InputTokensSse, promptText, tokenizerDirCandidates } from "./prompt-tokens.js";

/**
 * Recorded 2026-10-18 from one tiny streaming request through the router to
 * the local30x8 server (vllm-mlx, qwen3-coder-30b-8bit): message_start usage
 * carries input_tokens 0, the final message_delta carries only output_tokens.
 * The server reported prompt_tokens=15 for this very request in its scheduler
 * log — the tokenizer count of the rendered prompt text below must match.
 */
const RECORDED_SSE = [
  'event: message_start',
  'data: {"type": "message_start", "message": {"id": "msg_112e8e53d7304ff983b6696e", "type": "message", "role": "assistant", "model": "qwen3-coder-30b-8bit", "content": [], "stop_reason": null, "stop_sequence": null, "usage": {"input_tokens": 0, "output_tokens": 0}}}',
  '',
  'event: content_block_start',
  'data: {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}',
  '',
  'event: content_block_delta',
  'data: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "ok"}}',
  '',
  'event: content_block_stop',
  'data: {"type": "content_block_stop", "index": 0}',
  '',
  'event: message_delta',
  'data: {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": null}, "usage": {"output_tokens": 2}}',
  '',
  'event: message_stop',
  'data: {"type": "message_stop"}',
  '',
].join("\n");

const PROBE_BODY = { model: "qwen3-coder-30b-8bit", max_tokens: 16, stream: true, messages: [{ role: "user", content: [{ type: "text", text: "Reply with the single word: ok" }] }] };

async function transform(sse: string, load: () => Promise<number | null>): Promise<string> {
  const t = new InputTokensSse(load);
  const out: string[] = [];
  t.on("data", (c: Buffer) => out.push(c.toString("utf8")));
  const done = new Promise<void>((res) => t.on("end", () => res()));
  t.end(sse, "utf8");
  await done;
  return out.join("");
}

describe("InputTokensSse (the router fill, recorded fixture)", () => {
  it("(c) fills message_start input_tokens from the counted prompt and leaves the rest byte-identical", async () => {
    const out = await transform(RECORDED_SSE, async () => 15);
    expect(out).toContain('"input_tokens":15');
    expect(out).toContain('"usage":{"input_tokens":15,"output_tokens":0}');
    // every other event unchanged
    expect(out).toContain('"text": "ok"');
    expect(out).toContain('"usage": {"output_tokens": 2}');
    const lines = (a: string) => a.split("\n").filter((l) => l && !l.startsWith("event:"));
    const untouched = lines(RECORDED_SSE).filter((l) => !l.includes("message_start"));
    expect(lines(out).filter((l) => !l.includes("message_start"))).toEqual(untouched);
  });

  it("never touches a server-reported non-zero count, and passes through when the count is unknown", async () => {
    const serverReported = RECORDED_SSE.replace('"input_tokens": 0', '"input_tokens": 15');
    expect(await transform(serverReported, async () => 999)).toBe(serverReported);
    expect(await transform(RECORDED_SSE, async () => null)).toBe(RECORDED_SSE);
  });

  it("handles a count resolving mid-stream (chunks split inside a line)", async () => {
    const t = new InputTokensSse(() => new Promise((r) => setTimeout(() => r(81583), 5)));
    const out: string[] = [];
    t.on("data", (c: Buffer) => out.push(c.toString("utf8")));
    const done = new Promise<void>((res) => t.on("end", () => res()));
    const parts = RECORDED_SSE.split('data: {"type": "message_start"');
    t.write(parts[0] + 'data: {"type": "message_start"'); // line torn across chunks
    t.write(parts[1]);
    t.end();
    await done;
    expect(out.join("")).toContain('"input_tokens":81583');
  });
});

describe("promptText (the Qwen3-Coder template rendering)", () => {
  it("renders the recorded probe exactly as the server templated it (scheduler log: prompt_tokens=15)", () => {
    expect(promptText(PROBE_BODY)).toBe("<|im_start|>user\nReply with the single word: ok<|im_end|>\n<|im_start|>assistant\n");
  });

  it("renders system, tools section and a tool result the way the template does", () => {
    const text = promptText({
      system: [{ type: "text", text: "You are a coding agent." }],
      tools: [{ name: "Bash", description: "  Run a shell command.  ", input_schema: { type: "object", properties: { command: { type: "string", description: "The line", enum: ["a"] } }, required: ["command"] } }],
      messages: [
        { role: "user", content: [{ type: "text", text: "list files" }] },
        { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
        { role: "user", content: [{ type: "tool_result", content: "a.txt" }] },
      ],
    });
    expect(text).toMatch(/^<\|im_start\|>system\nYou are a coding agent\.\n\nYou have access to the following functions:\n\n<tools>/);
    expect(text).toContain("<function>\n<name>Bash</name>\n<description>Run a shell command.</description>\n<parameters>");
    expect(text).toContain("<type>string</type>");
    expect(text).toContain("</tools>");
    expect(text).toContain("<|im_start|>user\nlist files<|im_end|>\n");
    expect(text).toContain("<tool_call>\n<function=Bash>\n<parameter=command>\nls\n</parameter>\n</function>\n</tool_call>");
    expect(text).toContain("<tool_response>\na.txt\n</tool_response>\n");
    expect(text.endsWith("<|im_start|>assistant\n")).toBe(true);
  });
});

describe("tokenizerDirCandidates", () => {
  it("matches every token of the served id and only directories with a tokenizer", () => {
    const root = mkdtempSync(join(tmpdir(), "pai-prompt-tokens-"));
    const dir = (name: string, withTokenizer: boolean) => {
      const p = join(root, name);
      mkdirSync(p, { recursive: true });
      if (withTokenizer) writeFileSync(join(p, "tokenizer.json"), "{}");
      return { name, path: p };
    };
    const dirs = [
      dir("mlx-community--Qwen3-Coder-30B-A3B-Instruct-8bit", true),
      dir("mlx-community--Qwen3-Coder-30B-A3B-Instruct-4bit", false),
      dir("sentence-transformers--all-MiniLM-L6-v2", true),
      dir("mlx-community--Llama-3.2-1B-Instruct-4bit", true),
    ];
    expect(tokenizerDirCandidates("qwen3-coder-30b-8bit", dirs).length).toBe(1);
    expect(tokenizerDirCandidates("qwen3-coder-30b-8bit", dirs)[0]).toContain("8bit");
    expect(tokenizerDirCandidates("llama-3.2-1b-4bit", dirs).length).toBe(1);
    expect(tokenizerDirCandidates("gpt-5", dirs)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});
