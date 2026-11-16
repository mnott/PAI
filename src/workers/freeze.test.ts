import { mkdtempSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activeMsOf, activeNow, freezeAll, freezeHold, frozenMsFor, frozenMsOf, frozenSince, parseDuration, parseProcs, planFreeze, thawAll, type FreezeDeps, type ProcRow } from "./freeze.js";
import { detectModelServers, modelServerPorts, type ModelServersDeps } from "./model-servers.js";
import { detectSupervisionEvents } from "./supervision.js";
import { TroubleWatcher } from "./worker-trouble.js";
import { escalationReason } from "./reroute.js";
import type { Messenger, RunOrigin } from "./run-events.js";
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

  it("freezes the model listener's whole tree once, children first", () => {
    const rows = [...ROWS, row(301, 300, "strata-engine --serve"), row(302, 301, "engine-worker")];
    const p = planFreeze([], rows, [{ pid: 300, label: "gyro-l:8035 serving gyro-l" }], 60);
    expect(p.filter((e) => e.kind === "model").map((e) => `${e.id}:${e.pid}`)).toEqual(["gyro-l:8035 serving gyro-l:302", "gyro-l:8035 serving gyro-l:301", "gyro-l:8035 serving gyro-l:300"]);
  });
});

describe("model server detection", () => {
  // gyro-l and gyro-m share port 8035 (only one runs at a time); the engine child 36558 hangs under the listener 36270
  const PORTS = modelServerPorts(
    {
      "gyro-l": { baseUrl: "http://127.0.0.1:8035/v1", models: { default: "gyro-l" } },
      "gyro-m": { baseUrl: "http://127.0.0.1:8035/v1", models: { default: "gyro-m" } },
      cloud: { baseUrl: "https://api.example.com/v1", models: { default: "opus" } },
    },
    [{ port: 8035, provider: "gyro-l", served: "gyro-l" }],
  );
  const probe = (deps: Partial<ModelServersDeps>): Promise<{ pid: number; label: string }[]> =>
    detectModelServers(PORTS, { listeners: () => [], servedIds: async () => null, ...deps });

  it("shares one port between configs into one target; a remote provider is no target", () => {
    expect(PORTS).toEqual([{ port: 8035, models: { "gyro-l": "gyro-l", "gyro-m": "gyro-m" }, fallback: "gyro-l" }]);
  });
  it("two configs on one port with one listener -> one entry, named by the served id", async () => {
    const found = await probe({ listeners: (p) => (p === 8035 ? [36270] : []), servedIds: async () => ["gyro-l"] });
    expect(found).toEqual([{ pid: 36270, label: "gyro-l:8035" }]);
  });
  it("the served id decides which shared-port config names the server", async () => {
    const found = await probe({ listeners: () => [36270], servedIds: async () => ["gyro-m"] });
    expect(found).toEqual([{ pid: 36270, label: "gyro-m:8035" }]);
  });
  it("a port that answers with an unknown id keeps a config name and shows what it serves", async () => {
    const found = await probe({ listeners: () => [36270], servedIds: async () => ["Qwen3-4B"] });
    expect(found).toEqual([{ pid: 36270, label: "gyro-l:8035 serving Qwen3-4B" }]);
  });
  it("a configured port with nothing serving is not running", async () => {
    expect(await probe({ listeners: () => [1], servedIds: async (p) => (p === 8035 ? null : []) })).toEqual([]);
  });
  it("one entry per listening pid when a port has several", async () => {
    const found = await probe({ listeners: () => [36270, 41], servedIds: async () => ["gyro-l"] });
    expect(found).toEqual([{ pid: 41, label: "gyro-l:8035" }, { pid: 36270, label: "gyro-l:8035" }]);
  });
});

describe("freeze / thaw", () => {
  const saved = { file: process.env.PAI_FREEZE_FILE, w: process.env.PAI_WORKER };
  let sent: string[];
  let now: number;
  let dead: Set<number>;
  const deps = (servers: { pid: number; label: string }[] = [{ pid: 300, label: "gyro" }]): FreezeDeps => ({
    procs: () => ROWS.filter((r) => !dead.has(r.pid)),
    statuses: () => [st("L1", 100), st("L2", 200)],
    servers: async () => servers,
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

  it("refuses inside a worker", async () => {
    process.env.PAI_WORKER = "1";
    await expect(freezeAll("/x", "t", undefined, deps())).rejects.toThrow(/cannot freeze/);
    expect(sent).toEqual([]);
  });

  // what the CLI does for --only without --models: deps.servers is emptied (freezeRun)
  it("--only plans no model entries (the shared server keeps running for the others)", async () => {
    const d = deps();
    d.servers = async () => [];
    const r = await freezeAll("/nonexistent-log", "t", undefined, d, ["L2"]);
    expect(r.marker.pids.every((e) => e.kind === "worker")).toBe(true);
    expect(r.marker.pids.map((e) => e.id)).toEqual(["L2", "L2", "L2"]);
    expect(sent.filter((s) => s.startsWith("SIGSTOP"))).toEqual(["SIGSTOP:200", "SIGSTOP:201", "SIGSTOP:202"]);
  });

  it("stops children before the L1 and the model server last; the gate holds while frozen", async () => {
    const r = await freezeAll("/nonexistent-log", "t", 60_000, deps());
    expect(r.total).toBe(8);
    const stops = sent.filter((s) => s.startsWith("SIGSTOP")).map((s) => Number(s.split(":")[1]));
    expect(stops.indexOf(200)).toBeLessThan(stops.indexOf(100));
    expect(stops[stops.length - 1]).toBe(300);
    expect(freezeHold()).toMatch(/frozen/);
    await expect(freezeAll("/nonexistent-log", "t", undefined, deps())).rejects.toThrow(/already frozen/);
  });

  it("thaws the model first, the L1 last, tells every worker, skips the dead, and accounts the time", async () => {
    await freezeAll("/nonexistent-log", "t", undefined, deps());
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

// supervision's elapsed-time notices must never fire for a frozen worker, and after a thaw the quiet clock restarts from the thaw time (frozen minutes do not count) — the one helper both sides share is tested here against an isolated marker (PAI_FREEZE_FILE), never the live one.
describe("supervision stands down while frozen", () => {
  const saved = { file: process.env.PAI_FREEZE_FILE, w: process.env.PAI_WORKER };
  let now: number;
  beforeEach(() => {
    process.env.PAI_FREEZE_FILE = join(mkdtempSync(join(tmpdir(), "freeze-sup-")), "freeze.json");
    delete process.env.PAI_WORKER;
    now = Date.now();
  });
  afterEach(() => {
    if (saved.file === undefined) delete process.env.PAI_FREEZE_FILE;
    else process.env.PAI_FREEZE_FILE = saved.file;
    if (saved.w === undefined) delete process.env.PAI_WORKER;
    else process.env.PAI_WORKER = saved.w;
  });

  const marker = (since: number, ids: string[]): void => {
    writeFileSync(process.env.PAI_FREEZE_FILE!, JSON.stringify({ since, by: "t", pids: ids.map((id) => ({ pid: 100, lstart: "x", kind: "worker", id, role: "worker", depth: 0 })) }), "utf8");
  };
  const acct = (w: Record<string, number>): void => {
    mkdirSync(join(process.env.PAI_FREEZE_FILE!, ".."), { recursive: true });
    writeFileSync(`${process.env.PAI_FREEZE_FILE}.acct`, JSON.stringify({ totalMs: Math.max(0, ...Object.values(w)), workers: w }), "utf8");
  };
  // the trouble throttle is real config (5 min): step past it for a deliberate second send
  const unthrottle = (w: TroubleWatcher): void => {
    (w as unknown as { lastSent: number }).lastSent = -Infinity;
  };

  it("frozenSince / frozenMsOf / activeMsOf", () => {
    expect(frozenSince("L1")).toBeUndefined();
    marker(now - 5 * 60_000, ["L1"]);
    expect(frozenSince("L1")).toBe(now - 5 * 60_000);
    expect(frozenSince("L9")).toBeUndefined();
    // the quiet spell started 8 min ago; it froze 5 min ago: 3 active minutes
    expect(activeMsOf("L1", now - 8 * 60_000, now)).toBe(3 * 60_000);
    // a quiet spell older than the freeze: only the minutes outside it count
    expect(activeMsOf("L1", now - 20 * 60_000, now)).toBe(15 * 60_000);
    acct({ L1: 3 * 60_000 }); // a closed freeze spell (the accounts' horizon [now-3m, now]) plus the open one, merged where they overlap
    expect(activeMsOf("L1", now - 20 * 60_000, now)).toBe(15 * 60_000); // fully inside the open freeze: adds nothing to the covered span
    // paused spans discount the same clock: an open pause window [pausedAt, now]
    expect(activeMsOf("L9", now - 8 * 60_000, now, { paused: true, pausedAt: now - 5 * 60_000 })).toBe(3 * 60_000);
    // and a closed pause [now - pausedMs, now] (the accounts' horizon): after the resume only minutes since it ended count
    expect(activeMsOf("L9", now - 20 * 60_000, now, { pausedMs: 15 * 60_000 })).toBe(5 * 60_000);
  });

  it("TroubleWatcher tells no stall while frozen and restarts the quiet clock at the thaw", async () => {
    const sent: string[] = [];
    // the messenger chain is async: count when the line lands in toSession
    let n = 0;
    const msg = { toSession: async (_o: RunOrigin, t: string) => (sent.push(t), n++, true) } as unknown as Messenger;
    const w = new TroubleWatcher("L1", "lbl", msg, {} as RunOrigin, "", () => now);
    // quiet 30 min BEFORE the freeze even began: the freeze covers none of it
    now -= 30 * 60_000;
    w.activity();
    now += 30 * 60_000;
    w.tick();
    await w.flush();
    expect(n).toBe(1); // a normal long quiet spell still tells once (the throttle is real config, so no second send below)
    // freeze the worker mid-quiet: no further stall, however many ticks pass
    marker(now - 58 * 60_000, ["L1"]);
    now += 58 * 60_000;
    w.tick();
    await w.flush();
    expect(n).toBe(1);
    // thaw: the frozen minutes leave the clock, and with a 30-min spell already told the watcher stays quiet until a NEW active stall
    acct({ L1: 58 * 60_000 }); // the closed spell ends at `now` (the thaw horizon)
    rmSync(process.env.PAI_FREEZE_FILE!);
    w.tick();
    await w.flush();
    expect(n).toBe(1); // active quiet after the thaw is only the pre-freeze 30 min, already told
    unthrottle(w);
    (w as unknown as { stallTold: boolean }).stallTold = false; // a new quiet spell for the once-per-spell latch
    now += 45 * 60_000; // NEW active quiet (30 + 45 = 75 min) past the stall threshold tells again — frozen minutes never count
    w.tick();
    await w.flush();
    expect(n).toBe(2);
    expect(sent[1]).toContain("has produced no output for 75 min");
  });

  it("detectSupervisionEvents: no stalled verdict while frozen, none from frozen minutes after a thaw", () => {
    const s = st("L1", 100, { spawnerSession: "own", updated: "2026-11-16 10:00:00", turns: 3 });
    const at = Date.parse("2026-11-16 11:00:00"); // 60 min without a turn, all of it frozen
    marker(at - 60 * 60_000, ["L1"]);
    const opts = { stallMs: 10 * 60_000, now: new Date(at), isAlive: () => true };
    expect(detectSupervisionEvents([s], opts)).toEqual([]);
    // thawed: the hour was frozen time, so nothing stalled
    acct({ L1: 60 * 60_000 });
    rmSync(process.env.PAI_FREEZE_FILE!);
    expect(detectSupervisionEvents([s], opts)).toEqual([]);
    // a worker not named by the marker keeps its stall verdict (the wall clock, unchanged)
    const other = { ...s, id: "L9" };
    expect(detectSupervisionEvents([other], opts).map((e) => e.kind)).toEqual(["stalled"]);
  });

  it("escalationReason: no verdict for a frozen worker, and frozen minutes never count after a thaw", () => {
    // the spec path must exist: escalationReason refuses a job with no task copy to restart
    const specFile = join(process.env.PAI_FREEZE_FILE!, "..", "spec.txt");
    writeFileSync(specFile, "task", "utf8");
    // the local stamp parses against the machine's zone, so build it from `now` (the test's local epoch)
    const startedStamp = (t: number): string => { const d = new Date(t); const p = (n: number): string => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
    const at = now; // 60 min after the start below
    const s = st("L1", 100, { state: "running", started: startedStamp(now - 60 * 60_000), spec: specFile });
    const p = { queuedMaxMin: 5, stallMaxMin: 30, stallFailedCalls: 5 };
    marker(at - 60 * 60_000, ["L1"]);
    expect(escalationReason(s, at, p)).toBeNull(); // frozen: never escalated
    acct({ L1: 60 * 60_000 });
    rmSync(process.env.PAI_FREEZE_FILE!);
    expect(escalationReason(s, at, p)).toBeNull(); // the hour was frozen time: no "no edit or commit for 60m"
    const q = st("L1", 100, { state: "queued", now: true, started: startedStamp(now - 60 * 60_000), spec: specFile });
    expect(escalationReason(q, at, p)).toBeNull(); // queued minutes frozen too (acct L1 = 60m covers the whole wait)
    acct({}); marker(at - 45 * 60_000, ["L9"]); // another worker's freeze moves this one's clock not at all
    expect(escalationReason(s, at, p)).toMatch(/no edit or commit for 60m/);
  });

  it("paused workers (preemption or `pai worker pause`) tell no stall and their paused minutes never count", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pause-sup-"));
    const startedStamp = (t: number): string => { const d = new Date(t); const p = (n: number): string => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
    // a worker paused by a --now preemption 20 min ago, quiet for 30 active minutes around it
    const paused = st("L1", 100, { spawnerSession: "own", updated: startedStamp(now - 50 * 60_000), turns: 3, paused: true, pausedBy: "now-run", pausedAt: now - 20 * 60_000 });
    const opts = { stallMs: 10 * 60_000, now: new Date(now), isAlive: () => true };
    expect(detectSupervisionEvents([paused], opts)).toEqual([]); // paused: no stalled verdict at all
    // after the resume: the paused 20 min leave the clock; only the older 30 active min remain, already past the threshold — a worker that never resumed mid-spell still stalls on its ACTIVE quiet
    const resumed = { ...paused, started: startedStamp(now - 50 * 60_000), paused: false, pausedAt: undefined, pausedMs: 20 * 60_000 };
    expect(detectSupervisionEvents([resumed], opts).map((e) => e.kind)).toEqual(["stalled"]);
    // a fully paused-since-start worker: every minute was paused time, nothing to tell after the resume either
    const allPaused = st("L2", 101, { spawnerSession: "own", updated: startedStamp(now - 50 * 60_000), turns: 3, pausedMs: 50 * 60_000 });
    expect(detectSupervisionEvents([allPaused], opts)).toEqual([]);
    // escalation: a paused worker has no verdict, and its paused minutes do not count toward stallMaxMin
    const specFile = join(dir, "spec.txt");
    writeFileSync(specFile, "task", "utf8");
    const p = { queuedMaxMin: 5, stallMaxMin: 30, stallFailedCalls: 5 };
    expect(escalationReason(paused, now, p)).toBeNull(); // paused: never escalated
    expect(escalationReason({ ...resumed, spec: specFile }, now, p)).toMatch(/no edit or commit for 30m/); // only the active half of the spell counts
    // TroubleWatcher: a worker whose status says paused tells nothing while parked
    const sent: string[] = [];
    let n = 0;
    const msg = { toSession: async (_o: RunOrigin, t: string) => (sent.push(t), n++, true) } as unknown as Messenger;
    writeFileSync(join(dir, "L1.status"), JSON.stringify({ id: "L1", pid: 100, state: "running", paused: true, pausedAt: now - 20 * 60_000 }), "utf8");
    const w = new TroubleWatcher("L1", "lbl", msg, {} as RunOrigin, dir, () => now);
    (w as unknown as { lastActivity: number }).lastActivity = now - 30 * 60_000; // quiet 30 min on the injected clock
    w.tick();
    await w.flush();
    expect(n).toBe(0); // paused (preempted): no stall notice at all
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
