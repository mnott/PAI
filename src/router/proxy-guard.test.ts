import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouter } from "./router.js";
import { parseWorkersConfig } from "../workers/config.js";
import { readFirings } from "../hooks/ts/lib/antipattern-log.js";
import { stats } from "../antipatterns/govern.js";
import { monitorReply, type ProxyGuardDeps } from "./proxy-guard.js";
import { LoopStore } from "./proxy-loop.js";

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
    expect(f.every((x) => x.model === "gyro-m" && x.provider === "gyro")).toBe(true);
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

describe("proxy guard per-conversation loop state", () => {
  const reply = (id: string, name: string, input: object) => JSON.stringify({ content: [{ type: "tool_use", id, name, input }] });
  // a request replaying the conversation so far; results[i] answers the tool call of turn i
  const request = (calls: { name: string; input: object }[], results: { text: string; is_error?: boolean }[]) => {
    const messages: object[] = [{ role: "user", content: "start" }];
    results.forEach((r, i) => {
      messages.push({ role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: calls[i].name, input: calls[i].input }] });
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: r.text, is_error: r.is_error }] });
    });
    return { system: "sys", messages };
  };
  const setup = () => {
    const fired: { id: string; source?: string; turn: number }[] = [];
    let turn = 0;
    const deps: ProxyGuardDeps = { rules: () => [], loops: new LoopStore(), record: (f: any) => fired.push({ id: f.id, source: f.source, turn }) };
    const step = (name: string, input: object, calls: { name: string; input: object }[], results: { text: string; is_error?: boolean }[]) => {
      turn = calls.length;
      monitorReply(reply(`t${calls.length}`, name, input), "application/json", "m", deps, "p", request(calls, results));
    };
    return { fired, step };
  };

  it("repeated-failure: same failing Bash command with the same error text fires source proxy on the right turn", () => {
    const { fired, step } = setup();
    const input = { command: "npx vitest run a.test.ts" };
    const err = { text: "FAIL a.test.ts: expected 1 to be 2", is_error: true };
    const calls: { name: string; input: object }[] = [];
    const results: { text: string; is_error?: boolean }[] = [];
    for (let t = 0; t < 4; t++) {
      step("Bash", input, calls, results);
      calls.push({ name: "Bash", input });
      results.push(err);
    }
    expect(fired.length).toBeGreaterThan(0);
    expect(fired.every((f) => f.source === "proxy")).toBe(true);
    const first = fired.find((f) => f.id === "repeated-failure");
    expect(first).toBeDefined();
    expect(first!.turn).toBe(2); // the third identical run is the deny_at=3 one; turns 0 and 1 are clean
  });

  const missingRun = () => {
    const missing = (i: number) => ({ file_path: join(home, `nope-${i}.py`) });
    const gone = { text: "File does not exist.", is_error: true };
    const run = (okAt: number | null) => {
      const { fired, step } = setup();
      const calls: { name: string; input: object }[] = [];
      const results: { text: string; is_error?: boolean }[] = [];
      for (let i = 0; i < 10; i++) {
        const ok = i === okAt;
        const input = ok ? { file_path: home } : missing(i);
        step("Read", input, calls, results);
        calls.push({ name: "Read", input });
        results.push(ok ? { text: "contents" } : gone);
      }
      return fired.filter((f) => f.id === "missing-path-streak");
    };
    return run;
  };

  it("missing-path-streak: 10 Reads of nonexistent paths fire source proxy on the tenth turn", () => {
    const streak = missingRun()(null);
    expect(streak.length).toBe(1);
    expect(streak[0].source).toBe("proxy");
    expect(streak[0].turn).toBe(9);
  });

  it("missing-path-streak: a successful Read in between resets the streak, no firing", () => {
    expect(missingRun()(5)).toEqual([]);
  });
});
