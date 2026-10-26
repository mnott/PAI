import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouter } from "./router.js";
import { parseWorkersConfig } from "../workers/config.js";
import { readFirings } from "../hooks/ts/lib/antipattern-log.js";
import { stats } from "../antipatterns/govern.js";
import type { ProxyGuardDeps } from "./proxy-guard.js";

const ev = (type: string, body: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;
const toolStream = (command: string) =>
  ev("message_start", { message: { id: "m", role: "assistant", content: [] } }) +
  ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: "t", name: "Bash", input: {} } }) +
  [JSON.stringify({ command }).slice(0, 12), JSON.stringify({ command }).slice(12)].map((p) => ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: p } })).join("") +
  ev("content_block_stop", { index: 0 }) +
  ev("message_delta", { delta: { stop_reason: "tool_use" } }) +
  ev("message_stop", {});
const textStream = (text: string) =>
  ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
  ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } }) +
  ev("content_block_stop", { index: 0 }) +
  ev("message_delta", { delta: { stop_reason: "end_turn" } });

const listen = (s: http.Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)));

let home: string;
let prevHome: string | undefined;
beforeEach(() => {
  prevHome = process.env.PAI_HOME;
  home = mkdtempSync(join(tmpdir(), "pai-proxy-guard-"));
  process.env.PAI_HOME = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.PAI_HOME;
  else process.env.PAI_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

async function run(body: string, mode: "off" | "monitor", deps?: ProxyGuardDeps): Promise<string> {
  const up = http.createServer((_q, s) => {
    s.writeHead(200, { "content-type": "text/event-stream" });
    s.end(body);
  });
  const upPort = await listen(up);
  const prov = parseWorkersConfig({ providers: { gyro: { baseUrl: `http://127.0.0.1:${upPort}`, models: { default: "gyro-m" } } } }).providers;
  const r = createRouter(() => prov, "http://127.0.0.1:1", () => {}, undefined, undefined, { instances: () => [], localToolCallRetry: false, guard: { mode, deps } });
  const port = await listen(r);
  const out = await new Promise<string>((resolve) => {
    const q = http.request({ port, host: "127.0.0.1", path: "/v1/messages", method: "POST", headers: { "x-pai-provider": "gyro" } }, (x) => {
      const bits: Buffer[] = [];
      x.on("data", (c) => bits.push(c));
      x.on("end", () => resolve(Buffer.concat(bits).toString()));
    });
    q.end(JSON.stringify({ model: "gyro-m", stream: true, messages: [{ role: "user", content: "hi" }] }));
  });
  await new Promise((r2) => setTimeout(r2, 50)); // evaluation runs after the response ended
  r.close();
  up.close();
  return out;
}

describe("router proxy guard (monitor)", () => {
  it("git reset --hard in a streamed tool_use: one proxy firing, bytes identical", async () => {
    const body = toolStream("git reset --hard HEAD~1");
    const before = readFirings().length;
    expect(await run(body, "monitor")).toBe(body);
    const f = readFirings();
    expect(before).toBe(0);
    expect(f.length).toBeGreaterThan(before);
    expect(f.every((x) => x.source === "proxy")).toBe(true);
    expect(stats({}).some((r) => r.bySource.proxy === f.length)).toBe(true);
    expect(stats({ source: "hook" }).every((r) => !r.bySource.proxy)).toBe(true);
  });

  it("final text that is an unparsed tool call: firing", async () => {
    const body = textStream('<tool_call>\n<function=Bash>\n<parameter=command>ls</parameter>\n</function>\n</tool_call>');
    expect(await run(body, "monitor")).toBe(body);
    expect(readFirings().map((x) => x.id)).toContain("unparsed-tool-call");
  });

  it("mode off: nothing recorded", async () => {
    const body = toolStream("git reset --hard HEAD~1");
    expect(await run(body, "off")).toBe(body);
    expect(readFirings()).toEqual([]);
  });

  it("evaluation exception: response still identical, error logged", async () => {
    const body = toolStream("git reset --hard HEAD~1");
    const logs: string[] = [];
    const out = await run(body, "monitor", {
      evaluate: () => {
        throw new Error("boom");
      },
      log: (l) => logs.push(l),
    });
    expect(out).toBe(body);
    expect(logs.some((l) => l.includes("boom"))).toBe(true);
    expect(readFirings()).toEqual([]);
  });
});
