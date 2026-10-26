import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWorkersConfig } from "../workers/config.js";
import { createRouter } from "./router.js";
import { claudeCodeToolsArray } from "./tool-args-schemas.js";
import { RulesStore } from "./tool-call-rules.js";

const listen = (s: http.Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)));
const sse = (events: Array<[string, object]>) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
const delta = (index: number, partial_json: string): [string, object] => ["content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json } }];
const start = (index: number, name: string): [string, object] => ["content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: "t", name, input: {} } }];
const stop = (index: number): [string, object] => ["content_block_stop", { type: "content_block_stop", index }];

async function run(opts: { answers: Array<{ ct: string; body: string }>; toolParsing?: boolean; stream?: boolean }) {
  const seen: string[] = [];
  const up = http.createServer((req, res) => {
    const bits: Buffer[] = [];
    req.on("data", (c) => bits.push(c));
    req.on("end", () => {
      seen.push(Buffer.concat(bits).toString());
      const a = opts.answers[Math.min(seen.length, opts.answers.length) - 1];
      res.writeHead(200, { "content-type": a.ct });
      res.end(a.body);
    });
  });
  const upPort = await listen(up);
  const prov = parseWorkersConfig({ providers: { gyro: { baseUrl: `http://127.0.0.1:${upPort}`, models: { default: "gyro-m" }, ...(opts.toolParsing ? { toolParsing: "router" } : {}) } } }).providers;
  const fixes: Array<{ tool: string; rules: string[]; provider: string; model: string }> = [];
  const logs: string[] = [];
  const home = mkdtempSync(join(tmpdir(), "tcr-router-"));
  const store = new RulesStore({ config: () => undefined, homeDir: () => home, log: (l) => logs.push(l) });
  const r = createRouter(() => prov, "http://127.0.0.1:1", (l) => logs.push(l), undefined, undefined, {
    instances: () => [],
    toolCallRules: store,
    onToolArgsFix: (i) => fixes.push(i),
  });
  const port = await listen(r);
  const out = await new Promise<string>((resolve) => {
    const q = http.request({ port, host: "127.0.0.1", path: "/v1/messages", method: "POST", headers: { "x-pai-provider": "gyro" } }, (x) => {
      const bits: Buffer[] = [];
      x.on("data", (c) => bits.push(c));
      x.on("end", () => resolve(Buffer.concat(bits).toString()));
    });
    q.end(JSON.stringify({ model: "gyro-m", stream: !!opts.stream, tools: claudeCodeToolsArray(), messages: [{ role: "user", content: "hi" }] }));
  });
  r.close();
  up.close();
  return { out, seen, fixes, logs };
}

const inputsOf = (out: string): unknown[] => {
  const byIdx = new Map<number, string>();
  for (const m of out.split("\n\n")) {
    const d = m.split("\n").find((l) => l.startsWith("data:"));
    if (!d) continue;
    const ev = JSON.parse(d.slice(5));
    if (ev.delta?.type === "input_json_delta") byIdx.set(ev.index, (byIdx.get(ev.index) ?? "") + ev.delta.partial_json);
  }
  return [...byIdx.values()].map((j) => JSON.parse(j));
};

describe("router: tool arguments repaired by the rules file", () => {
  it("streaming tool_use: broken input comes out repaired, the repair is reported with rule ids, provider and model", async () => {
    const full = JSON.stringify({ "-n": "true\n</parameter\n<parameter=-C>\n15", pattern: "x" });
    const body = sse([["message_start", { type: "message_start", message: { id: "m" } }], start(0, "Grep"), delta(0, full.slice(0, 20)), delta(0, full.slice(20)), stop(0), ["message_stop", { type: "message_stop" }]]);
    const { out, fixes } = await run({ answers: [{ ct: "text/event-stream", body }], stream: true });
    expect(inputsOf(out)).toEqual([{ "-n": true, "-C": 15, pattern: "x" }]);
    expect(fixes).toHaveLength(1);
    expect(fixes[0]).toMatchObject({ tool: "Grep", provider: "gyro", model: "gyro-m" });
    expect(fixes[0].rules).toEqual(expect.arrayContaining(["open-parameter-eq", "bool-true"]));
  });

  it("non-streaming JSON reply: tool_use input repaired", async () => {
    const reply = JSON.stringify({ type: "message", role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "ls", timeout: "120000\n</parameter>\n</" } }], stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } });
    const { out, fixes } = await run({ answers: [{ ct: "application/json", body: reply }] });
    expect(JSON.parse(out).content[0].input).toEqual({ command: "ls", timeout: 120000 });
    expect(fixes[0].rules).toContain("close-parameter");
  });

  it("a clean call is untouched and nothing is reported", async () => {
    const reply = JSON.stringify({ type: "message", role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "ls" } }], stop_reason: "tool_use" });
    const { out, fixes } = await run({ answers: [{ ct: "application/json", body: reply }] });
    expect(out).toBe(reply);
    expect(fixes).toEqual([]);
  });
});

describe("router: toolParsing router — tool-call markup left as text", () => {
  const MARKUP = "Let me look.\n\n<tool_call>\n<function=Bash>\n<parameter=command>\nls -la\n</parameter>\n<parameter=timeout>\n5000\n</parameter>\n</function>\n</tool_call><|im_end|>";
  const textMsg = (text: string) => JSON.stringify({ type: "message", role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 2 } });

  it("JSON answer: the markup becomes a tool_use, one request only (no retry)", async () => {
    const { out, seen, fixes } = await run({ answers: [{ ct: "application/json", body: textMsg(MARKUP) }], toolParsing: true });
    const j = JSON.parse(out);
    expect(j.stop_reason).toBe("tool_use");
    expect(j.content[0]).toEqual({ type: "text", text: "Let me look." });
    expect(j.content[1]).toMatchObject({ type: "tool_use", name: "Bash", input: { command: "ls -la", timeout: 5000 } });
    expect(seen).toHaveLength(1);
    expect(fixes[0].rules[0]).toBe("parsed-from-text");
  });

  it("SSE answer: text blocks are replaced by text + tool_use blocks with a tool_use stop reason and the original usage", async () => {
    const body = sse([
      ["message_start", { type: "message_start", message: { id: "m", usage: { input_tokens: 9 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: MARKUP.slice(0, 30) } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: MARKUP.slice(30) } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } }],
      ["message_stop", { type: "message_stop" }],
    ]);
    const { out, seen } = await run({ answers: [{ ct: "text/event-stream", body }], toolParsing: true, stream: true });
    expect(inputsOf(out)).toEqual([{ command: "ls -la", timeout: 5000 }]);
    expect(out).toContain('"stop_reason":"tool_use"');
    expect(out).toContain('"output_tokens":7');
    expect(out).not.toContain("<tool_call>");
    expect(out.indexOf("message_start")).toBeLessThan(out.indexOf("content_block_start"));
    expect(seen).toHaveLength(1);
  });

  it("markup that cannot be parsed whole falls back to the retry; without the flag the retry runs as before", async () => {
    const BAD = "<tool_call>\n<function=Bash>\n<parameter=description>\nno command\n</parameter>\n</function>\n</tool_call>";
    const GOOD = JSON.stringify({ type: "message", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }], stop_reason: "tool_use" });
    const a = await run({ answers: [{ ct: "application/json", body: textMsg(BAD) }, { ct: "application/json", body: GOOD }], toolParsing: true });
    expect(a.seen).toHaveLength(2);
    expect(JSON.parse(a.out).content[0].type).toBe("tool_use");
    const b = await run({ answers: [{ ct: "application/json", body: textMsg(MARKUP) }, { ct: "application/json", body: GOOD }] });
    expect(b.seen).toHaveLength(2);
    expect(b.fixes).toEqual([]);
  });
});
