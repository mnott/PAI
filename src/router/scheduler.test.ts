import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../daemon/config.js";
import { createRouter } from "./router.js";
import {
  DEFAULT_SCHED,
  RequestScheduler,
  schedConfigFrom,
  schedLine,
  setSchedConfigSource,
  sharedScheduler,
  type SchedConfig,
  type Ticket,
} from "./scheduler.js";
import type { WorkerProvider } from "../workers/config.js";

function rig(cfg: Partial<SchedConfig> = {}) {
  let t = 1_000_000;
  const s = new RequestScheduler(() => ({ ...DEFAULT_SCHED, ...cfg }), () => t);
  const order: string[] = [];
  const tickets = new Map<string, Ticket>();
  const ask = (label: string, session: string, worker = label) => {
    void s.acquire("eng", session, worker).then((tk) => {
      order.push(label);
      tickets.set(label, tk);
    });
  };
  const done = async (label: string, served = { prefill: 0, decode: 0 }) => {
    await Promise.resolve();
    tickets.get(label)!.release(served);
    await Promise.resolve();
  };
  return { s, order, ask, done, advance: (ms: number) => (t += ms) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("RequestScheduler", () => {
  it("serves one request at a time", async () => {
    const r = rig();
    r.ask("a1", "A");
    r.ask("a2", "A");
    await flush();
    expect(r.order).toEqual(["a1"]);
    await r.done("a1");
    await flush();
    expect(r.order).toEqual(["a1", "a2"]);
  });

  it("separate engines (instances of one model) do not block each other", async () => {
    const r = rig();
    const got: string[] = [];
    void r.s.acquire("gyro-m", "A", "w1").then(() => got.push("w1"));
    void r.s.acquire("gyro-m#2", "A", "w2").then(() => got.push("w2"));
    void r.s.acquire("gyro-m", "A", "w3").then(() => got.push("w3"));
    await flush();
    expect(got).toEqual(["w1", "w2"]);
    const snap = r.s.snapshot().engines;
    expect(snap["gyro-m"].inflight?.worker).toBe("w1");
    expect(snap["gyro-m#2"].inflight?.worker).toBe("w2");
    expect(snap["gyro-m"].queued).toEqual({ A: 1 });
  });

  it("is fair across sessions: long prefills push a session behind", async () => {
    const r = rig();
    r.ask("a1", "A");
    await flush();
    r.ask("a2", "A");
    r.ask("b1", "B");
    r.ask("a3", "A");
    r.ask("b2", "B");
    await r.done("a1", { prefill: 40_000, decode: 100 });
    await flush();
    expect(r.order).toEqual(["a1", "b1"]);
    await r.done("b1", { prefill: 500, decode: 100 });
    await flush();
    expect(r.order[2]).toBe("b2"); // B still far below A
    await r.done("b2", { prefill: 500, decode: 100 });
    await flush();
    expect(r.order.slice(0, 4)).toEqual(["a1", "b1", "b2", "a2"]);
    expect(r.s.snapshot().engines.eng!.counters.A).toBeGreaterThan(r.s.snapshot().engines.eng!.counters.B!);
  });

  it("divides cost by the session weight", async () => {
    const r = rig({ sessionWeights: { A: 4 } });
    r.ask("a1", "A");
    await flush();
    r.ask("b1", "B");
    r.ask("a2", "A");
    await r.done("a1", { prefill: 1000, decode: 0 });
    await flush();
    expect(r.s.snapshot().engines.eng!.counters.A).toBe(250);
    // A (250) < B (0)? no: B is lifted nowhere, B=0 goes first
    expect(r.order).toEqual(["a1", "b1"]);
  });

  it("weights prefill and decode tokens", async () => {
    const r = rig({ wTokIn: 1, wTokOut: 2 });
    r.ask("a1", "A");
    await flush();
    await r.done("a1", { prefill: 100, decode: 50 });
    expect(r.s.snapshot().engines.eng!.counters.A).toBe(200);
  });

  it("ages a long-waiting request ahead of fairer ones", async () => {
    const r = rig({ agingSec: 120 });
    r.ask("a1", "A");
    await flush();
    r.ask("a2", "A"); // waits
    await r.done("a1", { prefill: 100_000, decode: 0 }); // A is expensive
    await flush();
    expect(r.order).toEqual(["a1", "a2"]); // a2 runs: nobody else waiting
    r.ask("a3", "A");
    r.advance(130_000);
    r.ask("b1", "B");
    await r.done("a2");
    await flush();
    expect(r.order[2]).toBe("a3"); // aged beats B's lower counter
  });

  it("lifts a re-backlogged session to the lowest backlogged counter", async () => {
    const r = rig();
    r.ask("a1", "A");
    await flush();
    r.ask("b1", "B");
    r.ask("a2", "A");
    await r.done("a1", { prefill: 1000, decode: 0 });
    await flush(); // b1 runs; A waits with 1000
    await r.done("b1", { prefill: 400, decode: 0 });
    await flush(); // a2 runs, B idle with 400
    r.ask("c1", "C"); // C idle all along with 0 → lifted to min(backlogged) = A's 1000
    const c = r.s.snapshot().engines.eng!.counters;
    expect(c.C).toBe(1000);
  });

  it("prefers a warm conversation within a session", async () => {
    const r = rig();
    r.ask("w2", "A", "w2");
    await flush();
    await r.done("w2"); // w2 finished just now: warm
    r.ask("hold", "A", "hold");
    await flush();
    r.ask("w1", "A", "w1"); // older, cold
    r.advance(10);
    r.ask("w2b", "A", "w2");
    await r.done("hold");
    await flush();
    expect(r.order.slice(-1)).toEqual(["w2b"]);
  });

  it("stops being warm after five minutes", async () => {
    const r = rig();
    r.ask("w2", "A", "w2");
    await flush();
    await r.done("w2");
    r.ask("hold", "A", "hold");
    await flush();
    r.ask("w1", "A", "w1");
    r.advance(6 * 60_000);
    r.ask("w2b", "A", "w2");
    await r.done("hold");
    await flush();
    expect(r.order.slice(-1)).toEqual(["w1"]);
  });

  it("drops a cancelled waiter without serving it", async () => {
    const r = rig();
    r.ask("a1", "A");
    await flush();
    let abort = () => {};
    const p = r.s.acquire("eng", "B", "b1", { onAbort: (cb) => (abort = cb) });
    abort();
    await expect(p).rejects.toThrow(/cancelled/);
    expect(r.s.snapshot().engines.eng!.queued).toEqual({});
  });

  it("accounts queue wait and service time per worker", async () => {
    const r = rig();
    r.ask("a1", "A");
    await flush();
    r.ask("b1", "B");
    r.advance(5000);
    await r.done("a1");
    await flush();
    r.advance(2000);
    await r.done("b1");
    const w = r.s.snapshot().workers;
    expect(w.b1).toMatchObject({ lastWaitMs: 5000, lastServiceMs: 2000, requests: 1 });
    expect(w.a1).toMatchObject({ lastWaitMs: 0, lastServiceMs: 5000 });
  });

  it("renders the ps line", () => {
    expect(schedLine({ at: 1, workers: {}, engines: { gyro: { inflight: { session: "s1", worker: "w", sinceMs: 1 }, queued: { s2: 2 }, counters: { s1: 10, s2: 3 } } } })).toBe(
      "local scheduler: gyro in flight (s1), queued s2 2, s1 10 tokens served, s2 3 tokens served"
    );
    expect(schedLine(null)).toBe("");
  });

  it("copies of one model read as one engine with a count", () => {
    const e = (session: string) => ({ inflight: { session, worker: "w", sinceMs: 1 }, queued: {}, counters: { [session]: 5 } });
    expect(schedLine({ at: 1, workers: {}, engines: { gyro: e("s1"), "gyro#2": e("s2") } })).toBe(
      "local scheduler: gyro x2 in flight (s1, s2), s1 5 tokens served, s2 5 tokens served"
    );
  });

  it("names sessions when known, else the first 8 chars — never a raw uuid; counters read as tokens served", () => {
    const uuid = "d875bcac-1111-2222-3333-444455556666";
    const s = { at: 1, workers: {}, engines: { gyro: { inflight: { session: uuid, worker: "w", sinceMs: 1 }, queued: {}, counters: { [uuid]: 18120 } } } };
    expect(schedLine(s)).toBe("local scheduler: gyro in flight (d875bcac), d875bcac 18120 tokens served");
    expect(schedLine(s, { [uuid]: "PAI" })).toBe("local scheduler: gyro in flight (PAI), PAI 18120 tokens served");
  });

  it("parses config over the defaults", () => {
    expect(schedConfigFrom({ wTokOut: 3, enabled: false, sessionWeights: { a: 2, b: -1 }, agingSec: "x" })).toEqual({
      enabled: false, wTokIn: 1, wTokOut: 3, agingSec: 120, sessionWeights: { a: 2 }, warmMs: 300_000, pingMs: 15_000,
    });
  });
});

/** A temp PAI_HOME/config.yaml (PAI_CONFIG_FILE, never the live files): the shipped
 *  defaults merged under it, read through loadConfig → schedConfigFrom. */
function tempConfig(yaml: string): () => void {
  const savedHome = process.env.PAI_HOME;
  const savedFile = process.env.PAI_CONFIG_FILE;
  const dir = mkdtempSync(join(tmpdir(), "sched-cfg-"));
  process.env.PAI_HOME = dir;
  process.env.PAI_CONFIG_FILE = join(dir, "config.yaml");
  writeFileSync(process.env.PAI_CONFIG_FILE, yaml);
  return () => {
    if (savedHome === undefined) delete process.env.PAI_HOME;
    else process.env.PAI_HOME = savedHome;
    if (savedFile === undefined) delete process.env.PAI_CONFIG_FILE;
    else process.env.PAI_CONFIG_FILE = savedFile;
    rmSync(dir, { recursive: true, force: true });
  };
}

/** Upstream is gated, not timed: B queues behind A, and is released only once two pings
 *  have arrived on B's stream — no wall-clock budget to miss under load. */
async function expectQueuedPings() {
  let release!: () => void;
  const t = await setup(() => 0, true, new Promise<void>((r) => (release = r)));
  const until = async (ok: () => boolean) => { while (!ok()) await new Promise((r) => setTimeout(r, 5)); };
  const first = t.call("one", "A", "w1");
  await until(() => t.served.length === 1);
  let seen = "";
  const second = t.call("two", "B", "w2", true, (text) => (seen = text));
  await until(() => (seen.match(/event: ping/g) ?? []).length >= 2);
  release();
  const [, b] = await Promise.all([first, second]);
  expect(b.status).toBe(200);
  expect(b.text.match(/event: ping/g)!.length).toBeGreaterThanOrEqual(2);
  expect(b.text).toContain("message_delta");
}

describe("router.scheduling values from config", () => {
  afterEach(() => setSchedConfigSource(() => DEFAULT_SCHED));

  it("wTokOut from a user config changes the token weighting", async () => {
    const cleanup = tempConfig("router:\n  scheduling:\n    wTokOut: 5\n");
    try {
      const r = rig(schedConfigFrom(loadConfig().router.scheduling));
      r.ask("a1", "A");
      await flush();
      await r.done("a1", { prefill: 100, decode: 50 });
      expect(r.s.snapshot().engines.eng!.counters.A).toBe(350); // 100 + 5 × 50, not the default 200
    } finally {
      cleanup();
    }
  });

  it("wTokIn from a user config changes the prefill weighting", async () => {
    const cleanup = tempConfig("router:\n  scheduling:\n    wTokIn: 3\n");
    try {
      const r = rig(schedConfigFrom(loadConfig().router.scheduling));
      r.ask("a1", "A");
      await flush();
      await r.done("a1", { prefill: 100, decode: 50 });
      expect(r.s.snapshot().engines.eng!.counters.A).toBe(400); // 3 × 100 + 2 × 50, not the default 200
    } finally {
      cleanup();
    }
  });

  it("agingSec from a user config changes when a waiting request ages ahead", async () => {
    const cleanup = tempConfig("router:\n  scheduling:\n    agingSec: 30\n");
    try {
      const r = rig(schedConfigFrom(loadConfig().router.scheduling));
      r.ask("a1", "A");
      await flush();
      r.ask("a2", "A"); // waits
      await r.done("a1", { prefill: 100_000, decode: 0 }); // A is expensive
      await flush();
      r.ask("a3", "A");
      r.advance(40_000); // past the configured 30 s, under the default 120 s
      r.ask("b1", "B");
      await r.done("a2");
      await flush();
      expect(r.order[2]).toBe("a3"); // aged at 30 s beats B's lower counter
    } finally {
      cleanup();
    }
  });

  it("warmMs from a user config changes when a conversation stops being warm", async () => {
    const cleanup = tempConfig("router:\n  scheduling:\n    warmMs: 60000\n");
    try {
      const r = rig(schedConfigFrom(loadConfig().router.scheduling));
      r.ask("w2", "A", "w2");
      await flush();
      await r.done("w2");
      r.ask("hold", "A", "hold");
      await flush();
      r.ask("w1", "A", "w1");
      r.advance(90_000); // past the configured 60 s, under the default 5 min
      r.ask("w2b", "A", "w2");
      await r.done("hold");
      await flush();
      expect(r.order.slice(-1)).toEqual(["w1"]); // w2's conversation is cold at 60 s
    } finally {
      cleanup();
    }
  });

  it("pingMs from a user config pings a queued stream at the configured interval", async () => {
    const cleanup = tempConfig("router:\n  scheduling:\n    pingMs: 25\n");
    try {
      setSchedConfigSource(() => schedConfigFrom(loadConfig().router.scheduling));
      await expectQueuedPings();
    } finally {
      cleanup();
    }
  });
});

const closers: Array<() => void> = [];
afterEach(() => {
  closers.splice(0).forEach((c) => c());
  setSchedConfigSource(() => DEFAULT_SCHED);
  delete process.env.PAI_ROUTER_PING_MS;
});

async function setup(holdMs: (n: number) => number, stream = false, gate?: Promise<void>) {
  let active = 0;
    let maxActive = 0;
    const served: string[] = [];
    const up = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const tag = (JSON.parse(Buffer.concat(chunks).toString()).messages[0].content as string) ?? "?";
        active++;
        maxActive = Math.max(maxActive, active);
        served.push(tag);
        const respond = () => {
          active--;
          if (stream) {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end('event: message_delta\ndata: {"type": "message_delta", "delta": {}, "usage": {"output_tokens": 3}}\n\n');
          } else {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "m", usage: { input_tokens: tag.startsWith("long") ? 9000 : 10, output_tokens: 3 } }));
          }
        };
        if (gate) void gate.then(respond);
        else setTimeout(respond, holdMs(served.length));
      });
    });
    await new Promise<void>((r) => up.listen(0, "127.0.0.1", r));
    const provider = {
      enabled: true, protocol: "anthropic", baseUrl: `http://127.0.0.1:${(up.address() as AddressInfo).port}`,
      keyFile: null, models: { default: "qwen-test" }, env: {},
    } as unknown as WorkerProvider;
    const router = createRouter(() => ({ eng: provider }), "http://127.0.0.1:1", () => {}, () => {});
    await new Promise<void>((r) => router.listen(0, "127.0.0.1", r));
    closers.push(() => { router.close(); up.close(); });
    const port = (router.address() as AddressInfo).port;
    const call = (tag: string, session: string, worker: string, bodyStream = stream, onData?: (text: string) => void) =>
      new Promise<{ status: number; text: string }>((resolve, reject) => {
        const rq = http.request(
          { host: "127.0.0.1", port, path: "/v1/messages", method: "POST", headers: { "x-pai-provider": "eng", "x-pai-session": session, "x-pai-worker": worker } },
          (res) => {
            let text = "";
            res.on("data", (c) => { text += c; onData?.(text); });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
          }
        );
        rq.on("error", reject);
        rq.end(JSON.stringify({ model: "qwen-test", stream: bodyStream, messages: [{ role: "user", content: tag }] }));
      });
  return { call, served, maxActive: () => maxActive, port };
}

describe("router scheduling", () => {
  it("demo: two sessions, one engine slot, service order", async () => {
    const t = await setup(() => 30);
    const reqs = [
      t.call("long-A1", "sessA", "wa1"),
      t.call("long-A2", "sessA", "wa2"),
      t.call("long-A3", "sessA", "wa3"),
    ];
    await new Promise((r) => setTimeout(r, 10));
    reqs.push(t.call("short-B1", "sessB", "wb1"), t.call("short-B2", "sessB", "wb2"));
    await Promise.all(reqs);
    expect(t.maxActive()).toBe(1);
    // A1 runs first (arrived alone); its 9000-token prefill pushes A behind B
    expect(t.served).toEqual(["long-A1", "short-B1", "short-B2", "long-A2", "long-A3"]);
    const snap = sharedScheduler().snapshot();
    expect(snap.workers.wb1!.lastWaitMs).toBeGreaterThan(0);
  });

  it("pings a queued stream every interval, then delivers the response", async () => {
    process.env.PAI_ROUTER_PING_MS = "25";
    await expectQueuedPings();
  });

  it("fails open when the scheduler config source throws", async () => {
    setSchedConfigSource(() => { throw new Error("boom"); });
    const t = await setup(() => 40);
    const [a, b] = await Promise.all([t.call("x", "A", "w1"), t.call("y", "B", "w2")]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(t.maxActive()).toBe(2); // forwarded directly, no serialization
  });

  it("does not schedule when disabled", async () => {
    setSchedConfigSource(() => ({ ...DEFAULT_SCHED, enabled: false }));
    const t = await setup(() => 40);
    await Promise.all([t.call("x", "A", "w1"), t.call("y", "B", "w2")]);
    expect(t.maxActive()).toBe(2);
  });
});
