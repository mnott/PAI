import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseWorkersConfig } from "../workers/config.js";
import { createRouter } from "./router.js";
import { DEFAULT_SCHED, RequestScheduler, sharedScheduler, type Priority } from "./scheduler.js";
import { engineControlReader } from "../workers/engine-control.js";

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length) closers.pop()!();
});

function listen(s: http.Server): Promise<number> {
  closers.push(() => {
    s.closeAllConnections?.();
    s.close();
  });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r((s.address() as AddressInfo).port)));
}
const until = async (f: () => boolean, ms = 800): Promise<void> => {
  const t = Date.now();
  while (!f()) {
    if (Date.now() - t > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
};

async function rig(engine: (req: http.IncomingMessage, res: http.ServerResponse, n: number) => void) {
  const logs: string[] = [];
  let n = 0;
  const upstreamClosed: number[] = [];
  const up = http.createServer((req, res) => {
    const id = ++n;
    req.resume();
    res.on("close", () => !res.writableEnded && upstreamClosed.push(id));
    engine(req, res, id);
  });
  const upPort = await listen(up);
  const prov = parseWorkersConfig({ providers: { gyro: { baseUrl: `http://127.0.0.1:${upPort}`, models: { default: "gyro-m" } } } }).providers;
  const released: Array<{ reason: string; worker: string }> = [];
  const r = createRouter(() => prov, "http://127.0.0.1:1", (l: string) => logs.push(l), undefined, undefined, { instances: () => [], onSlotReleased: (i) => released.push(i) });
  const port = await listen(r);
  const body = JSON.stringify({ model: "gyro-m", stream: true, messages: [{ role: "user", content: "hi" }] });
  const post = (worker: string) => {
    const out = { status: 0, text: "", done: false };
    const q = http.request({ port, host: "127.0.0.1", path: "/p/gyro/v1/chat/completions", method: "POST", headers: { "content-type": "application/json", "x-pai-worker": worker, "x-pai-session": "s" } }, (x) => {
      out.status = x.statusCode ?? 0;
      x.on("data", (c) => (out.text += c));
      x.on("end", () => (out.done = true));
      x.on("error", () => {});
    });
    q.on("error", () => {});
    q.end(body);
    return { q, out };
  };
  const postMessages = () => {
    const out = { status: 0, text: "", done: false };
    const b = JSON.stringify({ model: "gyro-m", stream: true, max_tokens: 10, messages: [{ role: "user", content: "hi" }], tools: [{ name: "Bash", input_schema: { type: "object", properties: { command: { type: "string" } } } }] });
    const q = http.request({ port, host: "127.0.0.1", path: "/p/gyro/v1/messages", method: "POST", headers: { "content-type": "application/json", "x-pai-worker": "wM", "x-pai-session": "s" } }, (x) => {
      out.status = x.statusCode ?? 0;
      x.on("data", (c) => (out.text += c));
      x.on("end", () => (out.done = true));
      x.on("error", () => (out.done = true));
    });
    q.on("error", () => (out.done = true));
    q.end(b);
    return { q, out };
  };
  return { post, postMessages, logs, released, upstreamClosed, calls: () => n };
}

const inflight = () => Object.values(sharedScheduler().snapshot().engines).map((e) => e.inflight?.worker ?? null);
const queued = () => Object.values(sharedScheduler().snapshot().engines).reduce((a, e) => a + Object.values(e.queued).reduce((x, y) => x + y, 0), 0);

describe("engine slot release", () => {
  it("client aborts mid-stream: slot freed, upstream aborted, next request served", async () => {
    const t = await rig((_q, res, id) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (id === 1) res.write("data: {}\n\n"); // then hangs
      else res.end("data: [DONE]\n\n");
    });
    const a = t.post("wA");
    await until(() => a.out.status === 200 && t.calls() === 1);
    const b = t.post("wB");
    await until(() => queued() === 1);
    a.q.destroy();
    await until(() => b.out.done);
    expect(t.upstreamClosed).toContain(1);
    expect(t.released[0]).toMatchObject({ reason: "client-gone", worker: "wA" });
    await until(() => inflight().every((w) => w === null));
  });

  it("client aborts while queued: removed from the queue, never reaches the engine", async () => {
    const t = await rig((_q, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: {}\n\n");
    });
    const a = t.post("wA");
    await until(() => a.out.status === 200);
    const b = t.post("wB");
    await until(() => queued() === 1);
    b.q.destroy();
    await until(() => queued() === 0);
    expect(t.calls()).toBe(1);
    a.q.destroy();
    await until(() => inflight().every((w) => w === null));
  });

  it("normal completion: slot freed, no release event", async () => {
    const t = await rig((_q, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: [DONE]\n\n");
    });
    const a = t.post("wA");
    await until(() => a.out.done);
    await until(() => inflight().every((w) => w === null));
    expect(t.released).toEqual([]);
  });
});

describe("stale holder", () => {
  it("is released after staleMin without bytes; touch keeps it alive", async () => {
    let now = 1_000_000;
    const s = new RequestScheduler(() => ({ ...DEFAULT_SCHED, staleMin: 5 }), () => now);
    const stale: string[] = [];
    s.onStale = (_e, w) => stale.push(w);
    const t1 = await s.acquire("e", "s", "w1");
    const next = s.acquire("e", "s", "w2");
    now += 4 * 60_000;
    t1.touch();
    now += 4 * 60_000;
    expect(s.reapStale()).toBe(0);
    now += 2 * 60_000;
    expect(s.reapStale()).toBe(1);
    expect(stale).toEqual(["w1"]);
    const t2 = await next;
    expect(s.snapshot().engines.e!.inflight?.worker).toBe("w2");
    t1.release(); // idempotent, does not disturb w2
    expect(s.snapshot().engines.e!.inflight?.worker).toBe("w2");
    t2.release();
  });
});

describe("stale reaper counts prompt reading as progress", () => {
  const mk = (): { s: RequestScheduler; adv: (ms: number) => void } => {
    let now = 1_000_000;
    return { s: new RequestScheduler(() => ({ ...DEFAULT_SCHED, staleMin: 5 }), () => now), adv: (ms) => void (now += ms) };
  };
  it("a big prompt gets max(staleMin, tokens/50*1.5) before the first byte", async () => {
    const { s, adv } = mk();
    const t = await s.acquire("e", "s", "w");
    t.setPromptTokens(130_000); // 3900 s = 65 min
    adv(60 * 60_000);
    expect(s.reapStale()).toBe(0);
    adv(6 * 60_000);
    expect(s.reapStale()).toBe(1);
  });
  it("after the first byte it is plain staleMin again", async () => {
    const { s, adv } = mk();
    const t = await s.acquire("e", "s", "w");
    t.setPromptTokens(130_000);
    adv(30 * 60_000);
    t.touch();
    adv(4 * 60_000);
    expect(s.reapStale()).toBe(0);
    adv(2 * 60_000);
    expect(s.reapStale()).toBe(1);
  });
  it("a small prompt keeps staleMin", async () => {
    const { s, adv } = mk();
    const t = await s.acquire("e", "s", "w");
    t.setPromptTokens(2000);
    adv(6 * 60_000);
    expect(s.reapStale()).toBe(1);
  });
});

describe("interactive session priority", () => {
  // `pai session --local` announces x-pai-priority: high with no worker status file;
  // the control reader must let that hint through, and the queue must serve it first.
  it("an interactive hint beats a queued normal worker once the engine frees", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sched-int-"));
    closers.push(() => rmSync(dir, { recursive: true, force: true }));
    const s = new RequestScheduler(() => DEFAULT_SCHED);
    s.control = engineControlReader(() => dir);
    const held = await s.acquire("e", "sA", "wA"); // occupies the engine (a normal worker)
    const w1p = s.acquire("e", "sB", "w1"); // queued normal worker, enqueued first
    const sessp = s.acquire("e", "sC", "session-local", undefined, "high" as Priority); // interactive, enqueued second
    await new Promise((r) => setTimeout(r, 5)); // distinct queue timestamps: aging cannot reorder
    expect(s.snapshot().engines.e!.inflight?.worker).toBe("wA");
    held.release(); // the engine frees; both waiters are eligible
    const sess = await sessp; // the interactive request goes first despite enqueuing second
    expect(s.snapshot().engines.e!.inflight?.worker).toBe("session-local");
    sess.release();
    const t1 = await w1p;
    expect(s.snapshot().engines.e!.inflight?.worker).toBe("w1");
    t1.release();
  });
  it("the control reader passes a hint through for a bare client, normal without one", () => {
    const dir = mkdtempSync(join(tmpdir(), "sched-int2-"));
    closers.push(() => rmSync(dir, { recursive: true, force: true }));
    const r = engineControlReader(() => dir);
    expect(r("session-local", "high").priority).toBe("high");
    expect(r("session-local").priority).toBe("normal");
    expect(r("session-local", "high").paused).toBe(false);
  });
});

describe("interactive session entries", () => {
  it("an interactive request creates a session entry, tokens are counted, it expires after 30 min without requests", async () => {
    let t = 1_000_000;
    const s = new RequestScheduler(() => DEFAULT_SCHED, () => t);
    const tk = await s.acquire("e", "my-sess", "conn:1", undefined, "high" as Priority, {});
    expect(s.snapshot().sessions!["my-sess"]).toMatchObject({ engine: "e", inflight: true, requests: 1, tokens: 0 });
    t += 2000;
    tk.release({ prefill: 100, decode: 20 });
    expect(s.snapshot().sessions!["my-sess"]).toMatchObject({ inflight: false, tokens: 120, lastServiceMs: 2000 });
    const w = await s.acquire("e", "worker-sess", "w1"); // not interactive: no entry
    w.release();
    expect(Object.keys(s.snapshot().sessions!)).toEqual(["my-sess"]);
    const fo = await s.acquire("e", "cloud-sess", "conn:2", undefined, undefined, { failover: true });
    fo.release();
    expect(s.snapshot().sessions!["cloud-sess"]!.failover).toBe(true);
    t += 29 * 60_000;
    expect(s.snapshot().sessions!["my-sess"]).toBeDefined();
    t += 2 * 60_000;
    expect(s.snapshot().sessions).toEqual({});
  });
});

describe("router body for local engines does not grow", () => {
  it("strip/fold only shrink the client's body; tools and system stay once", async () => {
    const { foldSystemMessages, stripBillingHeader, stripThinking } = await import("./router.js");
    const body: Record<string, unknown> = {
      system: [{ type: "text", text: "x-anthropic-billing-header: cch=abc;" }, { type: "text", text: "SYSPROMPT" }],
      tools: [{ name: "tool_a", description: "d", input_schema: { type: "object" } }],
      messages: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        { role: "assistant", content: [{ type: "thinking", thinking: "t".repeat(4000) }, { type: "tool_use", id: "t1", name: "tool_a", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "r".repeat(500) }] },
        { role: "system", content: "env" },
      ],
    };
    const before = JSON.stringify(body).length;
    const after = JSON.stringify(foldSystemMessages(stripBillingHeader(stripThinking(body))));
    expect(after.length).toBeLessThan(before);
    expect(after.split("SYSPROMPT").length - 1).toBe(1);
    expect(after.split('"name":"tool_a"').length - 1).toBe(2); // tools[] + the one tool_use
    expect(after).not.toContain("thinking");
  });
});

describe("cloud -> local failover", () => {
  type Cloud = (req: http.IncomingMessage, res: http.ServerResponse) => void;
  async function fo(cloud: Cloud | null, extra: Record<string, unknown> = {}, localOverride?: Cloud) {
    const seen = { cloud: 0, local: 0, localBody: "" as string, localHeaders: {} as http.IncomingHttpHeaders };
    const local = http.createServer((req, res) => {
      seen.local++;
      seen.localHeaders = req.headers;
      if (localOverride) {
        req.resume();
        return void req.on("end", () => localOverride(req, res));
      }
      const bits: Buffer[] = [];
      req.on("data", (c) => bits.push(c));
      req.on("end", () => {
        seen.localBody = Buffer.concat(bits).toString("utf8");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "gyro-m", content: [{ type: "text", text: "from-local" }], usage: { input_tokens: 1, output_tokens: 1 } }));
      });
    });
    const lp = await listen(local);
    let cloudBase = "http://127.0.0.1:1"; // refused
    if (cloud) {
      const c = http.createServer((req, res) => {
        seen.cloud++;
        req.resume();
        req.on("end", () => cloud(req, res));
      });
      cloudBase = `http://127.0.0.1:${await listen(c)}`;
    }
    const prov = parseWorkersConfig({ providers: { gyro: { baseUrl: `http://127.0.0.1:${lp}`, models: { default: "gyro-m" } } } }).providers;
    const ledger: Array<{ session: string; reason: string; to: string }> = [];
    const notes: string[] = [];
    const r = createRouter(() => prov, cloudBase, () => {}, undefined, undefined, {
      instances: () => [],
      failover: { enabled: true, stickyMin: 30, localContextTokens: 5000, localProvider: async () => "gyro", onFailover: (i) => ledger.push(i), notify: (i) => notes.push(i.text), probe: async () => false, ...extra },
    });
    const port = await listen(r);
    const post = (content = "hi", session = "sess1") =>
      new Promise<{ status: number; text: string }>((resolve) => {
        const q = http.request({ port, host: "127.0.0.1", path: "/v1/messages", method: "POST", headers: { "content-type": "application/json", "x-pai-session": session, authorization: "Bearer cloud-key" } }, (x) => {
          let text = "";
          x.on("data", (c) => (text += c));
          x.on("end", () => resolve({ status: x.statusCode ?? 0, text }));
        });
        q.on("error", (e) => resolve({ status: 0, text: `client-error ${e.message}` }));
        q.end(JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 10, messages: [{ role: "user", content }, { role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "s" }, { type: "text", text: "a" }] }] }));
      });
    return { post, seen, ledger, notes };
  }
  const limit: Cloud = (_q, res) => {
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Claude usage limit reached. Your limit will reset at 5pm." } }));
  };

  it("usage-limit 429 is served by the local model, ledgered once, notice once, and the session stays local", async () => {
    const t = await fo(limit);
    const a = await t.post();
    expect(a.status).toBe(200);
    expect(a.text).toContain("from-local");
    expect(JSON.parse(t.seen.localBody).model).toBe("gyro-m");
    expect(t.seen.localBody).not.toContain("thinking");
    expect(t.seen.localHeaders.authorization).not.toBe("Bearer cloud-key");
    const b = await t.post("again");
    expect(b.text).toContain("from-local");
    expect(t.seen.cloud).toBe(1); // sticky: the second request never touched the cloud
    expect(t.ledger).toEqual([{ session: "sess1", reason: "usage-limit", to: "gyro" }]);
    expect(t.notes).toEqual(["cloud unavailable (usage-limit), this session now runs on the local model"]);
  });

  it("a network failure is served by the local model", async () => {
    const t = await fo(null);
    const a = await t.post();
    expect(a.status).toBe(200);
    expect(a.text).toContain("from-local");
    expect(t.ledger[0]?.reason).toBe("offline");
  });

  it("failover does not stick: after a network blip the next request goes back to the cloud", async () => {
    let n = 0;
    const cloud: Cloud = (q, res) => {
      if (++n === 1) return void q.socket.destroy(); // the blip: connection reset before any byte
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "c", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: "from-cloud" }], usage: { input_tokens: 1, output_tokens: 1 } }));
    };
    // stickyMin 0.0005 min = 30 ms backoff (an offline blip is retried after min(stickyMin, 30 s))
    const t = await fo(cloud, { stickyMin: 0.0005, probe: async () => true });
    const a = await t.post();
    expect(a.text).toContain("from-local");
    expect(t.ledger[0]?.reason).toBe("offline");
    await new Promise((r) => setTimeout(r, 80));
    const b = await t.post("again");
    expect(b.text).toContain("from-cloud");
    expect(t.seen.local).toBe(1);
  });

  it("a failover answer cut mid-answer ends with a retryable error, not a hang", async () => {
    const t = await fo(null, {}, (_q, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-length": "500" });
      res.write('{"id":"m","type":"mess');
      setTimeout(() => res.destroy(), 30);
    });
    const a = await t.post();
    expect(a.status).toBeGreaterThanOrEqual(500); // an error the client retries, not a hang
    expect(a.text).toContain("mid-answer");
  });

  it("an input larger than the local window gets a /compact error", async () => {
    const t = await fo(limit);
    const a = await t.post("x".repeat(40_000));
    expect(a.status).toBe(400);
    expect(a.text).toContain("/compact");
    expect(t.seen.local).toBe(0);
  });

  it("failover disabled: the cloud error passes through", async () => {
    const t = await fo(limit, { enabled: false });
    const a = await t.post();
    expect(a.status).toBe(429);
    expect(a.text).toContain("usage limit");
    expect(t.seen.local).toBe(0);
    expect(t.ledger).toEqual([]);
  });

  it("an ordinary short rate limit is not failed over", async () => {
    const t = await fo((_q, res) => {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "5" });
      res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Number of request tokens has exceeded your per-minute rate limit" } }));
    });
    const a = await t.post();
    expect(a.status).toBe(429);
    expect(t.seen.local).toBe(0);
    expect(t.ledger).toEqual([]);
  });
});

describe("stable prompt prefix for local requests", () => {
  const mk = (date: string, git: string) => ({
    system: [{ type: "text", text: "SYSPROMPT\ngitStatus: " + git + "\n# other\nkeep" }, { type: "text", text: "Today's date is " + date + "." }],
    tools: [{ name: "b" }, { name: "a" }],
    messages: [{ role: "user", content: "first" }, { role: "assistant", content: "ok" }, { role: "user", content: [{ type: "text", text: "go" }] }],
  });
  it("differing date/git status give identical system + tools; volatile text ends the last user message", async () => {
    const { stabilizePrefix } = await import("./router.js");
    const a = stabilizePrefix(mk("2026-11-20", "branch main\n\n(clean)")) as ReturnType<typeof mk>;
    const b = stabilizePrefix(mk("2026-11-21", "branch dev\n\nM x.ts")) as ReturnType<typeof mk>;
    expect(JSON.stringify([a.system, a.tools, a.messages.slice(0, 2)])).toBe(JSON.stringify([b.system, b.tools, b.messages.slice(0, 2)]));
    expect(JSON.stringify(a.system)).toContain("keep");
    expect(JSON.stringify(a.system)).not.toContain("2026-11-20");
    const lastA = JSON.stringify(a.messages.at(-1));
    expect(lastA).toContain("context:");
    expect(lastA).toContain("2026-11-20");
    expect(lastA).toContain("(clean)");
    expect(JSON.stringify(b.messages.at(-1))).toContain("M x.ts");
  });
  it("cloud requests are untouched", async () => {
    const { prepare } = await import("./router.js");
    const raw = Buffer.from(JSON.stringify({ model: "claude-sonnet-5-5", ...mk("2026-11-20", "x") }));
    const r = prepare("/v1/messages", {}, raw, {}, "https://api.anthropic.com");
    expect(r.ok && r.up.body.toString()).toContain("Today's date is 2026-11-20");
    expect(r.ok && r.up.body.toString()).not.toContain("context:");
  });

  it("a large held answer passes the fixer chain whole: no mid-answer cut, slot released once", async () => {
    const ev = (n: string, d: unknown) => `event: ${n}\ndata: ${JSON.stringify(d)}\n\n`;
    let sse = ev("message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "gyro-m", content: [], usage: { input_tokens: 1, output_tokens: 1 } } });
    sse += ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    for (let i = 0; i < 1500; i++) sse += ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x".repeat(50) } });
    sse += ev("content_block_stop", { type: "content_block_stop", index: 0 });
    sse += ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1500 } });
    sse += ev("message_stop", { type: "message_stop" });
    expect(sse.length).toBeGreaterThan(65536);
    const t = await rig((_q, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse);
    });
    const a = t.postMessages();
    await until(() => a.out.done, 3000);
    expect(a.out.text.length).toBeGreaterThanOrEqual(sse.length);
    expect(a.out.text).toContain("message_stop");
    await until(() => inflight().every((w) => w === null));
    expect(t.logs.filter((l) => l.includes("closed mid-answer"))).toEqual([]);
    expect(t.released).toEqual([]);
  });

  it("a real upstream that closes before the end still logs and cuts the client", async () => {
    const t = await rig((_q, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "content-length": "100000" });
      res.write("event: message_start\ndata: {}\n\n");
      setTimeout(() => res.destroy(), 30);
    });
    const a = t.postMessages();
    await until(() => a.out.done, 3000);
    expect(a.out.text).not.toContain("message_stop");
    expect(t.logs.filter((l) => l.includes("closed mid-answer")).length).toBe(1);
    await until(() => inflight().every((w) => w === null));
  });
});
