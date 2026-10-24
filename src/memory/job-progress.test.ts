import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProgressWriter } from "./job-progress.js";
import { stalledSeconds } from "../router/cockpit-memory.js";
import { writeCockpitJob, readCockpitJob } from "../router/cockpit-actions.js";

let home: string;
const rec = (state = "running") => ({ id: "job1", kind: "memory" as const, tier: "", what: "index" as const, state: state as "running", message: "index now", at: "2026-10-24T20:00:00.000Z" });
const read = () => JSON.parse(readFileSync(`${home}/cockpit-jobs/job1.json`, "utf8"));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pai-jobprog-"));
  mkdirSync(`${home}/cockpit-jobs`);
  writeCockpitJob(home, rec());
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("progress writer", () => {
  it("throttles to one write per gap, first call always writes, keeps the record's other fields", () => {
    let t = 1_000_000;
    const w = createProgressWriter("job1", { home, now: () => t });
    w.update({ phase: "index", total: 254, done: 1, files: 3 });
    expect(read().progress.done).toBe(1);
    expect(read().message).toBe("index now");
    expect(read().pid).toBe(process.pid);
    t += 1000;
    w.update({ done: 2 });
    expect(read().progress.done).toBe(1);
    t += 2500;
    w.update({ done: 3, current: "proj" });
    expect(read().progress).toMatchObject({ done: 3, total: 254, current: "proj", elapsedSec: 4, phase: "index" });
  });

  it("writes atomically: no temp file is left and the file is always whole JSON", () => {
    const w = createProgressWriter("job1", { home, now: () => 0, minGapMs: 0 });
    for (let i = 0; i < 20; i++) w.update({ done: i });
    expect(readdirSync(`${home}/cockpit-jobs`)).toEqual(["job1.json"]);
    expect(read().progress.done).toBe(19);
  });

  it("movedAt follows the counters only", () => {
    let t = 0;
    const w = createProgressWriter("job1", { home, now: () => t, minGapMs: 0 });
    w.update({ done: 1 });
    const first = read().progress.movedAt;
    t += 90_000;
    w.update({ done: 1 });
    expect(read().progress.movedAt).toBe(first);
    t += 1000;
    w.update({ done: 2 });
    expect(read().progress.movedAt).not.toBe(first);
  });

  it("the final write replaces progress, and a finished record is not resurrected", () => {
    const w = createProgressWriter("job1", { home, now: () => 0, minGapMs: 0 });
    w.update({ done: 5 });
    writeCockpitJob(home, { ...rec("running"), state: "done", message: "Done." });
    expect(readCockpitJob(home, "job1")?.progress).toBeUndefined();
    w.update({ done: 6 });
    expect(readCockpitJob(home, "job1")?.progress).toBeUndefined();
  });

  it("stall: only past 60 s without a counter change", () => {
    const p = { movedAt: new Date(0).toISOString() } as any;
    expect(stalledSeconds(p, 60_000)).toBeNull();
    expect(stalledSeconds(p, 95_000)).toBe(95);
    expect(stalledSeconds(undefined, 95_000)).toBeNull();
  });
});
