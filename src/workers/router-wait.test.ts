import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { beginBuildWait, blockedMsOf, routerWaitMs } from "./active-time.js";
import { effectiveCap, LOCAL_DEFAULT_CAP } from "./capacity.js";
import { parseWorkersConfig } from "./config.js";
import { armDeadline } from "./deadline.js";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "rw-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const sched = (dir: string, workers: Record<string, unknown>): void =>
  writeFileSync(join(dir, "router-sched.json"), JSON.stringify({ at: Date.now(), engines: {}, workers }));

describe("router queue wait", () => {
  it("is zero without a file or entry", () => {
    const d = tmp();
    expect(routerWaitMs(d, "w1", 1000)).toBe(0);
    sched(d, {});
    expect(routerWaitMs(d, "w1", 1000)).toBe(0);
  });

  it("adds closed wait and the wait in progress", () => {
    const d = tmp();
    sched(d, { w1: { waitMsTotal: 5000, waitingSince: 9000 } });
    expect(routerWaitMs(d, "w1", 10_000)).toBe(6000);
  });

  it("re-reads when the file changes", () => {
    const d = tmp();
    sched(d, { w1: { waitMsTotal: 1000, waitingSince: 0 } });
    expect(routerWaitMs(d, "w1", 10_000)).toBe(1000);
    const future = new Date(Date.now() + 5000);
    sched(d, { w1: { waitMsTotal: 2000, waitingSince: 0 } });
    // force a distinct mtime
    utimesSync(join(d, "router-sched.json"), future, future);
    expect(routerWaitMs(d, "w1", 10_000)).toBe(2000);
  });

  it("sums with build-gate waits", () => {
    const d = tmp();
    sched(d, { w1: { waitMsTotal: 3000, waitingSince: 0 } });
    beginBuildWait(d, "w1", 1000);
    expect(blockedMsOf(d, "w1", 4000)).toBe(3000 + 3000);
  });

  it("extends the deadline while queued in the router", () => {
    const d = tmp();
    let t = 0;
    let fired = 0;
    const proc = { kill: () => true, exitCode: null, signalCode: null } as never;
    sched(d, { w1: { waitMsTotal: 0, waitingSince: 0 } });
    const stop = armDeadline(proc, { deadlineAt: 50, minutes: 1 }, () => fired++, 10, () => 100, () => t);
    t = 120;
    expect(fired).toBe(0);
    stop();
  });
});

describe("one admission path", () => {
  it("effectiveCap honours conversationSlots", () => {
    expect(effectiveCap(undefined, true, undefined)).toBe(LOCAL_DEFAULT_CAP);
    expect(effectiveCap(4, true, 3)).toBe(2);
    expect(effectiveCap(undefined, false, 5)).toBe(4);
    expect(effectiveCap(2, true, 1)).toBe(1);
  });
});

describe("workers.waitAlarmMinutes", () => {
  it("defaults to 120 and accepts a positive integer", () => {
    expect(parseWorkersConfig(undefined).waitAlarmMinutes).toBe(120);
    expect(parseWorkersConfig({ waitAlarmMinutes: 30 }).waitAlarmMinutes).toBe(30);
  });
  it("rejects zero and non-integers", () => {
    expect(() => parseWorkersConfig({ waitAlarmMinutes: 0 })).toThrow();
    expect(() => parseWorkersConfig({ waitAlarmMinutes: 1.5 })).toThrow();
  });
});
