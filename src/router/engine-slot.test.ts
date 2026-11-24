import http from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseWorkersConfig } from "../workers/config.js";
import { createRouter } from "./router.js";
import { DEFAULT_SCHED, RequestScheduler, sharedScheduler, type Priority } from "./scheduler.js";
import { engineControlReader } from "../workers/engine-control.js";
import { defaultLoopCaptureRing, LoopCaptureRing, loopCapturePath } from "../workers/proxy/loop-capture.js";
import { loopStopMarkerPath, requestLoopStop } from "../workers/loop-stop.js";

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

  it("a network blip the cloud probe disagrees with is retried on the cloud, not failed over", async () => {
    let n = 0;
    const cloud: Cloud = (q, res) => {
      if (++n === 1) return void q.socket.destroy(); // the blip: connection reset before any byte
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "c", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: "from-cloud" }], usage: { input_tokens: 1, output_tokens: 1 } }));
    };
    const t = await fo(cloud, { probe: async () => true, backoffMs: () => 5 });
    const a = await t.post();
    expect(a.text).toContain("from-cloud");
    expect(t.seen.local).toBe(0);
    expect(t.ledger).toEqual([]);
    expect(t.notes).toEqual([]);
  });

  it("a timeout during an event-loop stall of the router does not mark the cloud offline", async () => {
    // refused cloud + failing probe would be offline; the stall log says the timer fired late because of us
    const t = await fo(null, { stalls: { stalledSince: () => true }, retryBudgetMs: 150, backoffMs: () => 10 });
    const a = await t.post();
    expect(a.status).toBe(529);
    expect(t.seen.local).toBe(0);
    expect(t.ledger).toEqual([]);
    expect(t.notes).toEqual([]);
  });

  it("failover ends with the first cloud answer after the sticky window", async () => {
    const t = await fo(limit, { stickyMin: 0.0005 });
    expect((await t.post()).text).toContain("from-local");
    await new Promise((r) => setTimeout(r, 80));
    await t.post("again");
    expect(t.seen.cloud).toBe(2); // the real request went to the cloud again
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

  it("an input larger than the local window is never failed over: a retryable 529, never a 400 /compact", async () => {
    const t = await fo(limit, { retryBudgetMs: 150, backoffMs: () => 10 });
    const a = await t.post("x".repeat(40_000));
    expect(a.status).toBe(529);
    expect(a.text).toContain("overloaded_error");
    expect(a.text).not.toContain("/compact");
    expect(t.seen.local).toBe(0);
    expect(t.notes).toEqual([]);
  });

  it("an input larger than the local window goes back to the cloud once it answers", async () => {
    let n = 0;
    const cloud: Cloud = (_q, res) => {
      if (++n === 1) return limit(_q, res);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "c", type: "message", role: "assistant", model: "m", content: [{ type: "text", text: "from-cloud" }], usage: { input_tokens: 1, output_tokens: 1 } }));
    };
    const t = await fo(cloud, { probe: async () => true, backoffMs: () => 10 });
    const a = await t.post("x".repeat(40_000));
    expect(a.text).toContain("from-cloud");
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

describe("multi-instance engines: slots per instance, requests run on whichever instance has a free slot", () => {
  const instances = (n: number, slots: number) => {
    const s = new RequestScheduler();
    const keys = Array.from({ length: n }, (_, k) => (k === 0 ? "p" : `p#${k + 1}`));
    for (const k of keys) s.setSlots(k, slots);
    return { s, keys };
  };
  const spread = async (s: RequestScheduler, keys: string[], jobs: number) => {
    const tickets = await Promise.all(Array.from({ length: jobs }, (_, j) => s.acquire(keys[0], `s${j}`, `w${j}`, undefined, undefined, undefined, keys)));
    return tickets;
  };

  it("two instances, cap 2 each, 4 concurrent jobs: 2 per instance", async () => {
    const { s, keys } = instances(2, 2);
    const t = await spread(s, keys, 4);
    expect(keys.map((k) => t.filter((x) => x.engine === k).length)).toEqual([2, 2]);
  });

  it("three instances, 6 jobs: 2 each", async () => {
    const { s, keys } = instances(3, 2);
    const t = await spread(s, keys, 6);
    expect(keys.map((k) => t.filter((x) => x.engine === k).length)).toEqual([2, 2, 2]);
  });

  it("one instance full, one free: the next goes to the free one; a queued job moves to whichever frees", async () => {
    const { s, keys } = instances(2, 1);
    const a = await s.acquire(keys[0], "a", "wa");
    const b = await s.acquire(keys[0], "b", "wb", undefined, undefined, undefined, keys);
    expect(a.engine).toBe(keys[0]);
    expect(b.engine).toBe(keys[1]);
    let granted: string | undefined;
    void s.acquire(keys[0], "c", "wc", undefined, undefined, undefined, keys).then((t) => (granted = t.engine));
    await Promise.resolve();
    expect(granted).toBeUndefined();
    b.release();
    await until(() => granted !== undefined);
    expect(granted).toBe(keys[1]);
    expect(s.snapshot().engines[keys[0]].queued).toEqual({});
  });

  it("a single-slot engine without alternatives still serves one request at a time", async () => {
    const s = new RequestScheduler();
    const a = await s.acquire("solo", "a", "wa");
    let second = false;
    void s.acquire("solo", "b", "wb").then(() => (second = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(second).toBe(false);
    a.release();
    await until(() => second);
  });
});

describe("/cockpit/queue off the event loop", () => {
  it("a large log dir is walked in the thread: the loop never stalls, later requests answer from the snapshot", async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { cockpitQueueAsync, enableQueueThread } = await import("./cockpit.js");
    const dir = mkdtempSync(join(tmpdir(), "queue-thread-"));
    for (let i = 0; i < 3000; i++) {
      const id = `20260101-0000${String(i).padStart(5, "0")}-${i}`;
      writeFileSync(join(dir, `${id}.status`), JSON.stringify({ id, state: "done", provider: "anthropic", model: "m", started: "2026-01-01 00:00:00", label: "x", cwd: "/tmp" }));
    }
    enableQueueThread();
    let maxLag = 0;
    let last = Date.now();
    const timer = setInterval(() => {
      const n = Date.now();
      maxLag = Math.max(maxLag, n - last - 10);
      last = n;
    }, 10);
    try {
      const first = await cockpitQueueAsync(() => dir);
      expect(first.value.providers).toBeDefined();
      const t0 = Date.now();
      await cockpitQueueAsync(() => dir);
      expect(Date.now() - t0).toBeLessThan(50);
      expect(maxLag).toBeLessThan(200);
    } finally {
      clearInterval(timer);
      enableQueueThread(false);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("loop capture on the router path for local models", () => {
  // local workers point ANTHROPIC_BASE_URL at the router; the standalone proxy never
  // sees those requests, so the router keeps the last turns per run and the loop
  // guard's stop writes them (forwarded body, upstream instance port, no secrets).
  async function capRig(instances: number) {
    const dir = mkdtempSync(join(tmpdir(), "router-loopcap-"));
    closers.push(() => rmSync(dir, { recursive: true, force: true }));
    const seen: Array<{ body: unknown; port: number }> = [];
    const ports: number[] = [];
    for (let i = 0; i < instances; i++) {
      const up = http.createServer((req, res) => {
        const bits: Buffer[] = [];
        req.on("data", (c) => bits.push(c));
        req.on("end", () => {
          seen.push({ body: JSON.parse(Buffer.concat(bits).toString("utf8")), port: ports[i]! });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "gyro-m", content: [{ type: "text", text: `ok${i}` }], usage: { input_tokens: 1, output_tokens: 1 } }));
        });
      });
      ports.push(await listen(up));
    }
    const prov = parseWorkersConfig({
      providers: {
        gyro: {
          baseUrl: `http://127.0.0.1:${ports[0]}`,
          models: { default: "gyro-m" },
          ...(instances > 1 ? { instances, maxConcurrent: instances } : {}),
        },
      },
    }).providers;
    const ring = new LoopCaptureRing();
    const r = createRouter(() => prov, "http://127.0.0.1:1", () => {}, undefined, undefined, {
      instances: () => [],
      captureRing: ring,
      captureLogDir: dir,
    });
    const port = await listen(r);
    const post = (worker: string | null, userId?: string) =>
      new Promise<{ status: number; text: string }>((resolve) => {
        const q = http.request(
          {
            port,
            host: "127.0.0.1",
            path: "/v1/messages",
            method: "POST",
            headers: { "content-type": "application/json", ...(worker ? { "x-pai-worker": worker } : {}), authorization: "Bearer client-secret" },
          },
          (x) => {
            let text = "";
            x.on("data", (c) => (text += c));
            x.on("end", () => resolve({ status: x.statusCode ?? 0, text }));
          }
        );
        q.on("error", () => resolve({ status: 0, text: "" }));
        q.end(JSON.stringify({ model: "gyro-m", max_tokens: 10, messages: [{ role: "user", content: "hi" }], ...(userId ? { metadata: { user_id: userId } } : {}) }));
      });
    return { dir, ring, seen, ports, post };
  }

  it("a local /v1/messages turn is kept with the forwarded body and the serving instance port", async () => {
    const t = await capRig(2);
    const a = await t.post("w1");
    expect(a.status).toBe(200);
    const turns = t.ring.get("w1");
    expect(turns.length).toBe(1);
    expect(turns[0].request).toEqual(t.seen[0].body); // exactly what the engine received
    expect((turns[0].request as { model: string }).model).toBe("gyro-m");
    expect(turns[0].response).toContain("ok");
    expect(t.ports).toContain(turns[0].upstreamPort);
    const b = await t.post("w1");
    expect(b.status).toBe(200);
    expect(t.ring.get("w1").length).toBe(2);
    expect(t.ring.get("w1")[1].upstreamPort).toBe(t.ring.get("w1")[0].upstreamPort); // same session, sticky instance
  });

  it("a simulated loop stop writes the capture: forwarded body, upstream port, mode 600, no secrets, ledger line", async () => {
    const t = await capRig(1);
    await t.post("wStop");
    // the hook's stop leaves the marker; the router flushes on its next request
    writeFileSync(loopStopMarkerPath(t.dir, "wStop"), JSON.stringify({ ts: new Date().toISOString(), reason: "identical-call loop" }));
    await t.post("wStop");
    const path = loopCapturePath(t.dir, "wStop");
    const raw = readFileSync(path, "utf8");
    const payload = JSON.parse(raw) as { id: string; reason: string; turns: Array<{ request: Record<string, unknown>; response: string; upstreamPort?: number }> };
    expect(payload.id).toBe("wStop");
    expect(payload.reason).toBe("identical-call loop");
    expect(payload.turns.length).toBe(1); // the turn kept before the stop; the post-stop turn is not captured again
    expect(payload.turns[0].request).toEqual(t.seen[0].body);
    expect(payload.turns[0].upstreamPort).toBe(t.ports[0]);
    expect(payload.turns[0].response).toContain("ok0");
    expect(raw).not.toContain("client-secret");
    expect(raw.toLowerCase()).not.toContain("authorization");
    expect(raw.toLowerCase()).not.toContain("api_key");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const ledger = readFileSync(join(t.dir, "ledger.log"), "utf8");
    expect(ledger).toContain("LOOP-CAPTURE");
    expect(ledger).toContain("wStop");
  });

  it("the hook path writes the capture directly when it shares the ring", async () => {
    // the hook (loop-stop) captures on the process-wide default ring, which is what
    // a router running without an injected ring uses; the marker-flush path (test
    // above) covers the cross-process case.
    const dir = mkdtempSync(join(tmpdir(), "router-loopcap-hook-"));
    closers.push(() => rmSync(dir, { recursive: true, force: true }));
    defaultLoopCaptureRing.clear("wHook");
    const up = http.createServer((req, res) => {
      const bits: Buffer[] = [];
      req.on("data", (c) => bits.push(c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "gyro-m", content: [{ type: "text", text: "ok0" }], usage: { input_tokens: 1, output_tokens: 1 } }));
      });
    });
    const port = await listen(up);
    const prov = parseWorkersConfig({
      providers: { gyro: { baseUrl: `http://127.0.0.1:${port}`, models: { default: "gyro-m" } } },
    }).providers;
    const r = createRouter(() => prov, "http://127.0.0.1:1", () => {}, undefined, undefined, {
      instances: () => [],
      captureLogDir: dir,
    });
    const routerPort = await listen(r);
    await new Promise<void>((resolve) => {
      const q = http.request({ port: routerPort, host: "127.0.0.1", path: "/v1/messages", method: "POST", headers: { "content-type": "application/json", "x-pai-worker": "wHook" } }, (x) => {
        x.on("data", () => {});
        x.on("end", () => resolve());
      });
      q.on("error", () => resolve());
      q.end(JSON.stringify({ model: "gyro-m", max_tokens: 5, messages: [{ role: "user", content: "hi" }] }));
    });
    expect(defaultLoopCaptureRing.get("wHook").length).toBe(1);
    requestLoopStop(dir, "wHook", "loop guard", { kill: () => {}, claudePid: () => undefined });
    const raw = readFileSync(loopCapturePath(dir, "wHook"), "utf8");
    const payload = JSON.parse(raw) as { reason: string; turns: Array<{ upstreamPort?: number }> };
    expect(payload.reason).toBe("loop guard");
    expect(payload.turns[0].upstreamPort).toBe(port);
    expect(defaultLoopCaptureRing.get("wHook").length).toBe(0);
  });

  it("a cloud target is never captured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "router-loopcap-cloud-"));
    closers.push(() => rmSync(dir, { recursive: true, force: true }));
    const cloud = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: "cloud" }], usage: { input_tokens: 1, output_tokens: 1 } }));
      });
    });
    const cloudPort = await listen(cloud);
    const ring = new LoopCaptureRing();
    const r = createRouter(() => ({}), `http://127.0.0.1:${cloudPort}`, () => {}, undefined, undefined, {
      instances: () => [],
      captureRing: ring,
      captureLogDir: dir,
    });
    const port = await listen(r);
    const res = await new Promise<{ status: number }>((resolve) => {
      const q = http.request({ port, host: "127.0.0.1", path: "/v1/messages", method: "POST", headers: { "content-type": "application/json", "x-pai-worker": "wCloud" } }, (x) => {
        x.on("data", () => {});
        x.on("end", () => resolve({ status: x.statusCode ?? 0 }));
      });
      q.on("error", () => resolve({ status: 0 }));
      q.end(JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 5, messages: [{ role: "user", content: "hi" }] }));
    });
    expect(res.status).toBe(200);
    expect(ring.get("wCloud").length).toBe(0);
  });

  it("metadata.user_id names the run when no worker header is present", async () => {
    const t = await capRig(1);
    await t.post(null, "sess-9");
    expect(t.ring.get("sess-9").length).toBe(1);
  });
});

describe("cockpit polled endpoints share one computation", () => {
  it("100 workers-config reads parse once; limits/system bodies are identical within 1 s and recomputed after", async () => {
    const { readWorkersCached } = await import("../workers/config.js");
    const w = readWorkersCached();
    for (let i = 0; i < 100; i++) expect(readWorkersCached()).toBe(w);
    const { limitsBodyShared, systemBodyShared, COCKPIT_BODY_TTL_MS } = await import("./cockpit.js");
    let gets = 0;
    const limits = { get: async () => (gets++, []) };
    const bodies = await Promise.all(Array.from({ length: 100 }, () => limitsBodyShared(limits)));
    expect(gets).toBe(1);
    expect(new Set(bodies.map((b) => b.value)).size).toBe(1);
    let snaps = 0;
    const system = { snapshot: async () => ({ n: ++snaps }) } as never;
    const a = await systemBodyShared({ system, limits, win: "1h" as never });
    const b = await systemBodyShared({ system, limits, win: "1h" as never });
    expect(b.value).toBe(a.value);
    expect(snaps).toBe(1);
    await new Promise((r) => setTimeout(r, COCKPIT_BODY_TTL_MS + 50));
    await limitsBodyShared(limits);
    expect(gets).toBe(3); // limits body, system body, limits body again
  }, 30_000);
});
