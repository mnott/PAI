/**
 * pane-nonblocking.test.ts — the daemon's pane tasks never hold the event loop on an external call:
 * a fake `ps` / `osascript` / `pgrep` that sleeps 10 s is killed at its limit while a loop timer keeps firing.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { psTableAsync } from "./ps-table.js";
import { osascriptJxa } from "./pane.js";
import { ownsPidAsync, ownsPidCachedAsync, type WorkerStatus } from "./status.js";
import { detectSupervisionEvents, type SupervisionEvent } from "./supervision.js";

let bin: string;
let oldPath: string | undefined;
beforeEach(() => {
  bin = mkdtempSync(join(tmpdir(), "slow-bin-"));
  for (const n of ["ps", "osascript", "pgrep"]) {
    writeFileSync(join(bin, n), "#!/bin/sh\nexec sleep 10\n");
    chmodSync(join(bin, n), 0o755);
  }
  oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
});
afterEach(() => {
  process.env.PATH = oldPath;
  rmSync(bin, { recursive: true, force: true });
});

/** Longest gap between 10 ms timer ticks while `work` runs: the loop's responsiveness (an IPC read waits at most this long). */
async function maxLoopGap(work: Promise<unknown>): Promise<number> {
  let last = performance.now();
  let max = 0;
  const t = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - last);
    last = now;
  }, 10);
  await work.catch(() => undefined);
  clearInterval(t);
  return max;
}

describe("daemon pane tasks never block the loop", () => {
  it("a 10 s ps is killed at its limit and the loop stays responsive", async () => {
    const t0 = performance.now();
    const gap = await maxLoopGap(psTableAsync("command=", 400));
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(gap).toBeLessThan(100);
    await expect(psTableAsync("command=", 200)).rejects.toThrow();
  });

  it("a 10 s osascript is killed at its limit and the loop stays responsive", async () => {
    const t0 = performance.now();
    let err: unknown;
    const gap = await maxLoopGap(osascriptJxa("1", [], 400).catch((e) => { err = e; }));
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(String(err)).toMatch(/timed out/);
    expect(gap).toBeLessThan(100);
  });
});

describe("supervision pid checks never block the loop", () => {
  /** A pid that exists (kill -0 passes) but whose `ps` lookup hangs on the fake binary. */
  const livePid = process.pid;

  it("ownsPidAsync with a 10 s ps times out at 5 s and the loop stays responsive", async () => {
    // a pid that does not exist: alive() short-circuits, so the check must go through the async ps path
    // a dead pid never reaches ps: alive() short-circuits, so the check is instant
    expect(await ownsPidAsync({ id: "w-1", pid: 999_999, started: "2026-11-24 00:00:00" })).toBe(false);
    const t1 = performance.now();
    const gap = await maxLoopGap(ownsPidAsync({ id: "w-1", pid: livePid, started: "2026-11-24 00:00:00" }));
    const elapsed = performance.now() - t1;
    expect(elapsed).toBeGreaterThanOrEqual(4_500); // killed at the 5 s limit, not earlier
    expect(elapsed).toBeLessThan(6_000);
    // the 100 ms budget is the daemon's supervision tick: the loop must stay responsive while the ps runs
    expect(gap).toBeLessThan(100);
  }, 10_000);

  it("ownsPidCachedAsync with a 10 s ps times out at 5 s and the loop stays responsive", async () => {
    const t0 = performance.now();
    const gap = await maxLoopGap(ownsPidCachedAsync({ id: "w-2", pid: livePid, started: "2026-11-24 00:00:00" }));
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(4_500);
    expect(elapsed).toBeLessThan(6_000);
    expect(gap).toBeLessThan(100);
  }, 10_000);

  it("a sleeping worker's 10 s pgrep is killed at its limit and the loop stays responsive", async () => {
    const s: WorkerStatus = {
      id: "w-3",
      pid: livePid,
      label: "sleeping worker",
      state: "running",
      updated: "2026-11-24 02:09:59Z",
      spawnerSession: "sess-1",
      sleepSec: 300,
      cwd: "/tmp",
      term: "x",
      provider: "gyro-l",
      model: "m",
      origin: "spawn",
      turns: 1,
      last: "sleep 300",
      started: "2026-11-24 00:00:00",
      tools: 0,
      rc: null,
      secs: 0,
    };
    const t0 = performance.now();
    let events: SupervisionEvent[] = [];
    const gap = await maxLoopGap(
      detectSupervisionEvents([s], { stallMs: 60_000, now: new Date("2026-11-24T02:10:00Z"), isAlive: () => true }).then((e) => { events = e; })
    );
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(4_500); // pgrep killed at the 5 s limit
    expect(elapsed).toBeLessThan(6_000);
    // a killed pgrep reads as "no children": the sleeping alert still fires, degraded but never blocking
    expect(events.map((e) => e.kind)).toContain("sleeping");
  }, 10_000);
});
