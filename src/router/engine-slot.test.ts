import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { parseWorkersConfig } from "../workers/config.js";
import { createRouter } from "./router.js";
import { DEFAULT_SCHED, RequestScheduler, sharedScheduler } from "./scheduler.js";

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
