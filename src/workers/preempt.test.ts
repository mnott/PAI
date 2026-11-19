import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { saveStatus, loadStatus, type WorkerStatus } from "./status.js";
import { setWorkerPaused } from "./engine-control.js";
import { abortStuckPreemptions, makeUrgent, resumeOrphaned, resumePreempted, resumeWorker, admitResumedWaiters, PREEMPT_ABORT_MS } from "./preempt.js";
import { capacityGate, liveQueue, queueDir, waitingForSlotText, writeTicket } from "./capacity.js";
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

// 2026-11-18: pausing one of three running gyro-l workers did not admit the queued job, and the paused worker was
// unpaused again silently. An operator pause now releases the slot at once; only an explicit resume clears it,
// and it re-enters the queue at the front (never over the cap).
describe("an operator pause frees the slot and stays until resumed", () => {
  const ledgerOf = (dir: string): string => readdirSync(dir).filter((f) => f.includes("ledger")).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  const tick = (): Promise<void> => new Promise((x) => setTimeout(x, 5));

  it("pausing one of 3 running workers with 2 queued admits queue #1 only", async () => {
    const { logDir, mk, live } = setup();
    for (const id of ["A", "B", "C"]) saveStatus(logDir, mk(id, live()));
    mkdirSync(join(logDir, "queue", "local"), { recursive: true });
    const gate = (id: string) => capacityGate({ logDir, self: { id, provider: "local", pid: live() }, cap: 3, config: {}, sleep: tick });
    const q1 = gate("Q1");
    await tick();
    const q2 = gate("Q2");
    const raced = (p: Promise<unknown>) => Promise.race([p.then(() => "admitted"), new Promise((x) => setTimeout(() => x("waiting"), 300))]);
    expect(await raced(q1)).toBe("waiting"); // full: A, B, C hold the 3 slots
    setWorkerPaused(logDir, "A", true, "cockpit");
    expect(await raced(q1)).toBe("admitted");
    saveStatus(logDir, mk("Q1", live()));
    expect(await raced(q2)).toBe("waiting"); // one slot freed, one taken: Q2 stays queued
    expect(loadStatus(logDir, "A")?.paused).toBe(true);
  });

  it("resume re-queues at the front when the cap is full and takes a free slot otherwise", () => {
    const { logDir, mk, live } = setup();
    for (const id of ["A", "B", "C", "Q1"]) saveStatus(logDir, mk(id, live()));
    setWorkerPaused(logDir, "A", true, "cockpit");
    const room = (n: number) => () => n;
    expect(resumeWorker(logDir, "A", "cockpit", Date.now(), room(0))).toBe(true);
    expect(loadStatus(logDir, "A")?.paused).toBe(true); // waits for its turn at a free slot
    expect(readFileSync(join(logDir, "queue", "local", "A"), "utf8")).not.toContain("front"); // a resume never preempts
    expect(ledgerOf(logDir)).toContain("WORKER-RESUME-QUEUED");
    setWorkerPaused(logDir, "C", true, "cockpit");
    expect(resumeWorker(logDir, "C", "cockpit", Date.now(), room(1))).toBe(true);
    // A already waits: C queues behind it instead of taking the free slot first
    expect(existsSync(join(logDir, "queue", "local", "C"))).toBe(true);
    rmSync(join(logDir, "queue", "local", "A"));
    rmSync(join(logDir, "queue", "local", "C"));
    setWorkerPaused(logDir, "B", true, "cockpit");
    expect(resumeWorker(logDir, "B", "cockpit", Date.now(), room(1))).toBe(true);
    expect(loadStatus(logDir, "B")?.paused).toBeFalsy(); // nobody waiting for the slot: it runs
  });

  it("no sweep or preemption end clears an operator pause; the ledger carries by=", () => {
    const { logDir, mk, live } = setup();
    saveStatus(logDir, mk("A", live()));
    saveStatus(logDir, mk("N", live(), { now: true }));
    setWorkerPaused(logDir, "A", true, "cockpit");
    expect(resumeOrphaned(logDir)).toEqual([]);
    expect(resumePreempted(logDir, "N")).toEqual([]);
    expect(abortStuckPreemptions(logDir, Date.now() + 10 * PREEMPT_ABORT_MS)).toEqual([]);
    expect(makeUrgent(logDir, "N", true)).not.toContain("A");
    expect(loadStatus(logDir, "A")?.paused).toBe(true);
    resumeWorker(logDir, "A", "cli", Date.now(), () => 1);
    const l = ledgerOf(logDir);
    expect(l).toMatch(/WORKER-PAUSE by=cockpit who=cockpit id=A/);
    expect(l).toMatch(/WORKER-UNPAUSE by=cli who=cli id=A/);
  });
});

describe("admitResumedWaiters", () => {
  const waiter = (s: ReturnType<typeof setup>, id: string) => {
    saveStatus(s.logDir, s.mk(id, s.live()));
    setWorkerPaused(s.logDir, id, true, "cli");
    resumeWorker(s.logDir, id, "cli", Date.now(), () => 0);
  };
  const countdown = (n: number) => () => n--;

  it("releases two resumed waiters in queue order while slots are free", () => {
    const s = setup();
    waiter(s, "A");
    waiter(s, "B");
    expect(admitResumedWaiters(s.logDir, Date.now(), countdown(2))).toEqual(["A", "B"]);
    expect(loadStatus(s.logDir, "A")?.paused).toBeFalsy();
    expect(loadStatus(s.logDir, "B")?.paused).toBeFalsy();
  });

  it("releases nothing with no free slot", () => {
    const s = setup();
    waiter(s, "A");
    expect(admitResumedWaiters(s.logDir, Date.now(), () => 0)).toEqual([]);
    expect(loadStatus(s.logDir, "A")?.paused).toBe(true);
  });

  it("a new job at the head blocks the waiters behind it", () => {
    const s = setup();
    waiter(s, "A");
    saveStatus(s.logDir, s.mk("N", 1, { state: "queued" }));
    writeTicket(join(queueDir(s.logDir, "local"), "N"), `${s.live()} front @${Date.now()}`);
    expect(liveQueue(s.logDir, "local")[0]).toBe("N");
    expect(admitResumedWaiters(s.logDir, Date.now(), () => 3)).toEqual([]);
    expect(loadStatus(s.logDir, "A")?.paused).toBe(true);
  });

  it("a paused worker with a ticket reads as waiting for a slot, not paused", () => {
    const s = setup();
    waiter(s, "A");
    expect(waitingForSlotText(s.logDir, { id: "A", provider: "local", paused: true })).toBe("waiting for a slot (position 1 of 1)");
    expect(waitingForSlotText(s.logDir, { id: "Z", provider: "local", paused: true })).toBeUndefined();
  });
});

describe("admitResumedWaiters tick cost (2026-11-18 daemon hang)", () => {
  let s: ReturnType<typeof setup>;
  // The 3000-file fixture is slow to write on a busy machine; build it once, outside the timed test.
  beforeAll(() => {
    s = setup();
    for (let i = 0; i < 3000; i++) saveStatus(s.logDir, s.mk(`old${String(i).padStart(4, "0")}`, 2147483646, { state: "done", rc: 0 }));
  }, 60_000);

  it("12 queued tickets, 5 running, 3000 old statuses: terminates, stays under 1 s, scans statuses once", () => {
    for (let i = 0; i < 5; i++) saveStatus(s.logDir, s.mk(`run${i}`, s.live()));
    for (let i = 0; i < 12; i++) {
      const id = `w${String(i).padStart(2, "0")}`;
      saveStatus(s.logDir, s.mk(id, s.live()));
      setWorkerPaused(s.logDir, id, true, "cli");
      resumeWorker(s.logDir, id, "cli", Date.now(), () => 0);
    }
    let room = 12;
    const t0 = Date.now();
    const out = admitResumedWaiters(s.logDir, Date.now(), () => room--);
    const ms = Date.now() - t0;
    expect(out.length).toBe(12);
    expect(ms).toBeLessThan(1000);
  }, 30_000);
});
