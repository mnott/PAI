import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { queueRows, writeTicket, type QueueRow } from "./capacity.js";
import { buildQueueTable, plainWording, renderQueueTable, type TableInput } from "./queue-table.js";
import { runGlobalDeep, runRowAction, runSessionAction } from "./queue-ops.js";
import type { WorkersConfig } from "./config.js";
import { applyPriority } from "./preempt.js";
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
    expect(rows[0]).toMatchObject({ session: "mdf", model: "local: qwen", stateText: "running" });
    expect(rows[1]).toMatchObject({ state: "paused", model: "cloud: anthropic opus", session: "other", stateText: "paused (slot freed)" });
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

  it("panes are rows of kind command with the caller's session and only stop/freeze/thaw", () => {
    const rows = buildQueueTable(qin([], [], { panes: [{ id: "pane-1", label: "npm run build", state: "running", startedMs: QNOW - 65_000, session: "pai" }] }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "command", session: "pai", task: "npm run build", seconds: 65, actions: ["freeze", "stop"] });
  });

  it("the live tool call is a tooltip, the activity cell is a short word", () => {
    const rows = buildQueueTable(qin([qst("a", { last: "Bash: cat > x <<EOF very long", updated: "2026-11-18 11:59:50" }), qst("b", { updated: "2026-11-18 11:50:00" })]));
    expect(rows[0]!.activity).toBe("working");
    expect(rows[0]!.now).toContain("Bash:");
    expect(rows.find((r) => r.id === "b")!.activity).toBe("idle 10m");
    expect(renderQueueTable(rows).join("\n")).not.toContain("Bash:");
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
  it("a pane command shows the caller's session", () => {
    const rows = buildQueueTable(qin([], [], { panes: [{ id: "pane-1", label: "build", state: "running", startedMs: QNOW - 5000, session: "gyro-sess" }] }));
    expect(rows[0]).toMatchObject({ kind: "command", session: "gyro-sess" });
  });
});
