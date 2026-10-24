import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCockpitJob, writeCockpitJob, type LocalJobState } from "./cockpit-actions.js";
import { cockpitJobRunning, interruptStaleJobs } from "./cockpit-job-recovery.js";
import { createDistWatch, DIST_STABLE_MS } from "../daemon/dist-watch.js";

let home: string;
beforeEach(() => void (home = mkdtempSync(join(tmpdir(), "cockpit-jobs-"))));
afterEach(() => rmSync(home, { recursive: true, force: true }));

const job = (id: string, over: Partial<LocalJobState> = {}): LocalJobState => ({
  id, kind: "memory", tier: "", what: "index", state: "running", message: "index now", at: "2026-10-24T17:31:00.000Z", startedAt: "2026-10-24T17:31:00.000Z", ...over,
});
const DAEMON_START = Date.parse("2026-10-24T17:34:00Z");

describe("cockpit job recovery", () => {
  it("stamps the runner pid on a running job", () => {
    writeCockpitJob(home, job("a1"));
    expect(readCockpitJob(home, "a1")!.pid).toBe(process.pid);
    writeCockpitJob(home, job("a2", { state: "done" }));
    expect(readCockpitJob(home, "a2")!.pid).toBeUndefined();
  });

  it("a stale running job becomes interrupted on startup; the live process's job and finished jobs are untouched", () => {
    writeCockpitJob(home, job("dead", { pid: 111 }));
    writeCockpitJob(home, job("nopid"));
    writeCockpitJob(home, job("live", { pid: 222 }));
    writeCockpitJob(home, job("fin", { state: "done", message: "ok" }));
    const alive = (pid: number) => pid === 222;
    const live = readCockpitJob(home, "live")!;
    expect(interruptStaleJobs(home, DAEMON_START, alive).sort()).toEqual(["dead", "nopid"]);
    expect(readCockpitJob(home, "dead")).toMatchObject({ state: "interrupted", message: "interrupted: the daemon restarted at 17:34:00Z — run it again" });
    expect(readCockpitJob(home, "nopid")!.state).toBe("interrupted");
    expect(readCockpitJob(home, "live")).toEqual(live);
    expect(readCockpitJob(home, "fin")).toMatchObject({ state: "done", message: "ok" });
  });

  it("the runner start time is passed so a reused pid counts as gone", () => {
    writeCockpitJob(home, job("r", { pid: 5 }));
    const seen: number[] = [];
    interruptStaleJobs(home, DAEMON_START, (_p, s) => (seen.push(s), true));
    expect(seen).toEqual([Date.parse("2026-10-24T17:31:00.000Z")]);
  });

  it("busy is true while a cockpit job runs in a live process, and lets the self-restart wait", () => {
    const state = { alive: true, t: 0, id: "1" };
    let started = false;
    writeCockpitJob(home, job("b", { pid: 333 }));
    const busy = () => cockpitJobRunning(home, () => state.alive);
    const tick = createDistWatch({ readId: () => state.id, now: () => state.t, busy, restart: () => void (started = true), log: () => {} }, "0");
    tick();
    state.t += DIST_STABLE_MS;
    expect(tick()).toBe("waiting-pass");
    expect(started).toBe(false);
    writeCockpitJob(home, job("b", { pid: 333, state: "done" }));
    expect(busy()).toBe(false);
    expect(tick()).toBe("restarting");
    expect(started).toBe(true);
  });

  it("a running job whose runner is gone is not busy", () => {
    writeCockpitJob(home, job("c", { pid: 444 }));
    expect(cockpitJobRunning(home, () => false)).toBe(false);
  });
});
