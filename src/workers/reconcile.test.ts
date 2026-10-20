import { execFileSync } from "node:child_process";
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

describe("reconcileStatuses with a queued-then-started worker (real ownsPid)", () => {
  it("does not mark it lost when slot-acquired started is later than process start", () => {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
    const t = new Date(out.trim());
    const p = (n: number) => String(n).padStart(2, "0");
    const id = `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}-${process.pid}`;
    saveStatus(dir, { ...mk(id, process.pid), started: nowStamp(new Date(t.getTime() + 5 * 60_000)), updated: nowStamp(T0) }, T0);
    expect(reconcileStatuses(dir, new Date(T0.getTime() + 3_600_000), 120_000)).toEqual([]);
    expect(loadStatus(dir, id)?.state).toBe("running");
  });
});

describe("a worker served by a pool spare", () => {
  // the spare's claude started long before the claim stamped `started`
  const pooled = (id: string, pid: number, hostPid: number): WorkerStatus =>
    ({ ...mk(id, pid), started: "2020-01-01 00:00:00", pool: { spare: true, task: 1, slotSession: null, hostPid } }) as WorkerStatus;

  it("is running, not lost, while its pids are alive (reconcile and ps)", async () => {
    saveStatus(dir, pooled("p1", process.pid, process.ppid), T0);
    expect(reconcileStatuses(dir, new Date(T0.getTime() + 3_600_000), 0)).toEqual([]);
    expect(loadStatus(dir, "p1")?.state).toBe("running");
    const { psOutput } = await import("./viewer.js");
    const row = psOutput(dir, true, {}, false).split("\n").find((l) => l.includes("p1")) ?? "";
    expect(row).not.toContain("lost");
    expect(loadStatus(dir, "p1")?.state).toBe("running");
  });

  it("is lost when only the pool host is alive (the slot pid is dead)", () => {
    saveStatus(dir, pooled("p2", 999999, process.pid), T0);
    expect(reconcileStatuses(dir, new Date(T0.getTime() + 3_600_000), 0)).toEqual(["p2"]);
    expect(loadStatus(dir, "p2")?.state).toBe("lost");
  });

  it("is lost when its pid is alive but is not a child of the pool host", () => {
    saveStatus(dir, pooled("p4", process.pid, 999998), T0);
    expect(reconcileStatuses(dir, new Date(T0.getTime() + 3_600_000), 0)).toEqual(["p4"]);
  });

  it("is lost when every pid is dead", () => {
    saveStatus(dir, pooled("p3", 999999, 999998), T0);
    expect(reconcileStatuses(dir, new Date(T0.getTime() + 3_600_000), 0)).toEqual(["p3"]);
    expect(loadStatus(dir, "p3")?.state).toBe("lost");
  });
});
