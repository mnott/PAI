import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestLoopStop, takeLoopStop, loopStopMarkerPath } from "./loop-stop.js";
import { decideEndReason } from "./endreason.js";
import { saveStatus, loadStatus, type WorkerStatus } from "./status.js";

const st = (id: string): WorkerStatus =>
  ({ id, pid: process.pid, label: "l", cwd: "/", term: "", provider: "p", model: "m", state: "running", started: "", updated: "", turns: 0, tools: 0, last: "", rc: null, secs: null }) as WorkerStatus;

describe("loop stop", () => {
  it("marks the worker, notes the status and signals the claude pid via the injected kill", () => {
    const dir = mkdtempSync(join(tmpdir(), "loopstop-"));
    try {
      saveStatus(dir, st("w1"));
      const killed: Array<[number, string]> = [];
      requestLoopStop(dir, "w1", "Bash x repeated 7 times", { kill: (p, s) => killed.push([p, s]), claudePid: () => 4242 });
      expect(killed).toEqual([[4242, "SIGTERM"]]);
      expect(loadStatus(dir, "w1")?.last).toMatch(/^loop-stopped: Bash x/);
      expect(existsSync(loopStopMarkerPath(dir, "w1"))).toBe(true);
      expect(takeLoopStop(dir, "w1")?.reason).toMatch(/repeated 7 times/);
      expect(takeLoopStop(dir, "w1")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("a failing kill never throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "loopstop-"));
    try {
      expect(() => requestLoopStop(dir, "w2", "r", { kill: () => { throw new Error("ESRCH"); }, claudePid: () => 1234 })).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("end reason is loop-stopped", () => {
    expect(decideEndReason({ logDir: "/nonexistent", id: "w", loopStopped: true }).reason).toBe("loop-stopped");
  });
});
