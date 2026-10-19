import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CAPACITY, capacityGate, liveQueue, resolveCap, type CapacityInfo } from "./capacity.js";
import type { WorkerStatus } from "./status.js";

const DEAD = 999999;
const st = (id: string, over: Partial<WorkerStatus> = {}): WorkerStatus =>
  ({ id, pid: 100, provider: "p", state: "running", turns: 0, origin: "spawn", ...over }) as WorkerStatus;

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function harness(statuses: (elapsedMs: number) => WorkerStatus[], self: string, cap: number | undefined = 3) {
  const logDir = mkdtempSync(join(tmpdir(), "cap-"));
  dirs.push(logDir);
  let t = 0;
  const lines: string[] = [];
  const waits: (CapacityInfo | null)[] = [];
  const base = {
    logDir,
    self: { id: self, provider: "p", pid: 200 },
    cap,
    config: DEFAULT_CAPACITY,
    log: (l: string) => lines.push(l),
    onWait: (w: CapacityInfo | null) => waits.push(w),
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    load: () => statuses(t),
    isAlive: (pid: number) => pid !== DEAD,
  };
  return { base, lines, waits, elapsed: () => t };
}

describe("capacityGate", () => {
  it("queues the 4th run behind 3 live ones and releases when one ends", async () => {
    const h = harness(
      (ms) => [st("a"), st("b"), st("c", { state: ms >= 1000 ? "done" : "running" }), st("d")],
      "d",
    );
    const r = await capacityGate(h.base);
    expect(r?.cap).toBe(3);
    expect(h.lines[0]).toBe("queued: 4 on p, cap 3 (position 1)");
    expect(h.waits[0]).toMatchObject({ provider: "p", cap: 3, total: 4, position: 1 });
    expect(h.waits.at(-1)).toBeNull();
    expect(h.elapsed()).toBeGreaterThanOrEqual(1000);
    expect(h.elapsed()).toBeLessThan(2500);
    expect(liveQueue(h.base.logDir, "p", h.base.isAlive)).toEqual([]);
  });

  it("logs a heartbeat at least every 60 s while queued", async () => {
    const h = harness(() => [st("a"), st("b"), st("c", { state: "done" })].map((x, i) => (i === 2 ? st("c", { state: "running" }) : x)), "d");
    let sleeps = 0;
    const sleep = async (ms: number) => {
      await h.base.sleep(ms === 2000 ? 20_000 : ms);
      if (++sleeps > 12) throw new Error("stop");
    };
    await expect(capacityGate({ ...h.base, sleep })).rejects.toThrow("stop");
    const beats = h.lines.filter((l) => l.startsWith("queued: still waiting"));
    expect(beats.length).toBeGreaterThanOrEqual(2);
    expect(beats[0]).toMatch(/^queued: still waiting, position 1, \d+s$/);
  });

  it("does not wait below the cap", async () => {
    const h = harness(() => [st("a"), st("b")], "c");
    expect(await capacityGate(h.base)).toBeNull();
    expect(h.elapsed()).toBe(0);
  });

  it("releases queued runs FIFO: a free slot does not let z pass an earlier queued x", async () => {
    const h = harness(() => [st("a"), st("b")], "z");
    const qdir = join(h.base.logDir, "queue", "p");
    mkdirSync(qdir, { recursive: true });
    writeFileSync(join(qdir, "x"), "300"); // earlier queued run, alive
    let sleeps = 0;
    const sleep = async (ms: number) => {
      await h.base.sleep(ms);
      if (++sleeps === 3) writeFileSync(join(qdir, "x"), String(DEAD)); // x dies, z becomes head
    };
    await capacityGate({ ...h.base, sleep });
    expect(h.lines[0]).toBe("queued: 4 on p, cap 3 (position 2)");
    expect(sleeps).toBe(3);
    expect(h.waits.at(-1)).toBeNull();
  });

  it("skips the stale queue entry of a dead run", async () => {
    const h = harness(() => [st("a"), st("b")], "c");
    const qdir = join(h.base.logDir, "queue", "p");
    mkdirSync(qdir, { recursive: true });
    writeFileSync(join(qdir, "a0"), String(DEAD));
    expect(await capacityGate(h.base)).toBeNull();
    expect(liveQueue(h.base.logDir, "p", h.base.isAlive)).toEqual([]);
  });

  it("is unlimited for a remote provider without maxConcurrent", async () => {
    expect(resolveCap(undefined, false)).toBeUndefined();
    expect(resolveCap(undefined, true)).toBe(3);
    expect(resolveCap(5, false)).toBe(5);
    const h = harness(() => Array.from({ length: 10 }, (_, i) => st(`r${i}`)), "z");
    expect(await capacityGate({ ...h.base, cap: resolveCap(undefined, false) })).toBeNull();
    expect(h.elapsed()).toBe(0);
  });

  it("is bypassed by disabled (--no-queue) and config", async () => {
    const live = () => [st("a"), st("b"), st("c")];
    expect(await capacityGate({ ...harness(live, "d").base, disabled: true })).toBeNull();
    expect(await capacityGate({ ...harness(live, "d").base, config: { enabled: false } })).toBeNull();
  });
});
