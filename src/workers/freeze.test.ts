import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activeNow, freezeAll, freezeHold, frozenMsFor, parseDuration, parseProcs, planFreeze, thawAll, thawSome, readFreeze, type FreezeDeps, type ProcRow } from "./freeze.js";
import type { WorkerStatus } from "./status.js";

const row = (pid: number, ppid: number, command: string): ProcRow => ({ pid, ppid, lstart: `Mon Nov 16 10:00:0${pid % 10} 2026`, command });
const st = (id: string, pid: number, extra: Partial<WorkerStatus> = {}): WorkerStatus => ({ id, pid, state: "running", ...extra }) as WorkerStatus;

// L1 (pid 100) -> claude 101 -> bash 102 -> vitest 103; its L2 run client 200 -> claude 201 -> cc 202
const ROWS: ProcRow[] = [
  row(1, 0, "launchd"),
  row(50, 1, "pai daemon"),
  row(60, 1, "claude interactive"),
  row(100, 1, "pai worker run L1"),
  row(101, 100, "claude"),
  row(102, 101, "bash"),
  row(103, 102, "vitest"),
  row(104, 101, "node /x/pai-daemon-test"),
  row(200, 102, "pai worker run L2"),
  row(201, 200, "claude"),
  row(202, 201, "cc"),
  row(300, 1, "model-server"),
];

describe("planFreeze", () => {
  const plan = planFreeze([st("L1", 100), st("L2", 200)], ROWS, [{ pid: 300, label: "gyro" }], 60);
  it("freezes the L2 tree before the L1 tree, the model server last", () => {
    const ids = plan.map((e) => e.id);
    expect(ids.indexOf("L2")).toBeLessThan(ids.indexOf("L1"));
    expect(plan[plan.length - 1]).toMatchObject({ kind: "model", pid: 300 });
    expect(plan.filter((e) => e.id === "L2").map((e) => e.pid).sort()).toEqual([200, 201, 202]);
    expect(plan.find((e) => e.pid === 200)).toMatchObject({ role: "l2", depth: 1 });
    expect(plan.find((e) => e.pid === 100)).toMatchObject({ role: "l1", depth: 0 });
  });
  it("takes every descendant once and never the daemon", () => {
    const pids = plan.map((e) => e.pid);
    expect(new Set(pids).size).toBe(pids.length);
    expect(pids).toContain(103);
    expect(pids).not.toContain(104);
    expect(pids).not.toContain(50);
    expect(pids).not.toContain(60);
  });
  it("never freezes the caller or its ancestors", () => {
    const p = planFreeze([st("L1", 100)], ROWS, [], 103);
    const pids = p.map((e) => e.pid);
    for (const a of [100, 101, 102, 103]) expect(pids).not.toContain(a);
  });
});

describe("freeze / thaw", () => {
  const saved = { file: process.env.PAI_FREEZE_FILE, w: process.env.PAI_WORKER };
  let sent: string[];
  let now: number;
  let dead: Set<number>;
  const deps = (): FreezeDeps => ({
    procs: () => ROWS.filter((r) => !dead.has(r.pid)),
    statuses: () => [st("L1", 100), st("L2", 200)],
    servers: () => [{ pid: 300, label: "gyro" }],
    signal: (pid, sig) => void sent.push(`${sig}:${pid}`),
    owns: () => true,
    self: 60,
    now: () => now,
    note: (_d, id, t) => void sent.push(`note:${id}:${t.slice(0, 60)}`),
  });
  beforeEach(() => {
    process.env.PAI_FREEZE_FILE = join(mkdtempSync(join(tmpdir(), "freeze-")), "freeze.json");
    delete process.env.PAI_WORKER;
    sent = [];
    dead = new Set();
    now = Date.now();
  });
  afterEach(() => {
    if (saved.file === undefined) delete process.env.PAI_FREEZE_FILE;
    else process.env.PAI_FREEZE_FILE = saved.file;
    if (saved.w === undefined) delete process.env.PAI_WORKER;
    else process.env.PAI_WORKER = saved.w;
  });

  it("refuses inside a worker", () => {
    process.env.PAI_WORKER = "1";
    expect(() => freezeAll("/x", "t", undefined, deps())).toThrow(/cannot freeze/);
    expect(sent).toEqual([]);
  });

  it("stops children before the L1 and the model server last; the gate holds while frozen", () => {
    const r = freezeAll("/nonexistent-log", "t", 60_000, deps());
    expect(r.total).toBe(8);
    const stops = sent.filter((s) => s.startsWith("SIGSTOP")).map((s) => Number(s.split(":")[1]));
    expect(stops.indexOf(200)).toBeLessThan(stops.indexOf(100));
    expect(stops[stops.length - 1]).toBe(300);
    expect(freezeHold()).toMatch(/frozen/);
    expect(() => freezeAll("/nonexistent-log", "t", undefined, deps())).toThrow(/already frozen/);
  });

  it("thaws the model first, the L1 last, tells every worker, skips the dead, and accounts the time", () => {
    freezeAll("/nonexistent-log", "t", undefined, deps());
    sent.length = 0;
    now += 5 * 60_000;
    expect(frozenMsFor("L1", now)).toBe(5 * 60_000);
    dead.add(103);
    const r = thawAll("/nonexistent-log", deps());
    const conts = sent.filter((s) => s.startsWith("SIGCONT")).map((s) => Number(s.split(":")[1]));
    expect(conts[0]).toBe(300);
    expect(conts.indexOf(200)).toBeLessThan(conts.indexOf(100));
    expect(conts).not.toContain(103);
    expect(r.skipped).toBe(1);
    const notes = sent.filter((s) => s.startsWith("note:"));
    expect(notes.map((n) => n.split(":")[1])).toEqual(["L2", "L1"]);
    expect(notes[0]).toContain("Paused by the operator for 5 min");
    expect(freezeHold()).toBeUndefined();
    expect(existsSync(process.env.PAI_FREEZE_FILE!)).toBe(false);
    expect(frozenMsFor("L1", now)).toBe(5 * 60_000);
    expect(activeNow()).toBeLessThanOrEqual(Date.now() - 5 * 60_000 + 1000);
    expect(thawAll("/nonexistent-log", deps()).wasFrozen).toBe(false);
  });
});

describe("exceptions", () => {
  const saved = process.env.PAI_FREEZE_FILE;
  let sent: string[];
  const A = [st("L1", 100, { session: { id: "u", name: "CaseLeaf" }, provider: "gyro" }), st("L2", 200, { parent: "L1" }), st("X", 300, { session: { id: "v", name: "other" } })];
  const rows: ProcRow[] = [row(1, 0, "launchd"), row(60, 1, "claude interactive"), row(100, 1, "pai worker run L1"), row(101, 100, "claude"), row(200, 1, "pai worker run L2"), row(201, 200, "claude"), row(300, 1, "pai worker run X"), row(301, 300, "claude"), row(400, 1, "model-server")];
  const deps = (): FreezeDeps => ({
    procs: () => rows,
    statuses: () => A,
    servers: () => [{ pid: 400, label: "gyro:8080" }],
    signal: (pid, sig) => void sent.push(`${sig}:${pid}`),
    owns: () => true,
    self: 60,
    now: () => Date.now(),
    note: () => undefined,
  });
  beforeEach(() => {
    process.env.PAI_FREEZE_FILE = join(mkdtempSync(join(tmpdir(), "freeze-")), "freeze.json");
    delete process.env.PAI_WORKER;
    sent = [];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.PAI_FREEZE_FILE;
    else process.env.PAI_FREEZE_FILE = saved;
  });

  it("except-session plans exclude that session's tree (and its children and model server)", () => {
    freezeAll("/nonexistent-log", "t", undefined, deps(), undefined, { session: "caseleaf" });
    const stopped = sent.map((s) => Number(s.split(":")[1])).sort();
    expect(stopped).toEqual([300, 301]);
  });

  it("partial thaw keeps the others in the marker and the gate", () => {
    freezeAll("/nonexistent-log", "t", undefined, deps());
    sent.length = 0;
    const r = thawSome("/nonexistent-log", deps(), { session: "CaseLeaf" });
    const conts = sent.map((s) => Number(s.split(":")[1])).sort();
    expect(conts).toEqual([100, 101, 200, 201, 400]);
    expect(r.lines.join("\n")).toMatch(/model gyro:8080 thawed too/);
    expect(readFreeze()!.pids.map((e) => e.id)).toEqual(["X", "X"]);
    expect(freezeHold()).toMatch(/frozen/);
    thawSome("/nonexistent-log", deps(), { ids: ["X"] });
    expect(freezeHold()).toBeUndefined();
  });

  it("--now passes the freeze gate", () => {
    freezeAll("/nonexistent-log", "t", undefined, deps());
    expect(freezeHold()).toMatch(/frozen/);
    expect(freezeHold(true)).toBeUndefined();
  });
});

describe("helpers", () => {
  it("parseDuration", () => {
    expect(parseDuration("30m")).toBe(1_800_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("1h30m")).toBe(5_400_000);
    expect(parseDuration("15")).toBe(900_000);
    expect(() => parseDuration("soon")).toThrow();
  });
  it("parseProcs skips zombies", () => {
    const t = "  12   1 Mon Nov 16 10:00:01 2026 /bin/sh -c x\n  13  12 Mon Nov 16 10:00:02 2026 <defunct>\n";
    expect(parseProcs(t).map((r) => r.pid)).toEqual([12]);
  });
});
