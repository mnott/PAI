import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadStatus, markStartFailed, nowStamp, pidAlive, reconcileStatuses, saveStatus, type WorkerStatus } from "./status.js";
import { renderStatusLine } from "./render.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reconcile-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const T0 = new Date("2026-10-18T10:00:00");
const mk = (id: string, pid: number): WorkerStatus =>
  ({ id, pid, state: "running", started: nowStamp(T0), updated: nowStamp(T0), rc: null, turns: 0, tools: 0, cwd: "/x", label: id, last: "", provider: "p" }) as unknown as WorkerStatus;
const dead = () => false;
const live = () => true;

describe("reconcileStatuses", () => {
  it("keeps a dead-pid status within the grace, then marks it lost", () => {
    saveStatus(dir, mk("a", 999999), T0);
    expect(reconcileStatuses(dir, new Date(T0.getTime() + 60_000), 120_000, dead)).toEqual([]);
    expect(loadStatus(dir, "a")?.state).toBe("running");
    expect(reconcileStatuses(dir, new Date(T0.getTime() + 180_000), 120_000, dead)).toEqual(["a"]);
    const s = loadStatus(dir, "a")!;
    expect(s.state).toBe("lost");
    expect(s.rc).toBeNull();
    expect(s.last).toBe("process ended without a final status");
  });

  it("leaves a live worker running", () => {
    saveStatus(dir, mk("b", process.pid), T0);
    expect(reconcileStatuses(dir, new Date(T0.getTime() + 3_600_000), 120_000, live)).toEqual([]);
    expect(loadStatus(dir, "b")?.state).toBe("running");
  });

  it("status line does not count a dead-pid running worker", () => {
    const s = mk("c", 999999);
    expect(renderStatusLine([s], new Date(T0.getTime() + 1000))).not.toContain("▶");
  });
});

describe("pidAlive EPERM", () => {
  it("counts EPERM as alive only when asked", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("perm"), { code: "EPERM" });
    });
    expect(pidAlive(123)).toBe(false);
    expect(pidAlive(123, { epermAlive: true })).toBe(true);
  });
});

describe("dead pid is lost without waiting for the grace", () => {
  it("ps view and wait both report lost", async () => {
    const { waitWorkers } = await import("./wait.js");
    const { psOutput } = await import("./viewer.js");
    saveStatus(dir, { ...mk("g", 999999), updated: nowStamp(new Date()) });
    psOutput(dir, true, {}, false);
    expect(loadStatus(dir, "g")?.state).toBe("lost");
    saveStatus(dir, { ...mk("g", 999999), updated: nowStamp(new Date()) });
    const r = await waitWorkers(dir, ["g"], { timeoutMs: 500, intervalMs: 10, owns: dead });
    expect(r.timedOut).toEqual([]);
    expect(r.results[0].state).toBe("lost");
    expect(loadStatus(dir, "g")?.state).toBe("lost");
  });

  it("reconcile with grace 0 marks a fresh dead-pid status lost", () => {
    saveStatus(dir, mk("h", 999999), T0);
    expect(reconcileStatuses(dir, new Date(T0.getTime() + 1000), 0, dead)).toEqual(["h"]);
  });

  it("a failed start records failed and the reason", () => {
    const s = mk("i", process.pid);
    saveStatus(dir, s, T0);
    markStartFailed(dir, s, new Error("spawn claude ENOENT"));
    const got = loadStatus(dir, "i")!;
    expect(got.state).toBe("failed");
    expect(got.last).toContain("spawn claude ENOENT");
  });
});
