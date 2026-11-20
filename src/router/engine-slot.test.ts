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
  const r = createRouter(() => prov, "http://127.0.0.1:1", () => {}, undefined, undefined, { instances: () => [], onSlotReleased: (i) => released.push(i) });
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
  return { post, released, upstreamClosed, calls: () => n };
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
  async function fo(cloud: Cloud | null, extra: Record<string, unknown> = {}) {
    const seen = { cloud: 0, local: 0, localBody: "" as string, localHeaders: {} as http.IncomingHttpHeaders };
    const local = http.createServer((req, res) => {
      seen.local++;
      seen.localHeaders = req.headers;
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
