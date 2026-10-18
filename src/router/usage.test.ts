import { describe, it, expect } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createRouter } from "./router.js";
import type { WorkerProvider } from "../workers/config.js";
import {
  aggregate,
  BustDetector,
  aggregateBySession,
  fingerprint,
  GapTracker,
  formatStats,
  parseSince,
  UsageSniffer,
  usageFromJson,
  splitBySessionKind,
  verdict,
  type UsageRow,
} from "./usage.js";

// synthetic SSE, no real content
const SSE =
  [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":12,"cache_creation_input_tokens":300,"cache_read_input_tokens":4000,"output_tokens":1}}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}',
    'event: message_delta\ndata: {"type":"message_delta","delta":{},"usage":{"output_tokens":55}}',
    'event: message_stop\ndata: {"type":"message_stop"}',
  ].join("\n\n") + "\n\n";

describe("usage parsing", () => {
  it("parses SSE split at arbitrary chunk boundaries", () => {
    const buf = Buffer.from(SSE);
    for (const size of [1, 7, 64, buf.length]) {
      const s = new UsageSniffer("text/event-stream");
      for (let i = 0; i < buf.length; i += size) s.push(buf.subarray(i, i + size));
      expect(s.finish()).toEqual({
        input_tokens: 12,
        output_tokens: 55,
        cache_creation_input_tokens: 300,
        cache_read_input_tokens: 4000,
      });
    }
  });

  it("parses a non-stream JSON response", () => {
    const j = JSON.stringify({ content: [], usage: { input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 7 } });
    const s = new UsageSniffer("application/json");
    s.push(Buffer.from(j.slice(0, 20)));
    s.push(Buffer.from(j.slice(20)));
    const u = s.finish();
    expect(u).toMatchObject({ input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 7, cache_creation_input_tokens: 0 });
    expect(usageFromJson("not json").input_tokens).toBe(0);
  });

  it("derives the cache verdict", () => {
    const u = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    expect(verdict(u)).toBe("miss");
    expect(verdict({ ...u, cache_creation_input_tokens: 9 })).toBe("write");
    expect(verdict({ ...u, cache_creation_input_tokens: 9, cache_read_input_tokens: 9 })).toBe("hit");
  });
});

const row = (o: Partial<UsageRow>): UsageRow => ({
  ts: new Date().toISOString(),
  model: "m",
  provider: "p",
  status: 200,
  ms: 1,
  bytes: 10,
  input_tokens: 10,
  output_tokens: 5,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  cache: "miss",
  ...o,
});

describe("stats", () => {
  it("aggregates per provider/model with hit ratio and --since", () => {
    const now = Date.now();
    const rows = [
      row({ cache: "hit", cache_read_input_tokens: 90, input_tokens: 10 }),
      row({ cache: "write", cache_creation_input_tokens: 100, input_tokens: 0, bust: ["system"] }),
      row({ provider: "glm", model: "glm-5.3" }),
      row({ ts: new Date(now - 3 * 3_600_000).toISOString() }),
    ];
    const all = aggregate(rows, undefined, now);
    expect(all).toHaveLength(2);
    const p = all.find((g) => g.provider === "p")!;
    expect(p).toMatchObject({ requests: 3, hit: 1, write: 1, miss: 1, busts: 1, cache_read_input_tokens: 90 });
    expect(p.hitRatio).toBeCloseTo(90 / (90 + 100 + 20));
    const recent = aggregate(rows, parseSince("1h"), now).find((g) => g.provider === "p")!;
    expect(recent.requests).toBe(2);
    expect(formatStats(all)).toContain("glm-5.3");
    expect(() => parseSince("soon")).toThrow();
  });
});

describe("session-kind split", () => {
  it("classifies sessions by request count: one-shot vs continuous, hit ratio per group", () => {
    const now = Date.now();
    const at = (minAgo: number, sid: string, o: Partial<UsageRow> = {}): UsageRow =>
      row({ ts: new Date(now - minAgo * 60_000).toISOString(), session_id: sid, ...o });
    const rows = [
      // continuous session s1: two requests, cached second
      at(5, "s1", { cache_read_input_tokens: 700, input_tokens: 10 }),
      at(4, "s1", { cache_read_input_tokens: 700, input_tokens: 10 }),
      // one-shot session s2: a single cold request
      at(3, "s2", { cache_read_input_tokens: 0, input_tokens: 100, cache_creation_input_tokens: 0 }),
    ];
    const split = splitBySessionKind(rows, undefined, now);
    expect(split.continuous).toMatchObject({ sessions: 1, requests: 2 });
    expect(split.continuous.hitRatio).toBeCloseTo(1400 / 1420, 5); // all but the fresh input cached
    expect(split.oneShot).toMatchObject({ sessions: 1, requests: 1 });
    expect(split.oneShot.hitRatio).toBe(0);
    expect(splitBySessionKind([], undefined, now).continuous.sessions).toBe(0);
  });

  it("honours the since window and falls back to the session field", () => {
    const now = Date.now();
    const old = row({ ts: new Date(now - 2 * 3_600_000).toISOString(), session_id: "gone" });
    const recent1 = row({ ts: new Date(now - 60_000).toISOString(), session: "keep" });
    const recent2 = row({ ts: new Date(now - 30_000).toISOString(), session: "keep" });
    const split = splitBySessionKind([old, recent1, recent2], 3_600_000, now);
    expect(split.continuous.requests).toBe(2);
    expect(split.oneShot.sessions).toBe(0);
  });
});

describe("bust detection", () => {
  const body = (system: string, first: string) => ({
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: first }, { role: "assistant", content: "a" }, { role: "user", content: "tail" }],
  });

  it("is quiet while stable (cache_control and later messages ignored), flags the changed part", () => {
    const d = new BustDetector();
    expect(d.check("s", fingerprint(body("sys", "q")))).toEqual([]);
    const b2 = body("sys", "q");
    (b2.system[0] as { cache_control?: unknown }).cache_control = undefined;
    b2.messages[2]!.content = "other tail";
    expect(d.check("s", fingerprint(b2))).toEqual([]);
    expect(d.check("s", fingerprint(body("sys2", "q")))).toEqual(["system"]);
    expect(d.check("s", fingerprint(body("sys2", "q2")))).toEqual(["messages"]);
    expect(d.busts).toBe(2);
    expect(d.check(undefined, fingerprint(body("zzz", "q")))).toEqual([]);
    expect(d.check("other", fingerprint(body("zzz", "q")))).toEqual([]);
  });

  it("ignores the billing telemetry block, still sees other system changes", () => {
    const sys = (bill: string, rest: string) => ({
      system: [{ type: "text", text: "x-anthropic-billing-header: " + bill }, { type: "text", text: rest }],
      messages: [{ role: "user", content: "q" }],
    });
    const d = new BustDetector();
    expect(d.check("s", fingerprint(sys("cc_turn_index=1", "rules")))).toEqual([]);
    expect(d.check("s", fingerprint(sys("cc_turn_index=2; cc_prev_req=x", "rules")))).toEqual([]);
    expect(d.check("s", fingerprint(sys("cc_turn_index=3", "other rules")))).toEqual(["system"]);
    expect(d.busts).toBe(1);
  });
});

describe("router accounting end to end", () => {
  it("records streamed usage without altering the stream", async () => {
    const up = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(SSE.slice(0, 100));
        setTimeout(() => res.end(SSE.slice(100)), 5);
      });
    });
    await new Promise<void>((r) => up.listen(0, "127.0.0.1", r));
    const rows: UsageRow[] = [];
    const router = createRouter(
      () => ({}),
      `http://127.0.0.1:${(up.address() as AddressInfo).port}`,
      () => {},
      (r) => rows.push(r)
    );
    await new Promise<void>((r) => router.listen(0, "127.0.0.1", r));
    const port = (router.address() as AddressInfo).port;
    const payload = JSON.stringify({ model: "claude-haiku-4-5-20251001", system: "s", messages: [{ role: "user", content: "hi" }] });
    const text = await new Promise<string>((resolve, reject) => {
      const rq = http.request(
        { host: "127.0.0.1", port, path: "/v1/messages", method: "POST", headers: { "x-claude-code-session-id": "sess-1" } },
        (res) => {
          let t = "";
          res.on("data", (c) => (t += c));
          res.on("end", () => resolve(t));
        }
      );
      rq.on("error", reject);
      rq.end(payload);
    });
    expect(text).toBe(SSE);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      model: "claude-haiku-4-5-20251001",
      provider: "anthropic",
      status: 200,
      cache: "hit",
      input_tokens: 12,
      output_tokens: 55,
      cache_read_input_tokens: 4000,
      cache_creation_input_tokens: 300,
      session_id: "sess-1",
      requested_model: "claude-haiku-4-5-20251001",
      routed_model: "claude-haiku-4-5-20251001",
    });
    expect(rows[0]!.bytes).toBeGreaterThan(0);
    expect(JSON.stringify(rows[0])).not.toContain("hi\"");
    router.close();
    up.close();
  });
});

describe("gap + session grouping", () => {
  it("gap is seconds since previous request of the same session", () => {
    const g = new GapTracker();
    expect(g.gap("a", 1000)).toBeUndefined();
    expect(g.gap("b", 2000)).toBeUndefined();
    expect(g.gap("a", 31_000)).toBe(30);
    expect(g.gap(undefined, 5000)).toBeUndefined();
  });

  it("groups rows by session and names known ones", () => {
    const row = (session_id: string, ts: string, bust?: string[]): UsageRow => ({
      ts, model: "m", provider: "p", status: 200, ms: 1, bytes: 1, cache: "hit",
      input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 90,
      session_id, ...(bust ? { bust } : {}),
    });
    const out = aggregateBySession(
      [row("s1", "2026-01-01T00:00:00Z"), row("s1", "2026-01-01T00:01:00Z", ["system"]), row("s2", "2026-01-01T00:02:00Z")],
      undefined, Date.now(), (id) => (id === "s1" ? "worker one" : null)
    );
    expect(out.map((g) => [g.session, g.name, g.requests, g.busts])).toEqual([["s2", null, 1, 0], ["s1", "worker one", 2, 1]]);
    expect(out[1]!.hitRatio).toBeCloseTo(0.9);
  });
});

describe("local provider SSE", () => {
  // vllm-mlx style: message_start reports input_tokens 0, so the router estimates the input from the request body.
  const LOCAL_SSE =
    [
      'event: message_start\ndata: {"type": "message_start", "message": {"id": "m", "usage": {"input_tokens": 0, "output_tokens": 0}}}',
      'event: content_block_delta\ndata: {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Hello"}}',
      'event: content_block_delta\ndata: {"type": "content_block_delta", "delta": {"type": "text_delta", "text": " world"}}',
      'event: message_delta\ndata: {"type": "message_delta", "delta": {}, "usage": {"output_tokens": 2}}',
      'event: message_stop\ndata: {"type": "message_stop"}',
    ].join("\n\n") + "\n\n";

  it("records output tokens, an estimated input and timings without altering the stream", async () => {
    const up = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(LOCAL_SSE.slice(0, 100));
        setTimeout(() => res.end(LOCAL_SSE.slice(100)), 20);
      });
    });
    await new Promise<void>((r) => up.listen(0, "127.0.0.1", r));
    const rows: UsageRow[] = [];
    const provider = {
      enabled: true,
      protocol: "anthropic",
      baseUrl: `http://127.0.0.1:${(up.address() as AddressInfo).port}`,
      keyFile: null,
      models: { default: "qwen-test" },
      env: {},
    } as unknown as WorkerProvider;
    const router = createRouter(
      () => ({ vllm: provider }),
      "http://127.0.0.1:1",
      () => {},
      (r) => rows.push(r)
    );
    await new Promise<void>((r) => router.listen(0, "127.0.0.1", r));
    const port = (router.address() as AddressInfo).port;
    const payload = JSON.stringify({ model: "qwen-test", messages: [{ role: "user", content: "x".repeat(400) }] });
    const text = await new Promise<string>((resolve, reject) => {
      const rq = http.request(
        { host: "127.0.0.1", port, path: "/v1/messages", method: "POST", headers: { "x-pai-provider": "vllm" } },
        (res) => {
          let t = "";
          res.on("data", (c) => (t += c));
          res.on("end", () => resolve(t));
        }
      );
      rq.on("error", reject);
      rq.end(payload);
    });
    expect(text).toBe(LOCAL_SSE);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "vllm", status: 200, output_tokens: 2, input_estimated: true });
    expect(rows[0]!.input_tokens).toBeGreaterThan(0);
    router.close();
    up.close();
  });
});
