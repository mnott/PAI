import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointRegistry, instanceEngineKey, pickInstance, type LocalInstance } from "./local-instances.js";
import { capacityGate, currentBuildId, providerCap, instanceUp, instanceCachedUp, resetInstanceHealth, fairOrder, isStaleBuild, liveQueue, moveUp, queueRows, reorderQueue, reorderQueueTo, writeTicket, type QueueEntry, type QueueRow } from "./capacity.js";
import { setWorkerPaused } from "./engine-control.js";
import { finishDeferredMoves, rerouteWorker } from "./reroute.js";
import { requeueStaleWaiters } from "./stale-requeue.js";
import { localIdleLine } from "./local-idle.js";
import { filterBySession, sortBySession, buildQueueTable, plainWording, readTaskText, renderQueueTable, stateBadge, taskSummary, type TableInput } from "./queue-table.js";
import type { SchedSnapshot } from "../router/scheduler.js";
import { runGlobalDeep, runRowAction, runSessionAction } from "./queue-ops.js";
import type { WorkersConfig } from "./config.js";
import { admitResumedWaiters, applyPriority, resumeWorker } from "./preempt.js";
import { holdsSlot, loadStatus, saveStatus, type WorkerStatus } from "./status.js";
import { schedulerView } from "./scheduler.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "prio-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const st = (id: string): WorkerStatus =>
  ({ id, pid: process.pid, label: "l", cwd: "/", term: "", provider: "fakeA", model: "m", state: "queued", started: "", updated: "", turns: 0, tools: 0, last: "", rc: null, secs: null, promptFile: "/x" }) as WorkerStatus;

describe("queue priority persistence", () => {
  it("a level set on a queued run survives a ticket rewritten from the start options (daemon restart)", () => {
    saveStatus(dir, st("w1"));
    mkdirSync(join(dir, "queue", "fakeA"), { recursive: true });
    const ticket = join(dir, "queue", "fakeA", "w1");
    writeTicket(ticket, `${process.pid} @1`);
    applyPriority(dir, "w1", "high");
    expect(loadStatus(dir, "w1")!.priority).toBe("high");
    // a restart rebuilds the ticket as normal: the status file still decides
    writeTicket(ticket, `${process.pid} @1`);
    const row = queueRows(dir, {}, () => true).find((r) => r.id === "w1")!;
    expect(row.priority).toBe("high");
  });
});

// ---- one worker queue table (queue-table.ts / queue-ops.ts) ----
const QNOW = Date.parse("2026-11-18T12:00:00");
const qst = (id: string, o: Partial<WorkerStatus> = {}): WorkerStatus =>
  ({ id, label: `task ${id}`, provider: "lm", model: "qwen", state: "running", started: "2026-11-18 11:50:00", updated: "2026-11-18 11:59:55", cwd: "/x", pid: 1, ...o }) as WorkerStatus;
const qrow = (s: WorkerStatus, provider: string, position: number): QueueRow => ({ id: s.id, provider, position, queued: 3, status: s });
const qin = (statuses: WorkerStatus[], queue: QueueRow[] = [], more: Partial<TableInput> = {}): TableInput => ({
  statuses,
  queue,
  panes: [],
  now: QNOW,
  isLocal: (p) => p === "lm",
  sessionOf: (s) => (s.session?.name as string | undefined) ?? "other",
  ...more,
});

describe("queue table", () => {
  it("is one table in admission order: running first, then waiting 1..n", () => {
    const run1 = qst("a1", { started: "2026-11-18 11:40:00" });
    const run2 = qst("a2", { started: "2026-11-18 11:30:00", provider: "anthropic" });
    const w1 = qst("w1", { state: "queued" });
    const w2 = qst("w2", { state: "queued", provider: "anthropic", started: "2026-11-18 11:55:00" });
    const w3 = qst("w3", { state: "queued" });
    const rows = buildQueueTable(qin([run1, run2, w1, w2, w3], [qrow(w1, "lm", 1), qrow(w3, "lm", 2), qrow(w2, "anthropic", 1)]));
    expect(rows.map((r) => `${r.slot}:${r.id}`)).toEqual(["running:a2", "running:a1", "1:w1", "2:w2", "3:w3"]);
  });

  it("shows the session, model (local/cloud) and plain state wording", () => {
    const a = qst("a", { session: { name: "mdf" } as WorkerStatus["session"] });
    const p = qst("p", { state: "queued", paused: true, provider: "anthropic", model: "opus" });
    const rows = buildQueueTable(qin([a, p], [qrow(p, "anthropic", 1)]));
    expect(rows[0]).toMatchObject({ session: "mdf", model: expect.any(String), modelFull: "local: qwen", stateText: "running" });
    expect(rows[1]).toMatchObject({ state: "paused", model: "cloud: opus", modelFull: "cloud: anthropic opus", session: "other", stateText: "paused (slot freed)" });
  });

  it("a resumed worker waiting for a slot (paused + ticket) reads as waiting for a slot, not paused", () => {
    const p = qst("p", { paused: true });
    const rows = buildQueueTable(qin([p], [qrow(p, "lm", 1)]));
    expect(rows[0]).toMatchObject({ state: "waiting", stateText: "waiting for a slot (resumed)" });
    expect(stateBadge(rows[0]!)).toBe("waiting for a slot (position 1 of 3)");
  });

  it("marks frozen and deep-frozen rows and offers the matching action", () => {
    const rows = buildQueueTable(qin([qst("f"), qst("d")], [], { frozen: (id) => id === "f", deepFrozen: (id) => id === "d" }));
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by.f!.state).toBe("frozen");
    expect(by.f!.actions).toContain("thaw");
    expect(by.d!.state).toBe("deep-frozen");
    expect(by.d!.actions).toContain("deep-resume");
  });

  it("a moved job is ONE row: the continuation, with 'continues <old id>'", () => {
    const old = qst("old", { rerouted: "anthropic: cli" });
    const cont = qst("new", { provider: "anthropic", fallThroughOf: "old", route: { policy: "auto", reason: "rerouted (escalation: no edit or commit for 10m)", local: false } as WorkerStatus["route"] });
    const rows = buildQueueTable(qin([old, cont]));
    expect(rows.map((r) => r.id)).toEqual(["new"]);
    expect(rows[0]!.detail).toBe("continues job old; moved to cloud: no progress for 10 min");
  });

  it("a pane run is never a row (model jobs only); one that waits on a job shows as an eye on that job's row", () => {
    const rows = buildQueueTable(qin([], [], { panes: [{ id: "pane-1", label: "npm run build", state: "running", startedMs: QNOW - 65_000, session: "pai" }] }));
    expect(rows).toHaveLength(0);
    const a = qst("w-20261118-120000-55574");
    const rows2 = buildQueueTable(qin([a], [], { panes: [{ id: "pane-1", label: "wait: right pane fix (local)", state: "running", startedMs: QNOW - 65_000, session: "pai", command: "pai worker wait w-20261118-120000-55574 --max 590" }] }));
    expect(rows2.map((r) => r.id)).toEqual(["w-20261118-120000-55574"]); // the job it waits for still shows once
    expect(rows2[0]!.waits).toEqual([{ id: "pane-1", label: "wait: right pane fix (local)" }]);
    // a waiter of a job that is gone, and a plain command, attach to nothing
    const rows3 = buildQueueTable(qin([a], [], { panes: [{ id: "p2", label: "x", state: "running", startedMs: QNOW, command: "pai worker wait w-9" }, { id: "p3", label: "y", state: "running", startedMs: QNOW, command: "sleep 5" }] }));
    expect(rows3[0]!.waits).toBeUndefined();
  });

  it("the row carries the plain-prose summary of the prompt copy (readTaskText + taskSummary, no model call)", () => {
    writeFileSync(join(dir, "w-20261118-120000-55574.prompt"), "Repo: /home/me/proj.\nTask: Fix the queue. It lists pane runs as jobs, which is wrong. They use no slot at all.", "utf8");
    const rows = buildQueueTable(qin([qst("w-20261118-120000-55574")], [], { summaryOf: (s) => taskSummary(readTaskText(dir, s)) }));
    expect(rows[0]!.summary).toBe("Fix the queue. It lists pane runs as jobs, which is wrong. They use no slot at all.");
    expect(renderQueueTable(rows)[1]).toContain("55574"); // the id column shows the short id
  });

  it("taskSummary: skips a leading Repo/Directory line and a Task: prefix, cuts at a sentence end within ~300", () => {
    expect(taskSummary("Directory: /x\nTask: Hello. World.")).toBe("Hello. World.");
    expect(taskSummary("One. Two. Three. Four.")).toBe("One. Two. Three.");
    const long = "S1. ".repeat(80) + "S2."; // way past 300
    const s = taskSummary(long);
    expect(s.length).toBeLessThanOrEqual(300);
    expect(s.endsWith(".")).toBe(true);
    expect(taskSummary("")).toBe("");
    expect(readTaskText(dir, { id: "nope" })).toBe(""); // no prompt copy: no summary
  });

  it("the live tool call is a tooltip, the activity cell is a short word", () => {
    const rows = buildQueueTable(qin([qst("a", { last: "Bash: cat > x <<EOF very long", updated: "2026-11-18 11:59:50" }), qst("b", { updated: "2026-11-18 11:50:00" })]));
    expect(rows[0]!.activity).toBe(""); // fresh status write, no request and no tool known: no word, never a guess
    expect(rows[0]!.now).toContain("Bash:");
    expect(rows.find((r) => r.id === "b")!.activity).toBe("idle 10m");
    expect(renderQueueTable(rows).join("\n")).not.toContain("Bash:");
  });

  // the activity word is real state, never the age of the last status write (no time-only "thinking")
  const qsched = (w: Record<string, Partial<{ activeSince: number; waitingSince: number }>>): SchedSnapshot =>
    ({ at: QNOW, engines: {}, workers: Object.fromEntries(Object.entries(w).map(([id, a]) => [id, { requests: 1, waitMsTotal: 0, lastWaitMs: 0, serviceMsTotal: 0, lastServiceMs: 0, waitingSince: 0, activeSince: 0, lastEnd: 0, session: "s", engine: "e", ...a }])) }) as SchedSnapshot;

  it("activity 'writing': its request is open at the model (the router's scheduler snapshot)", () => {
    const rows = buildQueueTable(qin([qst("g")], [], { sched: qsched({ g: { activeSince: QNOW - 4000 } }) }));
    expect(rows[0]!.activity).toBe("writing");
    expect(rows[0]!.activityTip).toContain("its request is open at the model");
  });
  it("activity 'in line': its request waits in the local scheduler queue", () => {
    const rows = buildQueueTable(qin([qst("q")], [], { sched: qsched({ q: { waitingSince: QNOW - 30_000 } }) }));
    expect(rows[0]!.activity).toBe("in line");
    // one word, two meanings: an unstarted ticket is at the engine; a started job's own tooltip names the slot
    expect(rows[0]!.activityTip).toContain("in line at the model: its request is queued at the engine");
  });
  it("activity 'tool': no request open, a tool runs (the worker waits on its Bash)", () => {
    const rows = buildQueueTable(qin([qst("t", { toolWaitSince: QNOW - 5000 })], [], { sched: qsched({ t: {} }) }));
    expect(rows[0]!.activity).toBe("tool");
    expect(rows[0]!.activityTip).toContain("a tool (build, test) is running");
  });
  it("activity 'idle Nm': none of the above for over 90 s", () => {
    const rows = buildQueueTable(qin([qst("i", { updated: "2026-11-18 11:50:00" })], [], { sched: qsched({ i: {} }) }));
    expect(rows[0]!.activity).toBe("idle 10m");
    expect(rows[0]!.activityTip).toContain("no request at the model and no tool running for 10 minutes; it may be stuck");
  });
  it("without the router only the status file speaks: 'tool' or 'idle', never a guess", () => {
    const rows = buildQueueTable(qin([qst("t2", { toolWaitSince: QNOW - 5000, updated: "2026-11-18 11:59:55" }), qst("f", { updated: "2026-11-18 11:59:55" })], [], { sched: null }));
    expect(rows.find((r) => r.id === "t2")!.activity).toBe("tool");
    expect(rows.find((r) => r.id === "f")!.activity).toBe(""); // a fresh write with no request and no tool is not 'working'
  });
  it("the activity word is at most 7 characters, so the state column never moves", () => {
    const rows = buildQueueTable(qin([qst("g"), qst("q"), qst("t", { toolWaitSince: QNOW - 5000 }), qst("i", { updated: "2026-11-18 11:40:00" })], [], { sched: qsched({ g: { activeSince: QNOW }, q: { waitingSince: QNOW }, t: {} }) }));
    // the state words are short; idle adds its own width as it always did
    for (const r of rows) if (!r.activity.startsWith("idle")) expect(r.activity.length).toBeLessThanOrEqual(7);
    const lines = renderQueueTable(rows);
    // rows sort by id (g, i, q, t): the words keep their fixed 7-char field, so every column lines up
    expect(lines[1]).toMatch(/^\[running\] writing/);
    expect(lines[3]).toMatch(/^\[running\] in line/);
  });
});

describe("queue header and order", () => {
  it("counts slots like the gate: paused apart from busy, waiting separate", () => {
    const f = { at: new Date(QNOW).toISOString(), gpuPct: 100, gpuAvgPct: null, idleSince: null, lastNudge: {}, providers: [{ provider: "gyro-l", cap: 3, running: 2, free: 1, queued: 2, paused: 3, activity: {} }] };
    expect(localIdleLine(f, QNOW)).toBe("gyro-l: 2 of 3 slots busy · 3 paused · 2 waiting · GPU 100%");
  });
  it("an over-cap holder is named as an engine-idle admission", () => {
    const f = { at: new Date(QNOW).toISOString(), gpuPct: 100, gpuAvgPct: null, idleSince: null, lastNudge: {}, providers: [{ provider: "gyro-l", cap: 3, running: 4, free: 0, queued: 0, paused: 0, activity: {} }] };
    expect(localIdleLine(f, QNOW)).toBe("gyro-l: 4 of 3 slots busy · engine idle: admitted 1 extra · GPU 100%");
  });
  it("groups running, waiting, paused/frozen; the CLI has the cockpit columns", () => {
    const r = qst("r"), w = qst("w", { state: "queued" }), p = qst("p", { paused: true }), fz = qst("fz");
    const rows = buildQueueTable(qin([p, fz, w, r], [qrow(w, "lm", 1)], { frozen: (id) => id === "fz" }));
    expect(rows.map((x) => x.id)).toEqual(["r", "w", "fz", "p"]);
    const text = renderQueueTable(rows);
    expect(text[0]).toMatch(/^state\s+session\s+task\s+model\s+prio\s+time\s+id$/);
    expect(text[2]).toContain("[waiting #1]");
  });
});

describe("queue session filter and sort", () => {
  const rows = [{ id: "1", session: "b" }, { id: "2", session: "a" }, { id: "3", session: "b" }, { id: "4", session: "a" }];
  it("filters to the chosen sessions (CLI --session)", () => {
    expect(filterBySession(rows, ["a"]).map((r) => r.id)).toEqual(["2", "4"]);
    expect(filterBySession(rows, ["a", "b"])).toHaveLength(4);
    expect(filterBySession(rows, [])).toHaveLength(4);
  });
  it("sorts by session, then position", () => {
    expect(sortBySession(rows).map((r) => r.id)).toEqual(["2", "4", "1", "3"]);
  });
});

describe("plain wording", () => {
  it("maps the internal texts", () => {
    expect(plainWording("escalated to anthropic: cli")).toBe("moved to cloud (Anthropic) by you");
    expect(plainWording("rerouted (escalation: no edit or commit for 10m)")).toBe("moved to cloud: no progress for 10 min");
    expect(plainWording("fall-through of w-1")).toBe("continues job w-1");
    expect(plainWording("queued 15m (operator priority)")).toBe("moved to cloud: waited 15 min for a local slot");
  });
  it("keeps no internal jargon in the rendered table", () => {
    const text = renderQueueTable(buildQueueTable(qin([qst("n", { fallThroughOf: "o", escalated: "escalated t2→t1: context 74%" })]))).slice(0, 2).join("\n");
    expect(text).not.toMatch(/fall-through|escalat|reroute|route|pin\b/i);
  });
});

describe("row and session actions", () => {
  let qdir = "";
  afterEach(() => qdir && rmSync(qdir, { recursive: true, force: true }));
  const qsetup = (): { logDir: string; workers: WorkersConfig; by: string; owns: () => boolean } => {
    qdir = mkdtempSync(join(tmpdir(), "qt-"));
    return { logDir: qdir, workers: { providers: { lm: { baseUrl: "http://127.0.0.1:1/v1" } } } as unknown as WorkersConfig, by: "test", owns: () => true };
  };
  const live = { pid: process.pid, started: "2026-11-18 11:50:00" };

  it("pause then resume update the row state through the engine control", async () => {
    const d = qsetup();
    saveStatus(d.logDir, qst("j1", live));
    expect((await runRowAction(d, "pause", "j1")).ok).toBe(true);
    expect(loadStatus(d.logDir, "j1")!.paused).toBe(true);
    expect((await runRowAction(d, "resume", "j1")).message).toBe("resumed");
    expect(loadStatus(d.logDir, "j1")!.paused).toBeFalsy();
  });

  it("priority changes the one job; an unknown job is an error in the result", async () => {
    const d = qsetup();
    saveStatus(d.logDir, qst("j1", live));
    expect((await runRowAction(d, "prio-high", "j1")).ok).toBe(true);
    expect(loadStatus(d.logDir, "j1")!.priority).toBe("high");
    expect((await runRowAction(d, "prio-low", "nope")).ok).toBe(false);
  });

  it("deep-freeze / resume call pai stop / pai resume with the row's id, the session or everything; to-cloud calls the mover", async () => {
    const d = qsetup();
    saveStatus(d.logDir, qst("j1", live));
    const calls: string[] = [];
    const deepFreeze = async (_l: string, _b: string, sel: { ids?: string[]; session?: string } | undefined, resume: boolean): Promise<string> => (calls.push(`${resume ? "resume" : "stop"}:${sel?.ids?.join(",") ?? sel?.session ?? "all"}`), "ok");
    await runRowAction({ ...d, deepFreeze }, "deep-freeze", "j1");
    await runRowAction({ ...d, deepFreeze }, "deep-resume", "j1");
    await runSessionAction({ ...d, deepFreeze }, "deep-freeze", "mdf");
    await runGlobalDeep({ ...d, deepFreeze }, false);
    await runGlobalDeep({ ...d, deepFreeze }, true);
    expect(calls).toEqual(["stop:j1", "resume:j1", "stop:mdf", "stop:all", "resume:all"]);
    const moves: string[] = [];
    const r = await runRowAction({ ...d, reroute: async (id, w) => (moves.push(`${id}>${w}`), "moved") }, "to-cloud", "j1");
    expect(moves).toEqual(["j1>cloud"]);
    expect(r.ok).toBe(true);
  });

  it("a deep-frozen job stays one row with only the resume action", () => {
    const rows = buildQueueTable(qin([qst("d", { state: "deepfrozen" as WorkerStatus["state"] })], [], { deepFrozen: (id) => id === "d" }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ slot: "saved", state: "deep-frozen", actions: ["deep-resume"] });
  });

  it("a session action applies to all jobs of that session only", async () => {
    const d = qsetup();
    saveStatus(d.logDir, qst("m1", { ...live, session: { name: "mdf" } as WorkerStatus["session"] }));
    saveStatus(d.logDir, qst("m2", { ...live, session: { name: "mdf" } as WorkerStatus["session"] }));
    saveStatus(d.logDir, qst("p1", { ...live, session: { name: "pai" } as WorkerStatus["session"] }));
    const res = await runSessionAction(d, "pause", "mdf");
    expect(res.message).toContain("2 job(s)");
    expect(["m1", "m2", "p1"].map((id) => !!loadStatus(d.logDir, id)!.paused)).toEqual([true, true, false]);
  });
});

describe("paused workers free their slot (one accounting)", () => {
  const three = ["a", "b", "c"].map((id) => qst(id, { paused: true, pausedBy: null as unknown as undefined, pid: process.pid }));
  it("holdsSlot: operator pause (also null pausedBy from an old pause) frees, preemptor pause and plain running hold", () => {
    expect(three.map((s) => holdsSlot(s))).toEqual([false, false, false]);
    expect(holdsSlot(qst("x", { paused: true, pausedBy: "u1" }))).toBe(true);
    expect(holdsSlot(qst("y"))).toBe(true);
  });
  it("3 running, all paused, 2 waiting: engine shows 0 of 3 held and the waiters are first in line", () => {
    const wk = { providers: { lm: { baseUrl: "http://127.0.0.1:1/v1", maxConcurrent: 3 } } } as unknown as WorkersConfig;
    const v = schedulerView(dir, wk, QNOW, three, () => true, () => true);
    expect(v.engines.find((e) => e.provider === "lm")!.used).toBe(0);
  });
  it("table label matches the accounting and the paused rows do not occupy a slot", () => {
    const hold = qst("h", { paused: true, pausedBy: "u1" });
    const rows = buildQueueTable(qin([...three, hold], [qrow(qst("w1", { state: "queued" }), "lm", 1)]));
    for (const id of ["a", "b", "c"]) expect(rows.find((r) => r.id === id)).toMatchObject({ slot: "freed", stateText: "paused (slot freed)" });
    expect(rows.find((r) => r.id === "h")).toMatchObject({ slot: "running", stateText: "paused (holds its slot)" });
    expect(rows.find((r) => r.id === "w1")!.slot).toBe(1);
  });
  it("a pane command is no row at all (pane runs stay in pai pane ps, not the queue)", () => {
    const rows = buildQueueTable(qin([], [], { panes: [{ id: "pane-1", label: "build", state: "running", startedMs: QNOW - 5000, session: "gyro-sess" }] }));
    expect(rows).toHaveLength(0);
  });
});

// ---- 2026-11-18: resume never bumps running jobs; queue moves; stale waiters requeue; move-to-local waits ----
describe("least-impact queue controls", () => {
  const ticket = (id: string, text = `${process.pid} @1000`): void => writeTicket(join(dir, "queue", "fakeA", id), text);
  const mst = (id: string, o: Partial<WorkerStatus> = {}): WorkerStatus =>
    ({ id, label: `task ${id}`, provider: "fakeA", model: "qwen", state: "running", started: "2026-11-18 11:50:00", updated: "2026-11-18 11:59:55", cwd: "/x", pid: process.pid, runPid: process.pid, spec: join(dir, "spec.txt"), ...o }) as WorkerStatus;
  const ws = { providers: { fakeA: { baseUrl: "http://localhost:1/v1", maxConcurrent: 3 } } } as unknown as WorkersConfig;
  const tin = (all: WorkerStatus[], local = true): TableInput => ({ statuses: all, queue: queueRows(dir, { fakeA: 3 }, () => true, all, undefined), panes: [], now: Date.now(), isLocal: (p) => local && p === "fakeA", sessionOf: () => "s" });
  beforeEach(() => {
    mkdirSync(join(dir, "queue", "fakeA"), { recursive: true });
    writeFileSync(join(dir, "spec.txt"), "do it", "utf8");
  });

  it("resume with the cap full queues the job: no running job moves, it takes the next FREE slot only", () => {
    for (const id of ["r1", "r2", "r3", "p"]) saveStatus(dir, mst(id));
    setWorkerPaused(dir, "p", true, "cockpit");
    expect(resumeWorker(dir, "p", "cockpit", Date.now(), () => 0)).toBe(true);
    for (const id of ["r1", "r2", "r3"]) expect(loadStatus(dir, id)!.state).toBe("running");
    expect(loadStatus(dir, "p")!.paused).toBe(true);
    expect(liveQueue(dir, "fakeA")).toEqual(["p"]);
    expect(admitResumedWaiters(dir, Date.now(), () => 0)).toEqual([]);
    expect(admitResumedWaiters(dir, Date.now(), () => 1)).toEqual(["p"]);
    expect(loadStatus(dir, "p")!.paused).toBeFalsy();
    expect(existsSync(join(dir, "queue", "fakeA", "p"))).toBe(false);
  });

  it("resume joins behind a higher class, ahead of its own; pausing again leaves the queue", async () => {
    saveStatus(dir, mst("p"));
    saveStatus(dir, mst("hi", { state: "queued", priority: "high" }));
    saveStatus(dir, mst("n1", { state: "queued" }));
    ticket("hi", `${process.pid} @${Date.now()} p:high`);
    ticket("n1", `${process.pid} @${Date.now()}`);
    setWorkerPaused(dir, "p", true, "cockpit");
    resumeWorker(dir, "p", "cockpit", Date.now(), () => 0);
    expect(liveQueue(dir, "fakeA")).toEqual(["hi", "p", "n1"]);
    expect((await runRowAction({ logDir: dir, workers: ws, by: "cockpit" }, "pause", "p")).ok).toBe(true);
    expect(liveQueue(dir, "fakeA")).toEqual(["hi", "n1"]);
    expect(loadStatus(dir, "p")!.paused).toBe(true);
  });

  it("resume with a free slot and nobody waiting runs at once", () => {
    saveStatus(dir, mst("p"));
    setWorkerPaused(dir, "p", true, "cockpit");
    expect(resumeWorker(dir, "p", "cockpit", Date.now(), () => 1)).toBe(true);
    expect(loadStatus(dir, "p")!.paused).toBeFalsy();
  });

  it("up / next / down change the ticket order and the table position; edge rows lack the dead moves", async () => {
    for (const [i, id] of ["a", "b", "c"].entries()) {
      saveStatus(dir, mst(id, { state: "queued" }));
      ticket(id, `${process.pid} @${1000 + i}`);
    }
    const act = (a: "up" | "next" | "down", id: string) => runRowAction({ logDir: dir, workers: ws, by: "t" }, a, id);
    const all = () => ["a", "b", "c"].map((id) => loadStatus(dir, id)!);
    expect((await act("up", "c")).ok).toBe(true);
    expect(liveQueue(dir, "fakeA")).toEqual(["a", "c", "b"]);
    expect(buildQueueTable(tin(all())).map((r) => r.id)).toEqual(["a", "c", "b"]);
    expect((await act("next", "b")).ok).toBe(true);
    expect(liveQueue(dir, "fakeA")).toEqual(["b", "a", "c"]);
    expect((await act("down", "b")).ok).toBe(true);
    expect(liveQueue(dir, "fakeA")).toEqual(["a", "b", "c"]);
    const by = Object.fromEntries(buildQueueTable(tin(all())).map((r) => [r.id, r.actions]));
    expect(by.a).not.toContain("up");
    expect(by.a).not.toContain("next");
    expect(by.a).toContain("down");
    expect(by.b).toEqual(expect.arrayContaining(["up", "next", "down"]));
    expect(by.c).toContain("up");
    expect(by.c).not.toContain("down");
    for (const r of buildQueueTable({ ...tin([mst("run"), mst("pz", { paused: true })]), queue: [] })) for (const a of ["up", "down", "next"] as const) expect(r.actions).not.toContain(a);
  });

  it("staleness follows the release: rebuilt dist, same release or unrecorded release is never stale", () => {
    expect(isStaleBuild("v1.2.62", "v1.2.62")).toBe(false);
    expect(isStaleBuild(undefined, "v1.2.62")).toBe(false);
    expect(isStaleBuild("v1.2.61", "v1.2.62")).toBe(true);
    expect(isStaleBuild("v1.2.61", undefined)).toBe(false);
    expect(currentBuildId() === undefined || /^v\d/.test(currentBuildId()!)).toBe(true);
    saveStatus(dir, mst("w", { state: "queued" }));
    ticket("w", `${process.pid} @5 b:v1.2.62`);
    expect(queueRows(dir, {}, () => true, undefined, "v1.2.62")[0]!.stale).toBeUndefined();
    expect(queueRows(dir, {}, () => true, undefined, "v1.2.63")[0]!.stale).toBe(true);
  });

  it("a stale waiter is restarted from its spec, its place handed over; the row reads 'restarting on new version'", async () => {
    saveStatus(dir, mst("w1", { state: "queued" }));
    ticket("w1", `${process.pid} front 2 @777 p:high b:v1.2.61`);
    const spawned: string[] = [];
    const killed: string[] = [];
    const rows = queueRows(dir, {}, () => true, undefined, "v1.2.62");
    expect(rows[0]!.stale).toBe(true);
    const r = await requeueStaleWaiters({
      logDir: dir,
      rows,
      spawn: (s) => {
        spawned.push(s.id);
        saveStatus(dir, mst("w2", { state: "queued", fallThroughOf: "w1" }));
        ticket("w2", `${process.pid} @9999 b:v1.2.62`);
        expect(loadStatus(dir, "w1")!.restarting).toBe(true);
        const t = buildQueueTable({ ...tin([loadStatus(dir, "w1")!]), queue: [{ ...rows[0]!, status: loadStatus(dir, "w1")! }] });
        expect(t[0]!.stateText).toBe("restarting on new version");
      },
      kill: async (id) => { killed.push(id); },
      newIdOf: () => "w2",
      ticketWaitMs: 500,
    });
    expect(r).toEqual(["w1"]);
    expect(spawned).toEqual(["w1"]);
    expect(killed).toEqual(["w1"]);
    const t2 = readFileSync(join(dir, "queue", "fakeA", "w2"), "utf8");
    expect(t2).toContain("front");
    expect(t2).toContain("@777");
    expect(t2).toContain("p:high");
  });

  describe("moving a running job to local", () => {
    const deps = (spawned: string[], killed: string[]) => ({
      logDir: dir,
      resolve: async (w: string) => ({ provider: w === "local" ? "fakeA" : "anthropic", description: w }),
      spawn: (s: { id: string }) => { spawned.push(s.id); },
      kill: async (id: string) => { killed.push(id); },
      announceMs: 0,
    });
    it("the cloud run keeps running until the continuation holds a local slot, then it is stopped", async () => {
      saveStatus(dir, mst("old", { provider: "anthropic", branch: "b1" }));
      const spawned: string[] = [];
      const killed: string[] = [];
      await rerouteWorker("old", "local", { ...deps(spawned, killed), deferKill: true });
      expect(spawned).toEqual(["old"]);
      expect(killed).toEqual([]);
      expect(loadStatus(dir, "old")!.movingTo).toBe("fakeA");
      saveStatus(dir, mst("new", { state: "queued", fallThroughOf: "old" }));
      ticket("new");
      expect(await finishDeferredMoves(dir, async (id) => { killed.push(id); })).toEqual([]);
      expect(killed).toEqual([]);
      const all = [loadStatus(dir, "old")!, loadStatus(dir, "new")!];
      const rows = buildQueueTable(tin(all));
      expect(rows.map((r) => r.id)).toEqual(["old"]);
      expect(rows[0]!.stateText).toBe("running (cloud) · moving to local, waiting #1");
      rmSync(join(dir, "queue", "fakeA", "new"));
      saveStatus(dir, mst("new", { state: "running", fallThroughOf: "old" }));
      expect(await finishDeferredMoves(dir, async (id) => { killed.push(id); })).toEqual(["old"]);
      expect(killed).toEqual(["old"]);
    });
    it("to cloud stays immediate", async () => {
      saveStatus(dir, mst("loc"));
      const killed: string[] = [];
      await rerouteWorker("loc", "cloud", deps([], killed));
      expect(killed).toEqual(["loc"]);
      expect(loadStatus(dir, "loc")!.movingTo).toBeUndefined();
    });
    it("a failed continuation leaves the cloud run where it was", async () => {
      saveStatus(dir, mst("old", { provider: "anthropic", movingTo: "fakeA", rerouted: "fakeA: cockpit" }));
      saveStatus(dir, mst("new", { state: "failed", fallThroughOf: "old" }));
      expect(await finishDeferredMoves(dir, async () => undefined)).toEqual([]);
      expect(loadStatus(dir, "old")!.movingTo).toBeUndefined();
    });
  });
});

describe("pull-forward among front tickets without rank", () => {
  const front = (): void => {
    mkdirSync(join(dir, "queue", "fakeA"), { recursive: true });
    for (const [id, t] of [["19344", 1000], ["55574", 2000], ["84703", 3000]] as const) writeTicket(join(dir, "queue", "fakeA", id), `${process.pid} front @${t}`);
  };

  it("next on the second puts it first", () => {
    front();
    expect(liveQueue(dir, "fakeA")).toEqual(["19344", "55574", "84703"]);
    expect(reorderQueue(dir, "fakeA", "55574", "front")).toEqual(["55574", "19344", "84703"]);
  });

  it("next on the job already first keeps the order", () => {
    front();
    expect(reorderQueue(dir, "fakeA", "19344", "front")).toEqual(["19344", "55574", "84703"]);
  });

  it("up on #2 makes it #1", () => {
    front();
    expect(moveUp(dir, "fakeA", "55574")).toBe(true);
    expect(liveQueue(dir, "fakeA")).toEqual(["55574", "19344", "84703"]);
  });
});

// 2026-11-18 incident: pushing jobs to the bottom made them run SOONER — a move ranked only what it touched, and a
// ranked ticket is placed ahead of unranked ones in its tier, so a moved-to-the-bottom job overtook every fair-share job.
describe("a move writes exactly the order the operator sees", () => {
  const mstSess = (id: string, session: string): WorkerStatus => ({ id, label: `task ${id}`, provider: "fakeA", model: "qwen", state: "queued", started: "", updated: "", cwd: "/x", pid: process.pid, sessionKey: session }) as WorkerStatus;
  const e = (id: string, since: number): QueueEntry => ({ id, pid: process.pid, front: false, since });
  const sess = (id: string): string => (/^o/.test(id) ? "other" : "PAI");

  it("fairOrder keeps a fully ranked queue in exactly that order", () => {
    const entries = ["p1", "p2", "p3", "o1", "o2"].map((id, i) => ({ ...e(id, 1000 + i), rank: i }));
    expect(fairOrder({ entries, sessionOf: sess, running: [], now: 5000 }).map((x) => x.id)).toEqual(["p1", "p2", "p3", "o1", "o2"]);
  });

  it("moving the two other-session tickets to the bottom admits the three PAI jobs first", () => {
    mkdirSync(join(dir, "queue", "fakeA"), { recursive: true });
    for (const [i, id] of ["p1", "p2", "p3", "o1", "o2"].entries()) {
      saveStatus(dir, mstSess(id, sess(id)));
      writeTicket(join(dir, "queue", "fakeA", id), `${process.pid} @${1000 + i}`);
    }
    // the operator pushes o1 and o2 to the bottom (two down moves / one drag each)
    expect(reorderQueueTo(dir, "fakeA", "o1", 5).length).toBe(5);
    const after = reorderQueueTo(dir, "fakeA", "o2", 5);
    expect(after).toEqual(["p1", "p2", "p3", "o1", "o2"]);
    // and the order sticks through every later read (all tickets are ranked: nothing unranked can overtake)
    expect(liveQueue(dir, "fakeA")).toEqual(["p1", "p2", "p3", "o1", "o2"]);
    const rows = queueRows(dir, {}, () => true);
    expect(rows.map((r) => r.id)).toEqual(["p1", "p2", "p3", "o1", "o2"]);
  });

  it("a new arrival queues after the ranked block (fair share only orders what no move ordered)", () => {
    mkdirSync(join(dir, "queue", "fakeA"), { recursive: true });
    for (const [i, id] of ["p1", "o1"].entries()) {
      saveStatus(dir, mstSess(id, sess(id)));
      writeTicket(join(dir, "queue", "fakeA", id), `${process.pid} @${1000 + i}`);
    }
    expect(reorderQueueTo(dir, "fakeA", "o1", 2)).toEqual(["p1", "o1"]);
    // a fresh PAI job arrives (unranked): behind the operator's order
    saveStatus(dir, mstSess("p2", "PAI"));
    writeTicket(join(dir, "queue", "fakeA", "p2"), `${process.pid} @9000`);
    expect(liveQueue(dir, "fakeA")).toEqual(["p1", "o1", "p2"]);
  });

  it("the gate admits the head of that order: after the move a PAI job takes the free slot, not a moved one", async () => {
    mkdirSync(join(dir, "queue", "fakeA"), { recursive: true });
    for (const [i, id] of ["p1", "p2", "o1"].entries()) {
      saveStatus(dir, mstSess(id, sess(id)));
      writeTicket(join(dir, "queue", "fakeA", id), `${process.pid} @${1000 + i}`);
    }
    reorderQueueTo(dir, "fakeA", "o1", 3);
    expect(liveQueue(dir, "fakeA")).toEqual(["p1", "p2", "o1"]);
    // o1 waits at the gate with cap 1 (one holder): it must not be admitted ahead of p1
    const g = capacityGate({ logDir: dir, self: { id: "o1", provider: "fakeA" }, cap: 1, config: {}, isAlive: () => true, load: () => [{ ...mstSess("h", "other"), state: "running", started: "2026-11-18 11:00:00" }], now: () => QNOW, sleep: () => new Promise((x) => setTimeout(x, 5)) });
    const raced = await Promise.race([g.then(() => "admitted"), new Promise((x) => setTimeout(() => x("waiting"), 200))]);
    expect(raced).toBe("waiting");
    // the gate's own ticket rewrite kept the operator's order: p1 is still the head
    expect(liveQueue(dir, "fakeA")[0]).toBe("p1");
    expect(readFileSync(join(dir, "queue", "fakeA", "o1"), "utf8")).toContain(" 2 ");
    void g;
  });
});

// 2026-11-18: ps said "3 of 3 slots busy" while the queue table showed one running job: started jobs that waited to
// take their slot back (running status + a queue ticket) were listed among the waiting ones. The line counts what
// the rows show: "N waiting" = not-started jobs only; started jobs in line for a slot back are named apart.
describe("a started job waiting for its slot back is running everywhere", () => {
  it("queue table: the ticketed running job is in the running group with activity 'in line' and its slot tooltip, not in the waiting list", () => {
    const back = qst("b1", { toolWaitSince: QNOW - 60_000 });
    const fresh = qst("n1", { state: "queued" });
    const rows = buildQueueTable(qin([back, fresh], [qrow(back, "lm", 1), qrow(fresh, "lm", 2)]));
    expect(rows.map((r) => [r.id, r.state, r.slot])).toEqual([["b1", "running", "running"], ["n1", "waiting", 1]]);
    // one word for both kinds of waiting: the operator sees 'in line'; the tooltip says which one
    expect(rows[0]!.activity).toBe("in line");
    expect(rows[0]!.activityTip).toContain("in line for a slot: started, lent its slot during a long tool run, position 1 for getting one back");
    expect(renderQueueTable(rows)[1]).toMatch(/^\[running\] in line/);
  });
  it("slot line: 'N waiting' counts not-started jobs only; started jobs holding a ticket are named apart", () => {
    // the incident: 12 tickets (8 not started, 4 started and holding one) read "12 waiting" while the table showed 8 waiting rows
    const f = { at: new Date(QNOW).toISOString(), gpuPct: 0, gpuAvgPct: null, idleSince: null, lastNudge: {}, providers: [{ provider: "gyro-l", cap: 3, running: 4, free: 0, queued: 8, paused: 0, lent: 2, startedHoldingTicket: 4, activity: {} }] };
    expect(localIdleLine(f, QNOW)).toBe("gyro-l: 4 of 3 slots busy · engine idle: admitted 1 extra · 2 lent (waiting on a tool) · 4 waiting for their slot back · 8 waiting · GPU 0%");
  });
});

describe("engine-idle admission", () => {
  const run = (id: string): WorkerStatus => ({ ...st(id), state: "running", started: "2026-11-18 11:00:00" }) as WorkerStatus;
  const gateFor = (id: string, statuses: WorkerStatus[], o: { idle: boolean; cap?: number }) =>
    Promise.race([
      capacityGate({ logDir: dir, self: { id, provider: "fakeA" }, cap: o.cap ?? 2, config: {}, isAlive: () => true, load: () => statuses, now: () => QNOW, sleep: () => new Promise((x) => setTimeout(x, 5)), engineIdle: () => o.idle }).then(() => "admitted"),
      new Promise((x) => setTimeout(() => x("waiting"), 250)),
    ]);
  it("admits the head above the cap while the engine is idle", async () => {
    expect(await gateFor("w9", [run("a"), run("b")], { idle: true })).toBe("admitted");
  });
  it("waits at the cap while the engine is busy", async () => {
    expect(await gateFor("w9", [run("a"), run("b")], { idle: false })).toBe("waiting");
  });
  it("stops at the hard ceiling cap + idleExtraMax started jobs", async () => {
    const five = ["a", "b", "c", "d", "e"].map(run);
    expect(await gateFor("w9", five, { idle: true })).toBe("waiting");
    expect(await gateFor("w8", five.slice(0, 4), { idle: true })).toBe("admitted");
  });
  it("one extra per idle window: a job that just started blocks the next", async () => {
    const fresh = { ...run("c"), started: "2026-11-18 11:59:50" } as WorkerStatus;
    expect(await gateFor("w9", [run("a"), run("b"), fresh], { idle: true })).toBe("waiting");
  });
  it("a job back from a long tool run goes ahead of every not-yet-started job, even a high one", async () => {
    mkdirSync(join(dir, "queue", "fakeA"), { recursive: true });
    const hi = { ...st("hi"), priority: "high" } as WorkerStatus;
    saveStatus(dir, hi);
    saveStatus(dir, st("back"));
    writeTicket(join(dir, "queue", "fakeA", "hi"), `${process.pid} @1 p:high`);
    const g = capacityGate({ logDir: dir, self: { id: "back", provider: "fakeA" }, cap: 1, config: {}, isAlive: () => true, load: () => [run("a")], now: () => QNOW, sleep: () => new Promise((x) => setTimeout(x, 5)), tier: "high", returning: true });
    await new Promise((x) => setTimeout(x, 30));
    expect(liveQueue(dir, "fakeA", () => true)[0]).toBe("back");
    void g;
  });
});

describe("ps/watch show the model that served the last turn", () => {
  const cfg = { providers: {}, nativeModels: {} } as never;
  const st = { id: "w1", provider: "anthropic", model: "claude-sonnet-5-5", state: "running", turns: 3, cwd: "/x" } as unknown as WorkerStatus;
  it("lastServedModel reads the last assistant turn of the transcript", async () => {
    const { lastServedModel } = await import("./served-model.js");
    const d = mkdtempSync(join(tmpdir(), "served-"));
    const f = join(d, "t.jsonl");
    writeFileSync(f, [{ type: "assistant", message: { model: "claude-sonnet-5-5" } }, { type: "user" }, { type: "assistant", message: { model: "qwen3.8-flash-next-gyro-l" } }, { type: "assistant", message: { model: "<synthetic>" } }].map((l) => JSON.stringify(l)).join("\n") + "\n");
    expect(lastServedModel(f)).toBe("qwen3.8-flash-next-gyro-l");
    rmSync(d, { recursive: true, force: true });
  });
  it("providerTag marks a mismatch and stays plain when the model matches", async () => {
    const { providerTag } = await import("./render.js");
    expect(providerTag(st, cfg, "qwen3.8-flash-next-gyro-l")).toBe("[anthropic/sonnet-5.5 -> served by qwen3.8-flash-next-gyro-l]");
    expect(providerTag(st, cfg, "claude-sonnet-5-5-20261001")).toBe("[anthropic/sonnet-5.5]");
    expect(providerTag(st, cfg, null)).toBe("[anthropic/sonnet-5.5]");
    expect(providerTag(st, cfg, "qwen3.8-flash-next-gyro-l", "anthropic #2")).toBe("[anthropic #2/sonnet-5.5]");
  });
  it("instanceLabel names the copy by the router engine key; schedLine lists #n busy/cap", async () => {
    const { instanceLabel, schedLine } = await import("../router/scheduler.js");
    const e = (n: number) => ({ inflight: n ? { session: "aaaaaaaa", worker: "w", sinceMs: 1 } : null, flights: n ? [{ session: "aaaaaaaa", worker: "w", sinceMs: 1 }] : [], slots: 2, queued: {}, counters: {} });
    const two = { at: Date.now(), workers: {}, engines: { "signal-2": e(1), "signal-2#2": e(1) } } as never;
    const one = { at: Date.now(), workers: {}, engines: { "signal-2": e(1) } } as never;
    expect(instanceLabel("signal-2", two)).toBe("signal-2 #1");
    expect(instanceLabel("signal-2#2", two)).toBe("signal-2 #2");
    expect(instanceLabel("signal-2", one)).toBe("signal-2");
    expect(schedLine(two)).toContain("[#1 1/2 · #2 1/2]");
  });
  it("watch emits a MODEL line when the serving model changes", async () => {
    const { watchWorkers } = await import("./watch.js");
    const lines: string[] = [];
    const served = ["claude-sonnet-5-5", "qwen3.8-flash-next-gyro-l", "qwen3.8-flash-next-gyro-l"];
    let i = 0;
    await watchWorkers(
      { ids: ["w1"], stallMs: 1e9, beatMs: 1e9, pollMs: 1 },
      {
        now: () => 0,
        sleep: async () => {},
        statuses: () => [{ ...st, state: i >= 2 ? "done" : "running" } as WorkerStatus],
        urls: () => ({}),
        probe: async () => true,
        served: () => served[Math.min(i++, 2)],
        emit: (l) => lines.push(l),
      }
    );
    expect(lines.filter((l) => l.startsWith("MODEL"))).toEqual(["MODEL w1 [anthropic] claude-sonnet-5-5 -> qwen3.8-flash-next-gyro-l"]);
  });

  async function stallRun(context: (now: number) => import("./stall-context.js").StallContext | undefined, polls = 3, stepMs = 100_000) {
    const { watchWorkers } = await import("./watch.js");
    const lines: string[] = [];
    let t = 0;
    let i = 0;
    await watchWorkers(
      { ids: ["w1"], stallMs: 200_000, beatMs: 1e12, pollMs: 1 },
      {
        now: () => t,
        sleep: async () => {
          t += stepMs;
        },
        statuses: () => [{ id: "w1", provider: "hy4-flash", model: "m", state: ++i > polls ? "done" : "running", turns: 24, cwd: "/x" } as unknown as WorkerStatus],
        urls: () => ({}),
        probe: async () => true,
        context: (_s, now) => context(now),
        emit: (l) => lines.push(l),
      }
    );
    return lines.filter((l) => /^(STALL|BUSY)/.test(l));
  }

  it("watch says BUSY with engine numbers when the engine is thinking, repeating only every 2 min", async () => {
    const { parseEngine } = await import("./stall-context.js");
    const engine = parseEngine("[strata] thinking: 18349 of budget 24576 tokens, 71.9 tok/s, 257 s")!;
    const out = await stallRun(() => ({ engine }), 8);
    expect(out[0]).toBe("BUSY w1 [hy4-flash] turns 24 unchanged for 200s — engine: thinking 18,349 tok at 71.9 tok/s (257 s)");
    expect(out.length).toBe(3);
    expect(out.every((l) => l.startsWith("BUSY"))).toBe(true);
  });

  it("watch reads the answering and tool-call phases and flags a long answer", async () => {
    const { parseEngine } = await import("./stall-context.js");
    expect(parseEngine("[strata] answering: 18318 of max 32768 tokens, 73.2 tok/s, 252 s")).toEqual({
      text: "answering 18,318 of max 32,768 tok at 73.2 tok/s (252 s) — long answer",
      busy: true,
    });
    expect(parseEngine("[strata] answering: 800 of max 32768 tokens, 70.0 tok/s, 11 s")?.text).toBe("answering 800 of max 32,768 tok at 70.0 tok/s (11 s)");
    expect(parseEngine("[strata] writing a tool call: Write: 1200 of max 8192 tokens, 60.1 tok/s, 20 s")?.text).toBe("writing a Write call 1,200 of max 8,192 tok at 60.1 tok/s (20 s)");
    expect(parseEngine("[strata] answering: 5 of max 9 tokens, 1.0 tok/s, 1 s\n[strata] done: 5 tokens in 1 s (5 tok/s) (stop)")?.busy).toBe(false);
  });

  it("watch parses prompt reading and survives unknown engine output", async () => {
    const { parseEngine } = await import("./stall-context.js");
    expect(parseEngine("x\n[strata] reading the prompt: 61,440 of 65,232 tokens, 59 s so far")?.text).toBe("reading prompt 61,440/65,232 (59 s)");
    expect(parseEngine("some other engine: working\n")).toBeUndefined();
  });

  it("watch says STALL with retrying when the transcript has api_retry events after the last turn", async () => {
    const { parseRetry } = await import("./stall-context.js");
    const ev = (a: number) => JSON.stringify({ type: "system", subtype: "api_retry", attempt: a, max_retries: 10, error_status: null, error: "unknown" });
    const asst = JSON.stringify({ type: "assistant" });
    const retry = parseRetry([ev(1), asst, ev(2), ev(3)].join("\n"))!;
    expect(retry).toEqual({ attempt: 3, max: 10, error: "unknown" });
    const out = await stallRun(() => ({ retry, router: ["upstream closed mid-answer"] }));
    expect(out).toEqual(["STALL w1 [hy4-flash] turns 24 unchanged for 200s — retrying (attempt 3 of 10, error unknown); router: upstream closed mid-answer"]);
  });

  it("watch says plain STALL once when nothing moves anywhere", async () => {
    const out = await stallRun(() => ({}), 8);
    expect(out).toEqual(["STALL w1 [hy4-flash] turns 24 unchanged for 200s"]);
  });
});

// 2026-11-22: a session queued behind max_parallel 1 stayed queued after max_parallel was cleared, and ps said "0 running".
describe("session max_parallel gate", () => {
  const sessGate = (id: string, o: { cap: number | undefined; capOf?: () => number | undefined; load: () => WorkerStatus[] }) =>
    capacityGate({
      logDir: dir, self: { id, provider: "cloud" }, cap: o.cap, capOf: o.capOf, config: {}, isAlive: () => true, load: o.load, now: () => QNOW,
      sleep: () => new Promise((x) => setTimeout(x, 5)),
      scope: { key: "session~PAI", label: "session PAI", holds: (s) => s.sessionKey === "PAI" },
    });
  const runner = (id: string, provider: string): WorkerStatus => ({ id, label: `task ${id}`, provider, model: "m", state: "running", started: "2026-11-22 07:49:19", updated: "", cwd: "/x", pid: process.pid, sessionKey: "PAI" }) as WorkerStatus;
  const race = (g: Promise<unknown>) => Promise.race([g.then(() => "admitted"), new Promise((x) => setTimeout(() => x("waiting"), 150))]);

  it("a session worker on a newly added local provider counts as running (holds the cap)", async () => {
    const g = sessGate("q1", { cap: 1, load: () => [runner("r1", "inkling-locals")] });
    expect(await race(g)).toBe("waiting");
  });

  it("clearing max_parallel admits the queued run on the next tick", async () => {
    let cap: number | undefined = 1;
    const g = sessGate("q2", { cap: 1, capOf: () => cap, load: () => [runner("r2", "inkling-locals")] });
    expect(await race(g)).toBe("waiting");
    cap = undefined;
    expect(await race(g)).toBe("admitted");
  });

  it("0 running with cap 1 admits", async () => {
    expect(await race(sessGate("q3", { cap: 1, load: () => [] }))).toBe("admitted");
  });
});

describe("providers with several instances", () => {
  const inst = (n: number, state: LocalInstance["state"] = "ready"): LocalInstance => ({
    id: `sig#${n}`, model: "sig", provider: "sig", url: `http://127.0.0.1:${8043 + n}`, origin: "registered", port: 8043 + n, state, startedAt: 0, log: "",
  });
  const provs = { sig: { enabled: true, baseUrl: "http://127.0.0.1:8044", instances: ["http://127.0.0.1:8044", "http://127.0.0.1:8045"] } };
  const registry = (): LocalInstance[] => endpointRegistry([], provs, { tiers: {} } as never);

  /** Route n jobs in sequence against a load map, the way the router does (held counts per engine key). */
  function spread(n: number, cap: number, running: LocalInstance[]): string[] {
    const held = new Map<string, number>();
    return Array.from({ length: n }, (_, k) => {
      const p = pickInstance("sig", running, (key) => held.get(key) ?? 0, { cap, session: `job${k}` })!;
      const key = instanceEngineKey(p);
      held.set(key, (held.get(key) ?? 0) + 1);
      return p.id;
    });
  }

  it("one provider entry yields N registered instances, and the cap scales per instance", () => {
    expect(registry().map((i) => i.url)).toEqual(["http://127.0.0.1:8044", "http://127.0.0.1:8045"]);
    const cfg = { providers: { sig: { ...provs.sig, maxConcurrent: 2 }, one: { baseUrl: "http://127.0.0.1:9", maxConcurrent: 2 } } };
    expect(providerCap(cfg, "sig")).toBe(4);
    expect(providerCap(cfg, "one")).toBe(2);
  });

  it("3 concurrent jobs on 2 instances with maxConcurrent 2 spread 2+1", () => {
    const ids = spread(3, 2, registry());
    expect(ids.filter((i) => i === "sig#1").length).toBe(2);
    expect(ids.filter((i) => i === "sig#2").length).toBe(1);
  });

  it("a worker session keeps its instance while it has room", () => {
    const run = registry();
    const first = pickInstance("sig", run, (k) => (k === "sig" ? 0 : 1), { cap: 2, session: "w-keep" })!;
    const again = pickInstance("sig", run, () => 0, { cap: 2, session: "w-keep" })!;
    expect(again.id).toBe(first.id);
  });

  it("one instance down: every job goes to the other", () => {
    const ids = spread(3, 2, [inst(1, "failed"), inst(2)]);
    expect(new Set(ids)).toEqual(new Set(["sig#2"]));
  });
});

describe("worker admission counts every instance of a provider", () => {
  const cfg = { providers: { sig: { baseUrl: "http://127.0.0.1:8044", maxConcurrent: 2, instances: ["http://127.0.0.1:8044", "http://127.0.0.1:8045"] } } };
  it("2 instances x 2 admits 4", () => {
    expect(providerCap(cfg, "sig", () => true)).toBe(4);
    expect(providerCap(cfg, "sig")).toBe(4);
  });
  it("one instance unhealthy admits 2", () => {
    expect(providerCap(cfg, "sig", (u) => !u.endsWith(":8045"))).toBe(2);
  });
  it("all down never drops below one instance's worth", () => {
    expect(providerCap(cfg, "sig", () => false)).toBe(2);
  });
  it("the gate admits a worker while 3 hold slots on two instances (cap 4), and holds it with 2 holders when one is down (cap 2)", async () => {
    const run = (id: string): WorkerStatus => ({ ...st(id), state: "running", started: "2026-11-18 11:00:00", provider: "sig" }) as WorkerStatus;
    let stop = false;
    const tryAdmit = (holders: string[], up: (u: string) => boolean) =>
      Promise.race([
        capacityGate({ aborted: () => stop, logDir: dir, self: { id: "wx", provider: "sig" }, cap: providerCap(cfg, "sig", up)!, config: {}, isAlive: () => true, load: () => holders.map(run), now: () => QNOW, sleep: () => new Promise((x) => setTimeout(x, 5)), engineIdle: () => false }).then(() => "admitted"),
        new Promise((x) => setTimeout(() => x("waiting"), 250)),
      ]);
    expect(await tryAdmit(["a", "b", "c"], () => true)).toBe("admitted");
    expect(await tryAdmit(["a", "b", "c", "d"], () => true)).toBe("waiting");
    expect(await tryAdmit(["a", "b"], (u) => !u.endsWith(":8045"))).toBe("waiting");
    expect(await tryAdmit(["a"], (u) => !u.endsWith(":8045"))).toBe("admitted");
    stop = true;
  });
  it("the status path (providerCap with instanceCachedUp) never touches the network", async () => {
    const { vi } = await import("vitest");
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    resetInstanceHealth();
    expect(providerCap(cfg, "sig", instanceCachedUp)).toBe(4);
    await new Promise((r) => setTimeout(r, 10));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
  it("providerCap passes only the url to the health check (real instanceUp through filter)", async () => {
    const { vi } = await import("vitest");
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    resetInstanceHealth();
    expect(providerCap(cfg, "sig", instanceUp)).toBe(4);
    spy.mockRestore();
    resetInstanceHealth();
  });
  it("instanceUp is optimistic until a probe answers", async () => {
    resetInstanceHealth();
    const probe = async () => false;
    expect(instanceUp("http://x:1", probe)).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(instanceUp("http://x:1", probe)).toBe(false);
    resetInstanceHealth();
  });
});

describe("stickyEngine: affinity only while the instance has a free slot", () => {
  it("keeps the session's engine while free, moves when it is full and another is free", async () => {
    const { stickyEngine, rememberEngine } = await import("./local-instances.js");
    const keys = ["m", "m#2", "m#3"];
    const load: Record<string, number> = { m: 0, "m#2": 0, "m#3": 0 };
    rememberEngine("m", "sess", "m#2");
    expect(stickyEngine("m", "sess", keys, (k) => load[k] < 2, (k) => load[k])).toBe("m#2");
    load["m#2"] = 2;
    load.m = 1;
    expect(stickyEngine("m", "sess", keys, (k) => load[k] < 2, (k) => load[k])).toBe("m#3");
  });
});
