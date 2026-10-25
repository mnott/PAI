import { describe, expect, it, vi } from "vitest";
import { timedTask, runningTasks } from "./slow-task.js";
import { startDaemonStallMonitor } from "./stall.js";

describe("timedTask", () => {
  it("logs ISO-stamped sync and total for a slow synchronous task", () => {
    const lines: string[] = [];
    let t = 0;
    expect(timedTask("x", () => 7, 50, (l) => lines.push(l), () => (t += 80))).toBe(7);
    expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z \[pai-daemon\] SLOW-TASK x sync=80 total=160\n$/);
  });
  it("does not log a task slow only because it awaited, until total passes 60 s", async () => {
    const lines: string[] = [];
    let t = 0;
    const clock = () => t;
    await timedTask("waits", async () => { await Promise.resolve(); t += 5000; }, 50, (l) => lines.push(l), clock);
    expect(lines).toEqual([]);
    await timedTask("waits-long", async () => { await Promise.resolve(); t += 61_000; }, 50, (l) => lines.push(l), clock);
    expect(lines[0]).toMatch(/SLOW-TASK waits-long sync=0 total=61000/);
  });
  it("stays quiet within budget and still logs when the task throws", () => {
    const lines: string[] = [];
    let t = 0;
    timedTask("fast", () => 1, 50, (l) => lines.push(l), () => (t += 10));
    expect(lines).toEqual([]);
    expect(() => timedTask("boom", () => { throw new Error("e"); }, 50, (l) => lines.push(l), () => (t += 100))).toThrow("e");
    expect(lines[0]).toMatch(/SLOW-TASK boom sync=/);
  });
  it("keeps running task names until they settle", async () => {
    let release!: () => void;
    const p = timedTask("pending", () => new Promise<void>((r) => (release = r)));
    expect(runningTasks()).toContain("pending");
    release();
    await p;
    expect(runningTasks()).not.toContain("pending");
  });
});

describe("daemon stall monitor", () => {
  it("names the running task on the stall line", async () => {
    vi.useFakeTimers();
    try {
      let clock = 0;
      const lines: string[] = [];
      let release!: () => void;
      const p = timedTask("pane-audit", () => new Promise<void>((r) => (release = r)));
      const m = startDaemonStallMonitor({ log: (l) => lines.push(l), tickMs: 100, now: () => clock });
      clock += 100;
      vi.advanceTimersByTime(100);
      expect(lines).toEqual([]);
      clock += 100 + 900; // the loop was blocked 900 ms
      vi.advanceTimersByTime(100);
      m.stop();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/event-loop stall 9\d\d ms.*running tasks: pane-audit/);
      release();
      await p;
    } finally {
      vi.useRealTimers();
    }
  });
});
