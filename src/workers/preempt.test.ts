import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveStatus, loadStatus, type WorkerStatus } from "./status.js";
import { setWorkerPaused } from "./engine-control.js";
import { resumeOrphaned, resumePreempted } from "./preempt.js";
import { waitWhilePreempted } from "../hooks/ts/lib/worker-guard.js";

const dirs: string[] = [];
const kids: { kill: () => boolean }[] = [];
afterEach(() => {
  for (const k of kids.splice(0)) k.kill();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const logDir = mkdtempSync(join(tmpdir(), "preempt-"));
  dirs.push(logDir);
  mkdirSync(logDir, { recursive: true });
  const now = new Date().toISOString();
  const mk = (id: string, pid: number, extra: Partial<WorkerStatus> = {}): WorkerStatus =>
    ({ id, pid, runPid: pid, label: id, cwd: "/tmp", term: "", provider: "local", model: "m", state: "running", started: now, updated: now, turns: 0, tools: 0, last: "", rc: null, secs: null, ...extra }) as WorkerStatus;
  const live = () => {
    const c = spawn("sleep", ["60"], { stdio: "ignore" });
    kids.push(c);
    return c.pid!;
  };
  return { logDir, mk, live };
}

describe("a preemption pause ends when the preemptor ends", () => {
  it("resumePreempted (finalise / kill path) releases whatever the exit code", () => {
    const { logDir, mk, live } = setup();
    saveStatus(logDir, mk("A", live()));
    saveStatus(logDir, mk("B", live(), { now: true, state: "killed", rc: 143 }));
    setWorkerPaused(logDir, "A", true, "preempt", "B");
    expect(resumePreempted(logDir, "B")).toEqual(["A"]);
    expect(loadStatus(logDir, "A")?.paused).toBeFalsy();
  });

  it("the sweep releases a pause whose preemptor died without a final status", () => {
    const { logDir, mk, live } = setup();
    saveStatus(logDir, mk("A", live()));
    saveStatus(logDir, mk("B", 2147483646, { now: true })); // running, pid gone
    setWorkerPaused(logDir, "A", true, "preempt", "B");
    expect(resumeOrphaned(logDir)).toEqual(["A"]);
    expect(loadStatus(logDir, "A")?.paused).toBeFalsy();
  });

  it("the sweep leaves a pause alone while the preemptor lives, and an operator pause always", () => {
    const { logDir, mk, live } = setup();
    saveStatus(logDir, mk("A", live()));
    saveStatus(logDir, mk("C", live()));
    saveStatus(logDir, mk("B", live(), { now: true }));
    setWorkerPaused(logDir, "A", true, "preempt", "B");
    setWorkerPaused(logDir, "C", true, "cli");
    expect(resumeOrphaned(logDir)).toEqual([]);
    expect(loadStatus(logDir, "C")?.paused).toBe(true);
  });

  it("the guard waits in the gate while paused and does not wait once released", () => {
    const { logDir, mk, live } = setup();
    saveStatus(logDir, mk("A", live()));
    saveStatus(logDir, mk("B", live(), { now: true }));
    setWorkerPaused(logDir, "A", true, "preempt", "B");
    const t0 = Date.now();
    expect(waitWhilePreempted(logDir, "A", 600, 50)).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(550);
    setWorkerPaused(logDir, "A", false, "cli");
    expect(waitWhilePreempted(logDir, "A", 600, 50)).toBe(false);
  });
});
