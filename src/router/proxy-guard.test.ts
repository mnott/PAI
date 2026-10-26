import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouter } from "./router.js";
import { parseWorkersConfig } from "../workers/config.js";
import { readFirings } from "../hooks/ts/lib/antipattern-log.js";
import { stats } from "../antipatterns/govern.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { monitorReply, type ProxyGuardDeps } from "./proxy-guard.js";
import { LoopStore } from "./proxy-loop.js";
import { resetGuardCachesForTests } from "./proxy-guard.js";

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
  resetGuardCachesForTests();
});
afterEach(() => {
  resetGuardCachesForTests();
  if (prevHome === undefined) delete process.env.PAI_HOME;
  else process.env.PAI_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

async function run(body: string, mode: "off" | "monitor" | "enforce", deps?: ProxyGuardDeps, req: object = { model: "gyro-m", stream: true, messages: [{ role: "user", content: "hi" }] }, ct = "text/event-stream"): Promise<string> {
  const up = http.createServer((_q, s) => {
    s.writeHead(200, { "content-type": ct });
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
    q.end(JSON.stringify(req));
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

// ---------------------------------------------------------------------------
// enforce mode

const overrideFile = (id: string, proxy: string): void => {
  const dir = join(home, "antipatterns", "shell");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.yaml`), `id: ${id}\nmode: enforce\nproxy: ${proxy}\nseverity: confirm\nmatch: '^\\s*git\\s+reset\\s+--hard'\nreason: test override\n`);
};

/** The client-side parser: the same SSE shape a Messages client reads. */
function parseMessagesSse(raw: string): { blocks: Array<{ type: string; text?: string; name?: string }>; stop: string | null } {
  const blocks = new Map<number, { type: string; text?: string; name?: string }>();
  let stop: string | null = null;
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    let ev: any;
    try {
      ev = JSON.parse(line.slice(5));
    } catch {
      continue;
    }
    if (ev.type === "content_block_start") blocks.set(ev.index, { type: ev.content_block.type, name: ev.content_block.name, text: "" });
    else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") blocks.get(ev.index)!.text = (blocks.get(ev.index)?.text ?? "") + ev.delta.text;
    else if (ev.type === "message_delta") stop = ev.delta?.stop_reason ?? null;
  }
  return { blocks: [...blocks.values()], stop };
}

const enforceText = (d: { patternId?: string }) => `Blocked by PAI guard ${d.patternId ?? "guard"}:`;

describe("router proxy guard (enforce)", () => {
  it("streamed tool_use denied by a proxy-enforce pattern: replaced by a text block, stop_reason end_turn, firing recorded", async () => {
    overrideFile("git-reset-hard", "enforce");
    const body = toolStream("git reset --hard HEAD~1");
    const before = readFirings().length;
    const out = await run(body, "enforce");
    const parsed = parseMessagesSse(out);
    expect(parsed.blocks).toEqual([{ type: "text", name: undefined, text: expect.stringContaining("git-reset-hard") }]);
    expect(parsed.blocks[0].text).toContain("Blocked by PAI guard git-reset-hard");
    expect(parsed.stop).toBe("end_turn");
    expect(out).not.toContain("tool_use");
    const f = readFirings();
    expect(f.length).toBeGreaterThan(before);
    expect(f.some((x) => x.source === "proxy" && x.mode === "enforce" && x.action === "deny" && x.id === "git-reset-hard")).toBe(true);
    expect(stats({}).some((r) => (r.bySource.proxy ?? 0) > 0 && r.actions.deny > 0 && r.mode === "enforce")).toBe(true);
  });

  it("the same call with the shipped proxy monitor: forwarded unchanged, one monitor firing", async () => {
    const body = toolStream("git reset --hard HEAD~1");
    const before = readFirings().length;
    expect(await run(body, "enforce")).toBe(body);
    const f = readFirings().filter((x) => x.id === "git-reset-hard");
    expect(f.length).toBeGreaterThan(0);
    expect(f.every((x) => x.mode === "monitor")).toBe(true);
    expect(readFirings().length).toBeGreaterThan(before);
  });

  it("monitor mode: bytes identical and one firing (unchanged behaviour)", async () => {
    const body = toolStream("git reset --hard HEAD~1");
    const before = readFirings().length;
    expect(await run(body, "monitor")).toBe(body);
    expect(readFirings().length).toBeGreaterThan(before);
  });

  it("non-streaming tool_use denied: the block becomes a text block, stop_reason end_turn, usage untouched", async () => {
    overrideFile("git-reset-hard", "enforce");
    const body = JSON.stringify({ id: "m", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "git reset --hard HEAD~1" } }], stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 5 } });
    const out = await run(body, "enforce", undefined, { model: "gyro-m", messages: [{ role: "user", content: "hi" }] }, "application/json");
    const j = JSON.parse(out);
    expect(j.content).toEqual([{ type: "text", text: expect.stringContaining("Blocked by PAI guard git-reset-hard") }]);
    expect(j.stop_reason).toBe("end_turn");
    expect(j.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it("an allowed call in enforce mode: bytes identical, no firing", async () => {
    const body = toolStream("ls -la");
    const before = readFirings().length;
    expect(await run(body, "enforce")).toBe(body);
    expect(readFirings().length).toBe(before);
  });

  it("evaluation throws in enforce mode: the original bytes go out, error logged", async () => {
    const body = toolStream("git reset --hard HEAD~1");
    const logs: string[] = [];
    const out = await run(body, "enforce", {
      evaluate: () => {
        throw new Error("boom");
      },
      log: (l) => logs.push(l),
    });
    expect(out).toBe(body);
    expect(logs.some((l) => l.includes("boom"))).toBe(true);
  });

  it("a user override proxy: monitor forwards the bytes with a firing even in enforce mode", async () => {
    overrideFile("git-reset-hard", "monitor");
    const body = toolStream("git reset --hard HEAD~1");
    const before = readFirings().length;
    expect(await run(body, "enforce")).toBe(body);
    expect(readFirings().filter((f) => f.id === "git-reset-hard" && f.mode === "monitor").length).toBeGreaterThan(0);
    expect(readFirings().length).toBeGreaterThan(before);
  });

  it("a user override proxy: off records nothing in enforce mode", async () => {
    overrideFile("git-reset-hard", "off");
    const body = toolStream("git reset --hard HEAD~1");
    expect(await run(body, "enforce")).toBe(body);
    expect(readFirings().filter((f) => f.id === "git-reset-hard").length).toBe(0);
    expect(readFirings().filter((f) => f.category === "shell").length).toBe(0); // the loop guard may note a repeated command; the shell rule must not
  });

  it("counts rise across modes: monitor then enforce both record", async () => {
    const body = toolStream("git reset --hard HEAD~1");
    const c0 = readFirings().length;
    await run(body, "monitor");
    const c1 = readFirings().length;
    expect(c1).toBeGreaterThan(c0);
    overrideFile("git-reset-hard", "enforce");
    await run(body, "enforce");
    expect(readFirings().length).toBeGreaterThan(c1);
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

  // "missing" comes from the tool_result that answers the call, never from the proxy's disk: `home` exists on disk
  // and is answered as not found; a path that does not exist on disk is answered with contents.
  const missingRun = () => {
    const onDisk = (i: number) => {
      const file_path = join(home, `p-${i}.py`);
      writeFileSync(file_path, "x");
      return { file_path };
    };
    const gone = { text: "ENOENT: no such file or directory", is_error: true };
    // turns of Reads; the result of turn i reaches the guard with the request of turn i+1, so the streak of 10
    // results fires on the eleventh call
    const run = (answer: (i: number) => { text: string; is_error?: boolean }, exists = true, turns = 11) => {
      const { fired, step } = setup();
      const calls: { name: string; input: object }[] = [];
      const results: { text: string; is_error?: boolean }[] = [];
      for (let i = 0; i < turns; i++) {
        const input = exists ? onDisk(i) : { file_path: join(home, `never-created-${i}.py`) };
        step("Read", input, calls, results);
        calls.push({ name: "Read", input });
        results.push(answer(i));
      }
      return fired.filter((f) => f.id === "missing-path-streak");
    };
    return { run, gone };
  };

  it("missing-path-streak: 10 not-found results for paths that exist on disk fire source proxy on the eleventh turn", () => {
    const { run, gone } = missingRun();
    const streak = run(() => gone);
    expect(streak.length).toBe(1);
    expect(streak[0].source).toBe("proxy");
    expect(streak[0].turn).toBe(10);
  });

  it("missing-path-streak: a successful Read result in between resets the streak, no firing", () => {
    const { run, gone } = missingRun();
    expect(run((i) => (i === 5 ? { text: "contents" } : gone))).toEqual([]);
  });

  it("missing-path-streak: nonexistent paths answered with contents, or an error without a not-found signature, never fire", () => {
    const { run } = missingRun();
    expect(run(() => ({ text: "contents" }), false)).toEqual([]);
    expect(run(() => ({ text: "permission denied", is_error: true }), false)).toEqual([]);
    expect(run(() => ({ text: "ENOENT: no such file or directory" }), false)).toEqual([]); // not is_error
  });
});
