/**
 * Engine admission by worker priority and pause (scheduler.ts `control`):
 * high before normal before low, FIFO inside a level, a starved low request
 * gets one turn, a live change is read at the next admission, a paused
 * worker's request parks until resume and nothing in flight is touched.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SCHED, RequestScheduler, type ControlSource, type Priority, type SchedConfig, type Ticket } from "./scheduler.js";

function rig(cfg: Partial<SchedConfig> = {}) {
  let t = 1_000_000;
  const ctl = new Map<string, { priority: Priority; paused: boolean }>();
  const control: ControlSource = (w, hint) => ctl.get(w) ?? { priority: hint ?? "normal", paused: false };
  const s = new RequestScheduler(() => ({ ...DEFAULT_SCHED, ...cfg }), () => t);
  s.control = control;
  const order: string[] = [];
  const tickets = new Map<string, Ticket>();
  const ask = (label: string, hint?: Priority, session = "S") => {
    void s.acquire("eng", session, label, undefined, hint).then((tk) => {
      order.push(label);
      tickets.set(label, tk);
    });
  };
  const done = async (label: string) => {
    await Promise.resolve();
    tickets.get(label)!.release({ prefill: 0, decode: 0 });
    await Promise.resolve();
  };
  const set = (w: string, c: Partial<{ priority: Priority; paused: boolean }>) => ctl.set(w, { priority: "normal", paused: false, ...ctl.get(w), ...c });
  return { s, order, ask, done, set, advance: (ms: number) => (t += ms) };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => vi.useRealTimers());

describe("engine admission by priority", () => {
  it("admits high before normal before low, FIFO inside a level", async () => {
    const r = rig();
    r.ask("run"); // takes the engine
    await flush();
    for (const [l, p] of [["l1", "low"], ["n1", "normal"], ["h1", "high"], ["n2", "normal"], ["l2", "low"], ["h2", "high"]] as const) {
      r.set(l, { priority: p });
      r.ask(l);
    }
    await flush();
    const served: string[] = [];
    let cur = "run";
    while (cur) {
      await r.done(cur);
      await flush();
      const next = r.order.find((x) => x !== "run" && !served.includes(x));
      if (!next) break;
      served.push(next);
      cur = next;
    }
    expect(served).toEqual(["h1", "h2", "n1", "n2", "l1", "l2"]);
  });

  it("low is admitted only when no high or normal request waits", async () => {
    const r = rig();
    r.ask("run");
    await flush();
    r.set("low", { priority: "low" });
    r.ask("low");
    await flush();
    await r.done("run");
    await flush();
    expect(r.order).toEqual(["run", "low"]); // alone it goes at once
    r.ask("n"); // normal now waits behind the low in flight; a second low arrives after it
    r.set("low2", { priority: "low" });
    r.ask("low2");
    await r.done("low");
    await flush();
    expect(r.order).toEqual(["run", "low", "n"]);
  });

  it("anti-starvation: a low request waiting past lowAgingSec gets one turn, then the highs go on", async () => {
    const r = rig({ lowAgingSec: 600, agingSec: 100000 });
    r.ask("run");
    await flush();
    r.set("low", { priority: "low" });
    r.ask("low");
    r.set("low2", { priority: "low" });
    r.ask("low2");
    await flush();
    r.advance(601_000);
    r.ask("n1");
    r.ask("n2");
    await flush();
    await r.done("run");
    await flush();
    expect(r.order).toEqual(["run", "low"]); // its turn
    await r.done("low");
    await flush();
    // low2 also waited > 600 s but a low just had its turn: the normals go first
    expect(r.order).toEqual(["run", "low", "n1"]);
    await r.done("n1");
    await flush();
    expect(r.order).toEqual(["run", "low", "n1", "n2"]);
  });

  it("a priority change is read at the next admission (live change)", async () => {
    const r = rig();
    r.ask("run");
    await flush();
    r.ask("a");
    r.ask("b");
    await flush();
    r.set("b", { priority: "high" }); // changed while both wait
    await r.done("run");
    await flush();
    expect(r.order).toEqual(["run", "b"]);
  });

  it("the x-pai-priority hint counts until the control source knows the worker", async () => {
    const r = rig();
    r.ask("run");
    await flush();
    r.ask("a", "low");
    r.ask("b", "high");
    await flush();
    await r.done("run");
    await flush();
    expect(r.order).toEqual(["run", "b"]);
  });
});

describe("pause", () => {
  it("a paused worker's request parks; resume releases it; the in-flight request finishes", async () => {
    vi.useFakeTimers();
    const r = rig();
    r.ask("p"); // in flight when the pause arrives
    await vi.advanceTimersByTimeAsync(0);
    r.set("p", { paused: true });
    await r.done("p"); // finishes
    r.set("p2", { paused: true });
    r.ask("p2");
    r.ask("q");
    await vi.advanceTimersByTimeAsync(0);
    expect(r.order).toEqual(["p", "q"]); // q passes the parked p2 on the idle engine
    await r.done("q");
    await vi.advanceTimersByTimeAsync(3000);
    expect(r.order).toEqual(["p", "q"]); // p2 stays parked
    expect(r.s.snapshot().workers.p2).toMatchObject({ paused: true });
    expect(r.s.snapshot().engines.eng!.queued.S).toBe(1);
    r.set("p2", { paused: false });
    await vi.advanceTimersByTimeAsync(1500); // the router re-checks within a second
    expect(r.order).toEqual(["p", "q", "p2"]);
  });

  it("a paused request is not admitted while the engine idles, and cancelling it frees nothing else", async () => {
    vi.useFakeTimers();
    const r = rig();
    r.set("only", { paused: true });
    r.ask("only");
    await vi.advanceTimersByTimeAsync(5000);
    expect(r.order).toEqual([]);
    r.set("only", { paused: false });
    await vi.advanceTimersByTimeAsync(1100);
    expect(r.order).toEqual(["only"]);
  });
});
