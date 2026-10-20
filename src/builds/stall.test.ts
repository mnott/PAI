import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { declaredLogs } from "./gate.js";
import { enqueue, getTicket, listBuilds, patchTicket, renderBuildQueue, tryStart } from "./queue.js";
import { stallMinutes } from "./config.js";
import { stallTick, type StallState } from "./stall.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pai-stall-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const info = (label: string, key: string) => ({ pid: process.pid, label, session: "worker w1", cmd: "sh tools/build.sh test mac", mode: "delta" as const, key });

describe("build stall", () => {
  it("flags a running job whose logs stop growing, once, and tells the owner", async () => {
    const a = await enqueue(dir, info("A", "k"));
    await enqueue(dir, info("B", "k"));
    expect(await tryStart(dir, a.id, 1)).toBe(true);
    await patchTicket(dir, a.id, { logs: ["/door.log"] });
    const sizes: Record<string, number> = { [a.log as string]: 0, "/door.log": 100 };
    let clock = 1_000_000;
    const told: string[] = [];
    const logs: string[] = [];
    const state: StallState = new Map();
    const deps = {
      size: (p: string) => sizes[p] ?? null,
      lastLine: (p: string) => (p === "/door.log" ? "Test Case '-[X testACommentIsNotAnEntry]' started." : ""),
      now: () => clock,
      log: (l: string) => logs.push(l),
      notify: (_t: unknown, text: string) => void told.push(text),
    };
    const tick = async () => stallTick(dir, await listBuilds(dir), 5, state, deps);
    expect(await tick()).toEqual([]);
    clock += 4 * 60_000;
    sizes["/door.log"] = 200; // growth resets the clock
    expect(await tick()).toEqual([]);
    clock += 4 * 60_000;
    expect(await tick()).toEqual([]);
    clock += 2 * 60_000;
    expect(await tick()).toEqual([a.id]);
    expect(told).toHaveLength(1);
    expect(told[0]).toContain("stalled 6 min");
    expect(told[0]).toContain("testACommentIsNotAnEntry");
    expect(told[0]).toContain("B (worker w1)");
    expect(told[0]).toContain("-default-test-execution-time-allowance");
    expect(logs[0]).toMatch(/^BUILD-STALL /);
    clock += 10 * 60_000;
    expect(await tick()).toEqual([]); // told once
    const t = await getTicket(dir, a.id);
    expect(t?.stalledAt).toBeDefined();
    expect(renderBuildQueue(await listBuilds(dir), 1, 2, clock)).toContain("STALLED 10m");
    sizes["/door.log"] = 300; // output resumes: flag clears
    await tick();
    expect((await getTicket(dir, a.id))?.stalledAt).toBeUndefined();
  });

  it("no xcodebuild hint for a plain job; waiting jobs are never flagged", async () => {
    const a = await enqueue(dir, { ...info("A", "k"), cmd: "make" });
    await enqueue(dir, info("W", "w"));
    await tryStart(dir, a.id, 1);
    let clock = 0;
    const told: string[] = [];
    const state: StallState = new Map();
    const deps = { size: () => 5, lastLine: () => "linking", now: () => clock, log: () => {}, notify: (_t: unknown, x: string) => void told.push(x) };
    await stallTick(dir, await listBuilds(dir), 5, state, deps);
    clock = 6 * 60_000;
    expect(await stallTick(dir, await listBuilds(dir), 5, state, deps)).toEqual([a.id]);
    expect(told[0]).not.toContain("execution-time-allowance");
  });

  it("reads declared door logs and the configured minutes", () => {
    expect(declaredLogs("x\nlog: /tmp/a/mac-test-1.full.log\nsee /tmp/b.log.\n")).toEqual(["/tmp/a/mac-test-1.full.log", "/tmp/b.log"]);
    expect(stallMinutes({}, () => ({}))).toBe(5);
    expect(stallMinutes({}, () => ({ builds: { stallMinutes: 9 } }))).toBe(9);
    expect(stallMinutes({ PAI_BUILD_STALL_MINUTES: "2" }, () => ({}))).toBe(2);
  });
});
