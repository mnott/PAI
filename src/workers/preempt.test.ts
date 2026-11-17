import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveStatus, loadStatus, type WorkerStatus } from "./status.js";
import { setWorkerPaused } from "./engine-control.js";
import { abortStuckPreemptions, makeUrgent, resumeOrphaned, resumePreempted, PREEMPT_ABORT_MS } from "./preempt.js";
import { capacityGate } from "./capacity.js";
import { inheritUrgency } from "./run/gate.js";
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

// 2026-11-17: three gyro-l workers sat "paused (preempted by …)" for 30 min while their preemptor stayed
// queued at position 2 of 8 — paused victims still counted against the cap for every other waiter, and the
// preemptor waited for a slot only their release would open. A preemption now frees slots for its own
// preemptor alone, and a watchdog gives them back (PREEMPT-ABORT) when it never takes them.
describe("a stuck preemption is aborted", () => {
  // the watchdog reads no config (its rule is "still queued past the window, victims still paused"), so these
  // tests never re-point PAI_CONFIG_FILE/PAI_WORKERS_YAML — a shared ~/.pai would be rewritten by them.
  const ledgerText = (dir: string): string => {
    try {
      return readdirSync(dir).filter((f) => f.includes("ledger")).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
    } catch {
      return "";
    }
  };

  it("the watchdog resumes the victims of a preemptor still queued past the window and logs PREEMPT-ABORT", () => {
    const { logDir, mk, live } = setup();
    const now = Date.now();
    // three running victims paused by N; N queued at the gate ever since it paused them (its ticket carries the wait start)
    mkdirSync(join(logDir, "queue", "local"), { recursive: true });
    saveStatus(logDir, mk("A", live(), { paused: true, pausedBy: "N", pausedAt: now - 70_000 }));
    saveStatus(logDir, mk("B", live(), { paused: true, pausedBy: "N", pausedAt: now - 70_000 }));
    saveStatus(logDir, mk("C", live(), { paused: true, pausedBy: "N", pausedAt: now - 70_000 }));
    saveStatus(logDir, mk("N", live(), { now: true, state: "queued" }));
    writeFileSync(join(logDir, "queue", "local", "N"), `${process.pid} front @${now - 70_000}`);
    expect(PREEMPT_ABORT_MS).toBe(60_000);
    expect(abortStuckPreemptions(logDir, now)).toEqual(["A", "B", "C"]);
    for (const id of ["A", "B", "C"]) {
      const s = loadStatus(logDir, id)!;
      expect(s.paused).toBeFalsy();
      expect(s.state).toBe("running"); // back in its own slot: the loan to N is revoked
      expect(s.pausedMs ?? 0).toBeGreaterThanOrEqual(69_000); // the pause time is closed, not lost
    }
    expect(loadStatus(logDir, "N")?.state).toBe("queued"); // N keeps its place at the gate's head
    expect(existsSync(join(logDir, "queue", "local", "N"))).toBe(true); // its ticket survives the abort
    expect(ledgerText(logDir)).toContain("PREEMPT-ABORT");
  });

  it("a preemptor queued under the window keeps its victims; after an abort a second pass does nothing", () => {
    const { logDir, mk, live } = setup();
    const now = Date.now();
    mkdirSync(join(logDir, "queue", "local"), { recursive: true });
    saveStatus(logDir, mk("A", live(), { paused: true, pausedBy: "N", pausedAt: now - 10_000 }));
    saveStatus(logDir, mk("N", live(), { now: true, state: "queued" }));
    writeFileSync(join(logDir, "queue", "local", "N"), `${process.pid} front @${now - 10_000}`);
    expect(abortStuckPreemptions(logDir, now)).toEqual([]);
    expect(loadStatus(logDir, "A")?.paused).toBe(true);
    // the same run past the window: aborted once, then a quiet pass (nothing paused left)
    expect(abortStuckPreemptions(logDir, now + 70_000)).toEqual(["A"]);
    expect(abortStuckPreemptions(logDir, now + 80_000)).toEqual([]);
    expect(loadStatus(logDir, "A")?.paused).toBeFalsy();
  });

  it("a preemptor that started is not stuck: its victims wait for its end (the normal resume path)", () => {
    const { logDir, mk, live } = setup();
    const now = Date.now();
    mkdirSync(join(logDir, "queue", "local"), { recursive: true });
    saveStatus(logDir, mk("A", live(), { paused: true, pausedBy: "N", pausedAt: now - 70_000 }));
    writeFileSync(join(logDir, "queue", "local", "N"), `${process.pid} front @${now - 70_000}`); // a stale ticket of a run that was admitted since
    saveStatus(logDir, mk("N", live(), { now: true, state: "running" })); // admitted at last: the pause stands until N ends
    expect(abortStuckPreemptions(logDir, now)).toEqual([]);
    expect(loadStatus(logDir, "A")?.paused).toBe(true);
    expect(resumePreempted(logDir, "N", now)).toEqual(["A"]); // N's end releases it into its own slot
  });

  it("an operator takeover survives the watchdog", () => {
    const { logDir, mk, live } = setup();
    const now = Date.now();
    mkdirSync(join(logDir, "queue", "local"), { recursive: true });
    saveStatus(logDir, mk("A", live(), { paused: true, pausedBy: "N", pausedAt: now - 70_000 }));
    setWorkerPaused(logDir, "A", true, "cli"); // the operator takes it over: pausedBy cleared, window closed
    const a = loadStatus(logDir, "A")!;
    expect(a.pausedBy).toBeUndefined();
    expect(a.pausedAt).toBeUndefined(); // no double count at resume
    expect(a.pausedMs ?? 0).toBeGreaterThanOrEqual(69_000);
    saveStatus(logDir, mk("N", live(), { now: true, state: "queued" }));
    writeFileSync(join(logDir, "queue", "local", "N"), `${process.pid} front @${now - 70_000}`);
    expect(abortStuckPreemptions(logDir, now)).toEqual([]);
    expect(loadStatus(logDir, "A")?.paused).toBe(true);
  });
});

describe("urgency and preemption never meet", () => {
  it("(a) a victim flagged now, its preemptor gone: the sweep resumes it, never handing it to itself", () => {
    const { logDir, mk, live } = setup();
    saveStatus(logDir, mk("P", live(), { now: true, state: "killed", rc: 143 }));
    saveStatus(logDir, mk("V", live()));
    setWorkerPaused(logDir, "V", true, "preempt", "P");
    const s = loadStatus(logDir, "V")!;
    s.now = true;
    saveStatus(logDir, s, new Date(), true);
    resumeOrphaned(logDir);
    const v = loadStatus(logDir, "V")!;
    expect(v.paused).toBeFalsy();
    expect(v.pausedBy).not.toBe("V");
  });
  it("(b) makeUrgent on a preempted worker resumes it", () => {
    const { logDir, mk, live } = setup();
    saveStatus(logDir, mk("P", live(), { now: true }));
    saveStatus(logDir, mk("V", live()));
    setWorkerPaused(logDir, "V", true, "preempt", "P");
    makeUrgent(logDir, "V", true);
    const v = loadStatus(logDir, "V")!;
    expect(v.paused).toBeFalsy();
    expect(v.now).toBe(true);
  });
  it("(c) an operator-paused worker made now stays paused", () => {
    const { logDir, mk, live } = setup();
    saveStatus(logDir, mk("V", live()));
    setWorkerPaused(logDir, "V", true, "cli");
    makeUrgent(logDir, "V", true);
    expect(loadStatus(logDir, "V")!.paused).toBe(true);
  });
  it("a child of an urgent run inherits urgency and is admitted into a slot a paused victim lent", async () => {
    const { logDir, mk, live } = setup();
    saveStatus(logDir, mk("PAR", live(), { now: true }));
    saveStatus(logDir, mk("VIC", live()));
    setWorkerPaused(logDir, "VIC", true, "preempt", "PAR");
    const child = mk("CHILD", live(), { state: "queued" });
    saveStatus(logDir, child);
    expect(inheritUrgency(logDir, "CHILD", child, { PAI_WORKER_ID: "PAR" })).toBe(true);
    const r = await Promise.race([
      capacityGate({ logDir, self: { id: "CHILD", provider: "local" }, cap: 2, config: {}, urgent: () => loadStatus(logDir, "CHILD")?.now === true, sleep: () => new Promise((x) => setTimeout(x, 5)) }).then(() => "admitted"),
      new Promise((x) => setTimeout(() => x("stuck"), 1500)),
    ]);
    expect(r).toBe("admitted");
    expect(inheritUrgency(logDir, "C2", mk("C2", live()), { PAI_WORKER_ID: "VIC" })).toBe(false);
  });
});
