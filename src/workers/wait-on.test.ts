import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitOn, statusMarker, type WaitOnDeps } from "./wait-on.js";
import { loadStatus, saveStatus, type WorkerStatus } from "./status.js";
import type { WaitingOn } from "./waiting.js";

/** Fake clock: sleep advances time; the process is alive until `diesAt` ms. */
function fake(o: { diesAt?: number; initial?: "alive" | "gone" | "foreign"; start?: number }) {
  let t = 1_000_000;
  const out: string[] = [];
  let first = true;
  const deps: WaitOnDeps = {
    probe: () => {
      if (first) {
        first = false;
        return o.initial ?? "alive";
      }
      return o.diesAt !== undefined && t >= 1_000_000 + o.diesAt ? "gone" : "alive";
    },
    startTime: () => o.start ?? 1_000_000 - 5000,
    now: () => t,
    sleep: async (ms) => void (t += ms),
    out: (l) => out.push(l),
  };
  return { deps, out };
}
const dir = mkdtempSync(join(tmpdir(), "waiton-"));

describe("waitOn", () => {
  it("returns 0 when the pid exits, with rc and log tail", async () => {
    const log = join(dir, "a.log");
    writeFileSync(log, "l1\nl2\nl3\n");
    writeFileSync(join(dir, "a.rc"), "7\n");
    const f = fake({ diesAt: 5000 });
    expect(await waitOn({ pid: 42, log, tail: 2 }, f.deps)).toBe(0);
    expect(f.out).toEqual(["pid 42 gone, exit code 7", "l2", "l3"]);
  });

  it("returns 3 at --max and caps at 590 s", async () => {
    const f = fake({});
    expect(await waitOn({ pid: 42, maxSecs: 1000 }, f.deps)).toBe(3);
    expect(f.out.at(-1)).toMatch(/still running after 59[01]s/);
  });

  it("prints a heartbeat about every 20 s", async () => {
    const log = join(dir, "h.log");
    writeFileSync(log, "x\n");
    const f = fake({ diesAt: 45_000 });
    await waitOn({ pid: 42, log, tail: 0 }, f.deps);
    expect(f.out.filter((l) => l.startsWith("running "))).toHaveLength(2);
    expect(f.out[0]).toBe("running 20s, log +0 lines");
  });

  it("returns 2 for a pid that never existed, a foreign pid and an invalid pid", async () => {
    expect(await waitOn({ pid: 42 }, fake({ initial: "gone" }).deps)).toBe(2);
    expect(await waitOn({ pid: 1 }, fake({ initial: "foreign" }).deps)).toBe(2);
    expect(await waitOn({ pid: -3 }, fake({}).deps)).toBe(2);
  });

  it("returns 0 for a pid already gone when its log exists", async () => {
    const log = join(dir, "done.log");
    writeFileSync(log, "ok\n");
    expect(await waitOn({ pid: 42, log }, fake({ initial: "gone" }).deps)).toBe(0);
  });

  it("treats a later process start time (pid reuse) as gone", async () => {
    const f = fake({ start: 1_000_000 + 10_000 });
    expect(await waitOn({ pid: 42, tail: 0 }, f.deps)).toBe(0);
    expect(f.out[0]).toBe("pid 42 gone");
  });
  it("records waitingOn while waiting and clears it on return, on both exits", async () => {
    const marks: (WaitingOn | null)[] = [];
    const proc = () => ({ cmd: "sleep 120", startedAt: 1_000_000 - 252_000 });
    const a = fake({ diesAt: 5000 });
    expect(await waitOn({ pid: 42, log: "/tmp/x.log", tail: 0 }, { ...a.deps, proc, mark: (w) => marks.push(w) })).toBe(0);
    expect(marks).toEqual([{ pid: 42, cmd: "sleep 120", startedAt: 1_000_000 - 252_000, log: "/tmp/x.log" }, null]);
    expect(a.out[0]).toBe("pid 42 gone after 4m18s");
    marks.length = 0;
    expect(await waitOn({ pid: 42, maxSecs: 1, tail: 0 }, { ...fake({}).deps, proc, mark: (w) => marks.push(w) })).toBe(3);
    expect(marks.at(-1)).toBeNull();
    expect(marks).toHaveLength(2);
  });

  it("statusMarker writes and clears waitingOn in the worker's status file", () => {
    const logDir = mkdtempSync(join(tmpdir(), "waiton-st-"));
    const st = { id: "w9", pid: 1, label: "l", cwd: "/", term: "", provider: "p", model: "m", state: "running", started: "", updated: "", turns: 0, tools: 0, last: "", rc: null, secs: null } as WorkerStatus;
    saveStatus(logDir, st);
    const mark = statusMarker(logDir, "w9");
    const w = { pid: 5, cmd: "sleep 9", startedAt: null, log: null };
    mark(w);
    expect(loadStatus(logDir, "w9")?.waitingOn).toEqual(w);
    // the runner's own periodic write (no waitingOn in memory) keeps it
    saveStatus(logDir, { ...st, turns: 1 });
    expect(loadStatus(logDir, "w9")?.waitingOn).toEqual(w);
    mark(null);
    expect(loadStatus(logDir, "w9")?.waitingOn).toBeNull();
    expect(() => statusMarker(logDir, "nope")(w)).not.toThrow();
  });
});
