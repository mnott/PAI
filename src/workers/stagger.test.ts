import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_STAGGER,
  backoffMs,
  loadWarmupHistory,
  recordWarmup,
  staggerGate,
  warmupLimitSec,
  type WaitInfo,
} from "./stagger.js";
import type { WorkerStatus } from "./status.js";

const T0 = Date.parse("2026-10-17T10:00:02");
const st = (id: string, over: Partial<WorkerStatus> = {}): WorkerStatus =>
  ({ id, pid: process.pid, provider: "p", state: "running", turns: 0, started: "2026-10-17 10:00:00", origin: "spawn", ...over }) as WorkerStatus;

function harness(statuses: (elapsedMs: number) => WorkerStatus[], self = "b") {
  let t = T0;
  const lines: string[] = [];
  const waits: (WaitInfo | null)[] = [];
  const sleeps: number[] = [];
  const base = {
    logDir: "x",
    self: { id: self, provider: "p" },
    local: true,
    config: DEFAULT_STAGGER,
    log: (l: string) => lines.push(l),
    onWait: (w: WaitInfo | null) => waits.push(w),
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    load: () => statuses(t - T0),
    history: undefined as number[] | undefined,
  };
  return { base, lines, waits, sleeps, elapsed: () => t - T0 };
}

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("staggerGate", () => {
  it("waits for the predecessor's first response and reports it", async () => {
    const h = harness((ms) => [st("a", { turns: ms >= 1500 ? 1 : 0 }), st("b")]);
    const r = await staggerGate(h.base);
    expect(r).toMatchObject({ predecessor: "a", release: "answered", limitSec: 20 });
    expect(h.lines[0]).toBe("waiting for a to warm the p cache (max 20s)");
    expect(h.lines[1]).toMatch(/^waited 1\.\ds for a \(predecessor answered\)$/);
    expect(h.elapsed()).toBeLessThan(2500);
  });

  it("publishes elapsed/limit while waiting, and null when released", async () => {
    const h = harness((ms) => [st("a", { turns: ms >= 3000 ? 1 : 0 }), st("b")]);
    await staggerGate(h.base);
    expect(h.waits[0]).toMatchObject({ predecessor: "a", provider: "p", elapsedSec: 0, limitSec: 20 });
    expect(h.waits[0]?.line).toBe("waiting 0s/20s for a to warm p cache");
    expect(h.waits.some((w) => w?.line === "waiting 1s/20s for a to warm p cache")).toBe(true);
    expect(h.waits.at(-1)).toBeNull();
  });

  it("is released by the limit", async () => {
    const h = harness(() => [st("a"), st("b")]);
    const r = await staggerGate(h.base);
    expect(r?.release).toBe("limit");
    expect(h.elapsed()).toBeGreaterThanOrEqual(20_000);
    expect(h.elapsed()).toBeLessThan(22_100);
    expect(h.lines.at(-1)).toMatch(/\(limit reached\)$/);
  });

  it("uses the remote default for remote providers without history", async () => {
    const h = harness(() => [st("a"), st("b")]);
    await staggerGate({ ...h.base, local: false });
    expect(h.elapsed()).toBeGreaterThanOrEqual(8000);
    expect(h.elapsed()).toBeLessThan(10_100);
  });

  it("derives the limit from recorded history", async () => {
    const h = harness(() => [st("a"), st("b")]);
    const r = await staggerGate({ ...h.base, history: [2, 4, 4, 4] });
    expect(r?.limitSec).toBe(6);
    expect(h.lines[0]).toContain("(max 6s)");
  });

  it("releases at once when the predecessor ends without a response", async () => {
    const h = harness((ms) => [ms >= 700 ? st("a", { state: "failed" }) : st("a"), st("b")]);
    const r = await staggerGate(h.base);
    expect(r?.release).toBe("predecessor-ended");
    expect(h.elapsed()).toBeLessThan(1000);
    expect(h.lines.at(-1)).toMatch(/predecessor ended without a response/);
    const gone = harness((ms) => (ms >= 700 ? [st("b")] : [st("a"), st("b")]));
    expect((await staggerGate(gone.base))?.release).toBe("predecessor-ended");
  });

  it("does not wait on another provider", async () => {
    const h = harness(() => [st("a", { provider: "q" }), st("b")]);
    expect(await staggerGate(h.base)).toBeNull();
    expect(h.lines).toEqual([]);
  });

  it("does not wait when disabled by config or flag", async () => {
    const h = harness(() => [st("a"), st("b")]);
    expect(await staggerGate({ ...h.base, config: { ...DEFAULT_STAGGER, enabled: false } })).toBeNull();
    expect(await staggerGate({ ...h.base, disabled: true })).toBeNull();
    expect(h.lines).toEqual([]);
  });

  it("ignores a predecessor that already answered or started long ago", async () => {
    expect(await staggerGate(harness(() => [st("a", { turns: 2 }), st("b")]).base)).toBeNull();
    expect(await staggerGate(harness(() => [st("a", { started: "2026-10-17 09:00:00" }), st("b")]).base)).toBeNull();
  });

  it("polls with exponential backoff", async () => {
    const h = harness((ms) => [st("a", { turns: ms >= 6000 ? 1 : 0 }), st("b")]);
    await staggerGate(h.base);
    expect(h.sleeps.slice(0, 6)).toEqual([250, 500, 1000, 2000, 2000, 2000]);
    expect([0, 1, 2, 3, 4, 9].map(backoffMs)).toEqual([250, 500, 1000, 2000, 2000, 2000]);
  });

  it("queues: each run waits only for its immediate predecessor, one released at a time", async () => {
    // a answers at 3s, b (released then) answers at 5s; c is held for b, not a
    const all = (ms: number) => [
      st("a", { turns: ms >= 3000 ? 1 : 0 }),
      st("b", { turns: ms >= 5000 ? 1 : 0 }),
      st("c"),
    ];
    const hb = harness(all, "b");
    const hc = harness(all, "c");
    const [rb, rc] = [await staggerGate(hb.base), await staggerGate(hc.base)];
    expect(rb?.predecessor).toBe("a");
    expect(rc?.predecessor).toBe("b");
    expect(hc.elapsed()).toBeGreaterThan(hb.elapsed());
    expect(hc.lines[0]).toContain("waiting for b");
    // once b has answered, a later run has nothing to wait for
    const late = harness(() => [st("a", { turns: 1 }), st("b", { turns: 1 }), st("c")], "c");
    expect(await staggerGate(late.base)).toBeNull();
  });
});

describe("warm-up history", () => {
  it("computes clamp(p75 x 1.5, min, max) with defaults without history", () => {
    const c = DEFAULT_STAGGER;
    expect(warmupLimitSec(undefined, true, c)).toBe(20);
    expect(warmupLimitSec([], false, c)).toBe(8);
    expect(warmupLimitSec([1, 1, 1], true, c)).toBe(3);
    expect(warmupLimitSec([10, 10, 10, 10], true, c)).toBe(15);
    expect(warmupLimitSec([200], true, c)).toBe(120);
  });

  it("records a rolling window of 20 per provider", () => {
    const dir = mkdtempSync(join(tmpdir(), "stagger-"));
    dirs.push(dir);
    for (let i = 1; i <= 25; i++) recordWarmup(dir, "p", i);
    recordWarmup(dir, "q", 2.34);
    const h = loadWarmupHistory(dir);
    expect(h.p).toHaveLength(20);
    expect(h.p[0]).toBe(6);
    expect(h.q).toEqual([2.3]);
    expect(loadWarmupHistory(join(dir, "none"))).toEqual({});
  });
});
