import { mkdtempSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isFrozen, activeMsOf, activeNow, freezeAll, freezeHold, frozenMsFor, frozenMsOf, frozenSince, sparedServer, parseDuration, parseProcs, planFreeze, thawAll, thawSome, readFreeze, workerAncestryBlocked, freezeWorkerGuard, freezeLogDir, freezeTestMode, parseFreezeServers, realFreezeDeps, type FreezeDeps, type ProcRow } from "./freeze.js";
import { paiHomePath } from "../config/pai-home.js";
import { detectModelServers, modelServerPorts, type ModelServersDeps } from "./model-servers.js";
import { detectSupervisionEvents, workerRunLabel } from "./supervision.js";
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

// every freeze/thaw test below runs in TEST MODE (PAI_FREEZE_FILE away from the default marker): these describe blocks clear the other two test-mode vars so a leak can never point discovery at the real machine.
const clearTestEnv = (): void => {
  delete process.env.PAI_FREEZE_LOGDIR;
  delete process.env.PAI_FREEZE_SERVERS;
};

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
    clearTestEnv();
    sent = [];
    dead = new Set();
    now = Date.now();
  });
  afterEach(() => {
    if (saved.file === undefined) delete process.env.PAI_FREEZE_FILE;
    else process.env.PAI_FREEZE_FILE = saved.file;
    if (saved.w === undefined) delete process.env.PAI_WORKER;
    else process.env.PAI_WORKER = saved.w;
    clearTestEnv();
  });

  it("--only on ended ids writes no marker and says nothing to freeze", async () => {
    const r = await freezeAll("/nonexistent-log", "t", 60_000, deps(), ["gone-1", "gone-2"]);
    expect(r.total).toBe(0);
    expect(r.marker).toBeNull();
    expect(r.lines).toEqual(["nothing to freeze: gone-1, gone-2 are not running"]);
    expect(existsSync(process.env.PAI_FREEZE_FILE!)).toBe(false);
    expect(readFreeze()).toBeNull();
    expect(sent).toEqual([]);
  });

  it("a partial freeze is not global: the sweeps and the gate carry on, only the frozen id is skipped", async () => {
    await freezeAll("/nonexistent-log", "t", 60_000, deps([]), ["L2"]);
    expect(readFreeze()?.scope).toBe("workers");
    expect(isFrozen()).toBe(false); // scheduler sweeps / reaper keep running
    expect(freezeHold()).toBeUndefined(); // new runs are admitted
    expect(frozenSince("L2")).toBeDefined(); // supervision skips the frozen worker
    expect(frozenSince("L1")).toBeUndefined(); // and supervises the others
  });

  it("a global freeze still pauses everything", async () => {
    await freezeAll("/nonexistent-log", "t", 60_000, deps());
    expect(isFrozen()).toBe(true);
    expect(freezeHold()).toMatch(/frozen/);
    expect(frozenSince("L1")).toBeDefined();
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
    expect(r.marker!.pids.every((e) => e.kind === "worker")).toBe(true);
    expect(r.marker!.pids.map((e) => e.id)).toEqual(["L2", "L2", "L2"]);
    expect(sent.filter((s) => s.startsWith("SIGSTOP"))).toEqual(["SIGSTOP:200", "SIGSTOP:201", "SIGSTOP:202"]);
  });

  it("stops children before the L1 and the model server last; the gate holds while frozen", async () => {
    const r = await freezeAll("/nonexistent-log", "t", 60_000, deps()); // an unconfigured runtime is stopped by the default freeze
    expect(r.total).toBe(8);
    const stops = sent.filter((s) => s.startsWith("SIGSTOP")).map((s) => Number(s.split(":")[1]));
    expect(stops.indexOf(200)).toBeLessThan(stops.indexOf(100));
    expect(stops[stops.length - 1]).toBe(300);
    expect(freezeHold()).toMatch(/frozen/);
    await expect(freezeAll("/nonexistent-log", "t", undefined, deps())).rejects.toThrow(/already frozen/);
  });

  // 2026-11-24: `pai freeze --for 5m` froze the apple-fm bridge (port 8037, near-zero idle cost)
  // and its helper calls timed out at 60 s. Default freeze stops every server EXCEPT a
  // runtime explicitly marked `freeze: spare`; --all stops everything as before.
  it("default freeze stops every server except the spare-marked one and lists what was spared", async () => {
    // planFreeze only stops a server whose pid is in the process table; the servers live on free pids
    const d = deps([{ pid: 500, label: "gyro-l:8035" }, { pid: 501, label: "apple-fm:8037" }, { pid: 502, label: "ollama:11434" }]);
    d.procs = () => [...ROWS, row(500, 1, "strata-engine --serve"), row(501, 1, "apple-fm-bridge"), row(502, 1, "ollama serve")];
    d.spareRuntimes = () => ["apple-fm"];
    const r = await freezeAll("/nonexistent-log", "t", undefined, d);
    const stops = sent.filter((s) => s.startsWith("SIGSTOP"));
    expect(stops).toContain("SIGSTOP:500"); // heavy-flagged or not: stopped
    expect(stops).toContain("SIGSTOP:502"); // unconfigured runtime: stopped, the GPU is freed
    expect(stops).not.toContain("SIGSTOP:501"); // the spare-marked runtime keeps serving
    expect(r.marker!.pids.filter((e) => e.kind === "model").map((e) => e.id).sort()).toEqual(["gyro-l:8035", "ollama:11434"]);
    expect(r.lines.join("\n")).toContain("spared model apple-fm:8037");
    expect(r.lines.join("\n")).toContain("frozen 2 workers + 2 model servers");
  });

  // 2026-11-24: Ollama is never a freeze target — not a PAI-started server process, it unloads
  // idle models itself after its keep_alive (~5 min), and serves embeddings (pai-embedding) and
  // the apple-fm helper fallback (ollama:qwen3:8b). When it runs, the output says so in one line.
  it("ollama is never frozen and the output says why when it is running", async () => {
    const d = deps([{ pid: 500, label: "gyro-l:8035" }]);
    d.procs = () => [...ROWS, row(500, 1, "strata-engine --serve"), row(600, 1, "ollama serve")];
    const r = await freezeAll("/nonexistent-log", "t", undefined, d);
    const stops = sent.filter((s) => s.startsWith("SIGSTOP"));
    expect(stops).toContain("SIGSTOP:500"); // the PAI server is still stopped
    expect(stops).not.toContain("SIGSTOP:600"); // ollama is never stopped
    expect(r.marker!.pids.some((e) => e.pid === 600)).toBe(false); // and never recorded
    expect(r.lines).toContain("ollama: not frozen (unloads idle models itself; serves embeddings and the helper fallback)");
  });

  it("no ollama line when ollama is not running", async () => {
    const r = await freezeAll("/nonexistent-log", "t", undefined, deps());
    expect(r.lines.join("\n")).not.toContain("ollama: not frozen");
  });

  it("--all freezes every model server including the spare-marked one", async () => {
    const d = deps([{ pid: 500, label: "gyro-l:8035" }, { pid: 501, label: "apple-fm:8037" }]);
    d.procs = () => [...ROWS, row(500, 1, "strata-engine --serve"), row(501, 1, "apple-fm-bridge")];
    d.spareRuntimes = () => ["apple-fm"];
    const r = await freezeAll("/nonexistent-log", "t", undefined, d, undefined, undefined, true);
    expect(sent.filter((s) => s.startsWith("SIGSTOP"))).toEqual(expect.arrayContaining(["SIGSTOP:500", "SIGSTOP:501"])); // 501 is the spared server, taken only by --all
    expect(r.marker!.pids.filter((e) => e.kind === "model").map((e) => `${e.id}:${e.pid}`).sort()).toEqual(["apple-fm:8037:501", "gyro-l:8035:500"]);
    expect(r.lines.join("\n")).not.toContain("spared model");
  });

  it("thaw continues exactly what the default freeze froze (the spared server was never stopped)", async () => {
    const d = deps([{ pid: 500, label: "gyro-l:8035" }, { pid: 501, label: "apple-fm:8037" }]);
    d.procs = () => [...ROWS, row(500, 1, "strata-engine --serve"), row(501, 1, "apple-fm-bridge")];
    d.spareRuntimes = () => ["apple-fm"];
    await freezeAll("/nonexistent-log", "t", undefined, d);
    sent.length = 0;
    const r = thawAll("/nonexistent-log", d);
    const conts = sent.filter((s) => s.startsWith("SIGCONT")).map((s) => Number(s.split(":")[1]));
    expect(conts).not.toContain(501);
    expect(conts[0]).toBe(500); // the model first
    expect(r.wasFrozen).toBe(true);
  });

  it("sparedServer: only a runtime marked freeze: spare is spared", () => {
    expect(sparedServer("apple-fm:8037", ["apple-fm"])).toBe(true);
    expect(sparedServer("apple-fm:8037 serving apple-fm", ["apple-fm"])).toBe(true);
    expect(sparedServer("gyro-l:8035", ["apple-fm"])).toBe(false);
    expect(sparedServer("ollama:11434", ["apple-fm"])).toBe(false);
    expect(sparedServer("port 8035", ["apple-fm"])).toBe(false);
    expect(sparedServer("apple-fm:8037", [])).toBe(false);
  });

  it("thaws the model first, the L1 last, tells every worker, skips the dead, and accounts the time", async () => {
    await freezeAll("/nonexistent-log", "t", undefined, deps()); // an unconfigured runtime is stopped by the default freeze
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
    clearTestEnv();
    now = Date.now();
  });
  afterEach(() => {
    if (saved.file === undefined) delete process.env.PAI_FREEZE_FILE;
    else process.env.PAI_FREEZE_FILE = saved.file;
    if (saved.w === undefined) delete process.env.PAI_WORKER;
    else process.env.PAI_WORKER = saved.w;
    clearTestEnv();
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
    // deliver overrides the digest routing: this test counts direct sends
    const w = new TroubleWatcher("L1", "lbl", msg, {} as RunOrigin, "", () => now, async (_p, t) => msg.toSession({} as RunOrigin, t));
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

  it("detectSupervisionEvents: no stalled verdict while frozen, none from frozen minutes after a thaw", async () => {
    const s = st("L1", 100, { spawnerSession: "own", updated: "2026-11-16 10:00:00", turns: 3 });
    const at = Date.parse("2026-11-16 11:00:00"); // 60 min without a turn, all of it frozen
    marker(at - 60 * 60_000, ["L1"]);
    const opts = { stallMs: 10 * 60_000, now: new Date(at), isAlive: () => true };
    expect(await detectSupervisionEvents([s], opts)).toEqual([]);
    // thawed: the hour was frozen time, so nothing stalled
    acct({ L1: 60 * 60_000 });
    rmSync(process.env.PAI_FREEZE_FILE!);
    expect(await detectSupervisionEvents([s], opts)).toEqual([]);
    // a worker not named by the marker keeps its stall verdict (the wall clock, unchanged)
    const other = { ...s, id: "L9" };
    expect((await detectSupervisionEvents([other], opts)).map((e) => e.kind)).toEqual(["stalled"]);
  });

  it("escalationReason: no verdict for a frozen worker, and frozen minutes never count after a thaw", () => {
    // the spec path must exist: escalationReason refuses a job with no task copy to restart
    const specFile = join(process.env.PAI_FREEZE_FILE!, "..", "spec.txt");
    writeFileSync(specFile, "task", "utf8");
    // the local stamp parses against the machine's zone, so build it from `now` (the test's local epoch)
    const startedStamp = (t: number): string => { const d = new Date(t); const p = (n: number): string => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
    const at = now; // 60 min after the start below
    const s = st("L1", 100, { state: "running", started: startedStamp(now - 60 * 60_000), spec: specFile, turns: 5, turnsAtProgress: 0 });
    const p = { queuedMaxMin: 5, stallCalls: 60, stallFailedCalls: 5 };
    marker(at - 60 * 60_000, ["L1"]);
    expect(escalationReason(s, at, p)).toBeNull(); // frozen: never escalated
    acct({ L1: 60 * 60_000 });
    rmSync(process.env.PAI_FREEZE_FILE!);
    expect(escalationReason(s, at, p)).toBeNull(); // the hour was frozen time: no "no edit or commit for 60m"
    const q = st("L1", 100, { state: "queued", now: true, started: startedStamp(now - 60 * 60_000), spec: specFile });
    expect(escalationReason(q, at, p)).toBeNull(); // queued minutes frozen too (acct L1 = 60m covers the whole wait)
    acct({}); marker(at - 45 * 60_000, ["L9"]); // another worker's freeze moves this one's clock not at all
    expect(escalationReason({ ...s, turns: 70 }, at, p)).toMatch(/no edit or commit for 70 turns/);
  });

  it("paused workers (preemption or `pai worker pause`) tell no stall and their paused minutes never count", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pause-sup-"));
    const startedStamp = (t: number): string => { const d = new Date(t); const p = (n: number): string => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
    // a worker paused by a --now preemption 20 min ago, quiet for 30 active minutes around it
    const paused = st("L1", 100, { spawnerSession: "own", updated: startedStamp(now - 50 * 60_000), turns: 3, paused: true, pausedBy: "now-run", pausedAt: now - 20 * 60_000 });
    const opts = { stallMs: 10 * 60_000, now: new Date(now), isAlive: () => true };
    expect(await detectSupervisionEvents([paused], opts)).toEqual([]); // paused: no stalled verdict at all
    // after the resume: the paused 20 min leave the clock; only the older 30 active min remain, already past the threshold — a worker that never resumed mid-spell still stalls on its ACTIVE quiet
    const resumed = { ...paused, started: startedStamp(now - 50 * 60_000), paused: false, pausedAt: undefined, pausedMs: 20 * 60_000 };
    expect((await detectSupervisionEvents([resumed], opts)).map((e) => e.kind)).toEqual(["stalled"]);
    // a fully paused-since-start worker: every minute was paused time, nothing to tell after the resume either
    const allPaused = st("L2", 101, { spawnerSession: "own", updated: startedStamp(now - 50 * 60_000), turns: 3, pausedMs: 50 * 60_000 });
    expect(await detectSupervisionEvents([allPaused], opts)).toEqual([]);
    // escalation: a paused worker has no verdict, and pause never produces a verdict (turn-count rule)
    const specFile = join(dir, "spec.txt");
    writeFileSync(specFile, "task", "utf8");
    const p = { queuedMaxMin: 5, stallCalls: 60, stallFailedCalls: 5 };
    expect(escalationReason(paused, now, p)).toBeNull(); // paused: never escalated
    expect(escalationReason({ ...resumed, spec: specFile, turns: 70, turnsAtProgress: 0 }, now, p)).toMatch(/no edit or commit for 70 turns/); // turns, not minutes: pause time is irrelevant
    // TroubleWatcher: a worker whose status says paused tells nothing while parked
    const sent: string[] = [];
    let n = 0;
    const msg = { toSession: async (_o: RunOrigin, t: string) => (sent.push(t), n++, true) } as unknown as Messenger;
    writeFileSync(join(dir, "L1.status"), JSON.stringify({ id: "L1", pid: 100, state: "running", paused: true, pausedAt: now - 20 * 60_000 }), "utf8");
    const w = new TroubleWatcher("L1", "lbl", msg, {} as RunOrigin, dir, () => now, async (_p, t) => msg.toSession({} as RunOrigin, t));
    (w as unknown as { lastActivity: number }).lastActivity = now - 30 * 60_000; // quiet 30 min on the injected clock
    w.tick();
    await w.flush();
    expect(n).toBe(0); // paused (preempted): no stall notice at all
  });

  it("a loop-stop notice names the continuation the harness already started, or says no escalation", async () => {
    // the notice is sent only after the escalation is decided (execute-fold.ts), so it can carry the clause
    const sent: string[] = [];
    const msg = { toSession: async (_o: RunOrigin, t: string) => (sent.push(t), true) } as unknown as Messenger;
    const w = new TroubleWatcher("L1", "lbl", msg, {} as RunOrigin, "", () => now, async (_p, t) => msg.toSession({} as RunOrigin, t));
    w.onLoopStop("repeated identical tool call", "escalating to anthropic-native as L2 (same branch) - wait for it, do not restart");
    await w.flush();
    expect(sent[0]).toContain("was stopped by the loop guard: repeated identical tool call; escalating to anthropic-native as L2 (same branch) - wait for it, do not restart");
    unthrottle(w);
    w.onLoopStop("repeated identical tool call", "no escalation: the run ended without a continuation");
    await w.flush();
    expect(sent[1]).toContain("was stopped by the loop guard: repeated identical tool call; no escalation: the run ended without a continuation");
  });

  it("a loop-stop notice names the repeated call, its count and the result it kept getting, on one line", async () => {
    const sent: string[] = [];
    const msg = { toSession: async (_o: RunOrigin, t: string) => (sent.push(t), true) } as unknown as Messenger;
    const w = new TroubleWatcher("L1", "lbl", msg, {} as RunOrigin, "", () => now, async (_p, t) => msg.toSession({} as RunOrigin, t));
    const call = { tool: "Bash", input: "python3 - <<'EOF'\nprint(1)\nEOF", count: 4, result: "(Bash completed with no output)" };
    w.onLoopStop("loop guard: you ran this command 4 times with the same result. Stop repeating it. Edit a file", "no escalation: the run ended without a continuation", call);
    await w.flush();
    expect(sent[0]).toContain("Bash python3 - <<'EOF'⏎print(1)⏎EOF repeated 4x, always: (Bash completed with no output); no escalation: the run ended without a continuation");
    expect(sent[0]).not.toContain("Stop repeating it");
    expect(sent[0]).not.toContain("\n");
  });

  it("an edit tool with no recorded result is not reported as 'completed with no output' (the model saw 'updated successfully')", async () => {
    const sent: string[] = [];
    const msg = { toSession: async (_o: RunOrigin, t: string) => (sent.push(t), true) } as unknown as Messenger;
    const w = new TroubleWatcher("L2", "lbl", msg, {} as RunOrigin, "", () => now, async (_p, t) => msg.toSession({} as RunOrigin, t));
    w.onLoopStop("loop", "x", { tool: "Write", input: '{"file_path":"out/23.py"}', count: 12, result: "" });
    await w.flush();
    expect(sent[0]).toContain("repeated 12x, always: (result not recorded");
    expect(sent[0]).not.toContain("Write completed with no output");
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
    servers: async () => [{ pid: 400, label: "gyro:8080" }],
    signal: (pid, sig) => void sent.push(`${sig}:${pid}`),
    owns: () => true,
    self: 60,
    now: () => Date.now(),
    note: () => undefined,
  });
  beforeEach(() => {
    process.env.PAI_FREEZE_FILE = join(mkdtempSync(join(tmpdir(), "freeze-")), "freeze.json");
    delete process.env.PAI_WORKER;
    clearTestEnv();
    sent = [];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.PAI_FREEZE_FILE;
    else process.env.PAI_FREEZE_FILE = saved;
    clearTestEnv();
  });

  it("except-session plans exclude that session's tree (and its children and model server)", async () => {
    await freezeAll("/nonexistent-log", "t", undefined, deps(), undefined, { session: "caseleaf" });
    const stopped = sent.map((s) => Number(s.split(":")[1])).sort();
    expect(stopped).toEqual([300, 301]);
  });

  it("partial thaw keeps the others in the marker and the gate", async () => {
    await freezeAll("/nonexistent-log", "t", undefined, deps());
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

  it("--now passes the freeze gate", async () => {
    await freezeAll("/nonexistent-log", "t", undefined, deps());
    expect(freezeHold()).toMatch(/frozen/);
    expect(freezeHold(true)).toBeUndefined();
  });
});

// twice a proof froze the operator's LIVE model server with an isolated marker: the marker was
// isolated, discovery was not. Test mode is all-or-nothing — see workers/freeze.ts.
describe("test-mode isolation", () => {
  const saved = { file: process.env.PAI_FREEZE_FILE, w: process.env.PAI_WORKER, logdir: process.env.PAI_FREEZE_LOGDIR, servers: process.env.PAI_FREEZE_SERVERS };
  let sent: string[];
  let dir: string;
  // a worker tree (id L1) and a model server in the isolated world only
  const rows: ProcRow[] = [row(1, 0, "launchd"), row(50, 1, "pai daemon"), row(900, 1, "claude interactive"), row(100, 1, "pai worker run L1"), row(101, 100, "claude"), row(777, 1, "model-server")];
  const deps = (): FreezeDeps => ({
    procs: () => rows,
    statuses: (d) => (d === dir ? [st("L1", 100)] : (() => { throw new Error(`worker discovery read the real log dir ${d}`); })()),
    servers: async () => (await realFreezeDeps().servers()),
    signal: (pid, sig) => void sent.push(`${sig}:${pid}`),
    owns: () => true,
    self: 900,
    now: () => Date.now(),
    note: () => undefined,
  });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "freeze-iso-"));
    process.env.PAI_FREEZE_FILE = join(dir, "freeze.json"); // test mode: not the default marker
    delete process.env.PAI_WORKER;
    delete process.env.PAI_FREEZE_LOGDIR;
    delete process.env.PAI_FREEZE_SERVERS;
    sent = [];
  });
  afterEach(() => {
    for (const [k, v] of [["PAI_FREEZE_FILE", saved.file], ["PAI_WORKER", saved.w], ["PAI_FREEZE_LOGDIR", saved.logdir], ["PAI_FREEZE_SERVERS", saved.servers]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("is on only when the marker leaves the default location", () => {
    expect(freezeTestMode()).toBe(true);
    process.env.PAI_FREEZE_FILE = paiHomePath("state", "freeze.json");
    expect(freezeTestMode()).toBe(false); // the real marker: production mode (never touched here)
  });

  it("test mode without PAI_FREEZE_LOGDIR refuses — no real-config fallback", () => {
    expect(() => freezeLogDir()).toThrow(/PAI_FREEZE_LOGDIR/); // the CLI's log dir: refuse, never the real config
    expect(existsSync(process.env.PAI_FREEZE_FILE!)).toBe(false); // refused before any marker or signal
  });

  it("test mode never lists real servers: PAI_FREEZE_SERVERS is the whole list", async () => {
    expect(await realFreezeDeps().servers()).toEqual([]); // nothing listed: no config, no lsof, no probe
    process.env.PAI_FREEZE_SERVERS = "777:test-gyro, junk";
    expect(parseFreezeServers(process.env.PAI_FREEZE_SERVERS)).toEqual([{ pid: 777, label: "test-gyro" }]);
    process.env.PAI_FREEZE_LOGDIR = dir; // the isolation is all-or-nothing: with both set the freeze runs fully inside them
    const r = await freezeAll(freezeLogDir(), "t", undefined, deps()); // an unconfigured runtime is stopped by the default freeze
    expect(r.marker!.pids.map((e) => e.pid)).toEqual([100, 101, 777]); // the isolated tree + the listed pid, nothing else
    expect(sent).toContain("SIGSTOP:777");
  });

  it("workerAncestryBlocked: a worker anywhere in the chain is a refusal", () => {
    const pp = [{ pid: 1, ppid: 0 }, { pid: 100, ppid: 1 }, { pid: 101, ppid: 100 }, { pid: 202, ppid: 101 }];
    const owns = () => true;
    expect(workerAncestryBlocked(pp, [st("L1", 100)], 202, owns)).toEqual({ id: "L1", pid: 100 }); // the worker's runner three steps up
    expect(workerAncestryBlocked(pp, [st("L1", 100)], 900, owns)).toBeNull(); // an unrelated chain may freeze
    expect(workerAncestryBlocked(pp, [], 202, owns)).toBeNull(); // no status files: nothing claims these pids
    expect(workerAncestryBlocked(pp, [st("D1", 999, { state: "done", parentPid: 100 })], 202, owns)).toBeNull(); // finished worker whose parent is an ancestor
    expect(workerAncestryBlocked(pp, [st("D2", 100, { state: "done" })], 202, owns)).toBeNull(); // finished worker, recycled pid
    expect(workerAncestryBlocked(pp, [st("L2", 999, { parentPid: 100 })], 202, owns)).toBeNull(); // live worker's parent is not the worker
    expect(workerAncestryBlocked(pp, [st("L3", 100)], 202, () => false)).toBeNull(); // pid no longer owned by the status
  });

  it("test mode keeps the PAI_WORKER env guard (a worker could still stop its own machine)", async () => {
    process.env.PAI_WORKER = "1"; // test mode is on, and this is a worker: refused before anything is read or written
    await expect(freezeAll(dir, "t", undefined, deps())).rejects.toThrow(/cannot freeze/);
    expect(sent).toEqual([]);
  });

  it("outside test mode the guard takes the real log dir and the real ancestry (never a freeze)", () => {
    process.env.PAI_FREEZE_FILE = paiHomePath("state", "freeze.json"); // production mode — nothing below freezes anything
    expect(freezeLogDir()).not.toBe(dir); // the real config's log dir, not the isolated one: no fallback runs backwards either
    expect(freezeWorkerGuard([])).toBeUndefined(); // statuses injected (none here), ancestry read from the real ps: this test process hangs under launchd, no worker among its ancestors on this machine
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

// ---- deep freeze (`pai stop` / `pai resume`) ----
import { readFileSync } from "node:fs";
import { deepFreeze, deepResume, readDeepfreeze, deepfrozenIds, gitNoInput, gitNoInputSafe, resumeText, realDeepResumeDeps, type DeepFreezeDeps, type DeepResumeDeps } from "./deepfreeze.js";
import { loadStatus, saveStatus } from "./status.js";

describe("deep freeze", () => {
  let dir: string;
  let logDir: string;
  let prevFile: string | undefined;
  // git can never wait for input here: the shared helper adds GIT_TERMINAL_PROMPT=0 / GIT_EDITOR=true /
  // GIT_ASKPASS=echo + a temp HOME (no global config — the operator's core.editor=cursor and credential
  // helpers are what blocked the suite on 2026-11-18), `-c core.hooksPath=` (no repo hooks) and a 20 s SIGKILL
  // timeout; `git init` in an empty dir still inherits the global user.name/email.
  const git = (cwd: string, args: string[]): { ok: boolean; out: string } => gitNoInputSafe(cwd, args);
  // one repo per test call (unique name): no two tests share a repo, so no shared index.lock
  const mkRepo = (name: string): string => {
    const r = join(dir, name);
    mkdirSync(r, { recursive: true });
    git(r, ["init", "-q", "-b", "main"]);
    // the temp HOME drops the global config, so identity is set locally per repo
    git(r, ["config", "user.email", "t@t"]);
    git(r, ["config", "user.name", "t"]);
    writeFileSync(join(r, "a.txt"), "1");
    git(r, ["add", "-A"]);
    git(r, ["commit", "-q", "-m", "init"]);
    return r;
  };
  const worker = (id: string, started: string, extra: Partial<WorkerStatus> = {}): WorkerStatus =>
    ({ id, pid: 4242, label: `task ${id}`, cwd: dir, term: "", provider: "anthropic", model: "m", state: "running", started, updated: started, turns: 1, tools: 0, last: "", rc: null, secs: null, ...extra }) as WorkerStatus;
  const deps = (over: Partial<DeepFreezeDeps> = {}): DeepFreezeDeps => ({
    statuses: (d) => require_loadStatuses(d),
    owns: () => true,
    now: () => Date.UTC(2026, 10, 18, 12, 0, 0),
    git,
    stop: async () => undefined,
    stopModels: async () => ["gyro-l"],
    unfreeze: () => undefined,
    ledger: () => undefined,
    ...over,
  });
  let require_loadStatuses: (d: string) => WorkerStatus[];
  beforeEach(async () => {
    // a unique temp dir per test (mkdtemp's random suffix): tests never share a repo or a lock file
    dir = mkdtempSync(join(tmpdir(), "deepfreeze-"));
    logDir = join(dir, "logs");
    mkdirSync(logDir);
    prevFile = process.env.PAI_DEEPFREEZE_FILE;
    process.env.PAI_DEEPFREEZE_FILE = join(dir, "state", "deepfreeze.json");
    const m = await import("./status.js");
    require_loadStatuses = m.loadStatuses;
  });
  afterEach(() => {
    if (prevFile === undefined) delete process.env.PAI_DEEPFREEZE_FILE;
    else process.env.PAI_DEEPFREEZE_FILE = prevFile;
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the record and WIP-commits a dirty worktree, marks deepfrozen, stops models", async () => {
    const repo = mkRepo("repo");
    const wt = join(dir, "wt");
    git(repo, ["worktree", "add", "-q", "-b", "worker/w1", wt]);
    writeFileSync(join(wt, "new.txt"), "unsaved work");
    saveStatus(logDir, worker("w1", "2026-11-18 11:00:00", { worktreeDir: wt, branch: "worker/w1", priority: "high", goals: [{ text: "also X", at: "t" }] }));
    saveStatus(logDir, worker("w2", "2026-11-18 11:05:00", { state: "queued", promptFile: join(dir, "w2.prompt"), className: "impl" }));
    const stopped: string[] = [];
    const r = await deepFreeze(logDir, "tester", deps({ stop: async (_d, id) => void stopped.push(id) }));
    const rec = readDeepfreeze()!;
    expect(rec.workers.map((w) => [w.id, w.state, w.priority, w.order])).toEqual([["w1", "running", "high", 0], ["w2", "queued", "normal", 1]]);
    expect(rec.workers[1].spec).toBe(join(dir, "w2.prompt"));
    expect(rec.models).toEqual(["gyro-l"]);
    expect(stopped.sort()).toEqual(["w1", "w2"]);
    expect(gitNoInput(wt, ["log", "-1", "--format=%s"])).toMatch(/^wip: deepfreeze 2026-11-18T12-00-00-000Z/);
    expect(git(wt, ["status", "--porcelain"]).out).toBe("");
    expect(rec.workers[0].wip).toBe(git(wt, ["rev-parse", "HEAD"]).out.trim());
    expect(loadStatus(logDir, "w1")?.state).toBe("deepfrozen");
    expect(loadStatus(logDir, "w2")?.state).toBe("deepfrozen");
    expect(r.lines.join("\n")).toContain("deep-frozen 2 workers");
    expect(deepfrozenIds().has("w1")).toBe(true);
  });

  it("dry run lists and changes nothing", async () => {
    saveStatus(logDir, worker("w1", "2026-11-18 11:00:00"));
    const r = await deepFreeze(logDir, "t", deps({ stop: async () => { throw new Error("must not stop"); } }), { dryRun: true });
    expect(r.lines.join("\n")).toContain("would preserve running w1");
    expect(readDeepfreeze()).toBeNull();
    expect(loadStatus(logDir, "w1")?.state).toBe("running");
  });

  it("stop <id> / --session stop only the selection, keep the models running, and resume only the selection", async () => {
    saveStatus(logDir, worker("s1", "2026-11-18 11:00:00", { session: { name: "mdf" } as WorkerStatus["session"] }));
    saveStatus(logDir, worker("s2", "2026-11-18 11:01:00", { session: { name: "pai" } as WorkerStatus["session"] }));
    saveStatus(logDir, worker("s3", "2026-11-18 11:02:00", { session: { name: "pai" } as WorkerStatus["session"] }));
    const stopped: string[] = [];
    const d = deps({ stop: async (_d, id) => void stopped.push(id), stopModels: async () => { throw new Error("models must stay"); } });
    await deepFreeze(logDir, "t", d, { only: { ids: ["s1"] } });
    await deepFreeze(logDir, "t", d, { only: { session: "pai" } });
    expect(stopped.sort()).toEqual(["s1", "s2", "s3"]);
    expect(readDeepfreeze()!.workers.map((w) => w.id)).toEqual(["s1", "s2", "s3"]);
    const started: string[] = [];
    await deepResume(logDir, resumeDeps(started), { only: { ids: ["s1"] } });
    expect(started).toEqual(["s1"]);
    expect(readDeepfreeze()!.workers.map((w) => w.id)).toEqual(["s2", "s3"]);
    await deepResume(logDir, resumeDeps(started), { only: { session: "pai" } });
    expect(started).toEqual(["s1", "s2", "s3"]);
    expect(readDeepfreeze()).toBeNull();
  });

  it("a second deep freeze merges with a record not yet resumed: both workers stay, no duplicates, order after", async () => {
    saveStatus(logDir, worker("m1", "2026-11-18 11:00:00"));
    await deepFreeze(logDir, "first", deps());
    expect(loadStatus(logDir, "m1")?.state).toBe("deepfrozen");
    saveStatus(logDir, worker("m2", "2026-11-18 11:30:00"));
    await deepFreeze(logDir, "second", deps());
    const rec = readDeepfreeze()!;
    expect(rec.workers.map((w) => [w.id, w.order])).toEqual([["m1", 0], ["m2", 1]]);
    await deepFreeze(logDir, "third", deps()).catch(() => undefined);
    expect(readDeepfreeze()!.workers.map((w) => w.id)).toEqual(["m1", "m2"]);
  });

  const resumeDeps = (started: string[], over: Partial<DeepResumeDeps> = {}): DeepResumeDeps => ({
    statuses: (d) => require_loadStatuses(d),
    // the announce is not a start: stand in for a run that announced AND reached "running"
    start: async (_d, w) => {
      started.push(w.id);
      saveStatus(logDir, worker(`${w.id}-r`, "2026-11-18 13:00:00", { state: "running", provider: w.provider }));
      return `${w.id}-r`;
    },
    setPriority: () => undefined,
    ready: async () => true,
    sleep: async () => undefined,
    now: () => 0,
    notify: async () => undefined,
    ledger: () => undefined,
    ...over,
  });
  const freezeThree = async (): Promise<void> => {
    saveStatus(logDir, worker("a", "2026-11-18 11:00:00"));
    saveStatus(logDir, worker("b", "2026-11-18 11:01:00", { state: "queued", fallThroughTo: "b2" }));
    saveStatus(logDir, worker("b2", "2026-11-18 11:02:00", { state: "done", rc: 0 }));
    saveStatus(logDir, worker("c", "2026-11-18 11:03:00", { priority: "low" }));
    await deepFreeze(logDir, "t", deps({ statuses: (d) => require_loadStatuses(d).filter((s) => s.id !== "b2") }));
  };

  it("post-boot resume replays in order, skips an origin whose continuation finished, removes the record, tells the operator once", async () => {
    await freezeThree();
    const started: string[] = [];
    const told: string[] = [];
    const r = await deepResume(logDir, resumeDeps(started, { notify: async (t) => void told.push(t) }), { wait: true });
    expect(started).toEqual(["a", "c"]);
    expect(r.skipped).toEqual(["b"]);
    expect(readDeepfreeze()).toBeNull();
    expect(told).toHaveLength(1);
    expect(told[0]).toContain("started 2, queued 0");
  });

  it("waits for readiness (bounded) before resuming", async () => {
    await freezeThree();
    let polls = 0;
    let t = 0;
    const started: string[] = [];
    await deepResume(logDir, resumeDeps(started, { ready: async () => ++polls >= 3, now: () => t, sleep: async (ms) => void (t += ms) }), { wait: true });
    expect(polls).toBe(3);
    expect(started.length).toBe(2);
  });

  // live 2026-11-19: a resumed worker runs in the ORIGIN's worktree but carries a NEW
  // worker id, and built its edit paths from that id — a directory that does not exist.
  it("the resume continuation names the worktree it runs in, never one named after its own id", async () => {
    const w = {
      id: "w1", label: "task", project: "p", cwd: dir, branch: "worker/w1", worktreeDir: join(dir, "wt-origin"),
      provider: "anthropic", priority: "normal" as const, state: "running" as const, claudeSession: "s", goals: [], order: 0, children: [],
    };
    const text = resumeText(w);
    expect(text).toContain(`Your worktree: ${join(dir, "wt-origin")}`);
    expect(text).toContain("not a directory named after your (new) worker id");
    // the recorded tree is absent (the merge already removed it): no path is stated, still no id-derived path
    expect(resumeText({ ...w, worktreeDir: null })).not.toContain("Your worktree:");
  });

  it("a deep-resumed run restart names the origin worktree in its prompt", async () => {
    const spec = join(dir, "q.spec");
    writeFileSync(spec, "the task");
    const wt = join(dir, "wt-origin");
    mkdirSync(wt);
    const spawned: string[][] = [];
    vi.doMock("./reroute.js", () => ({
      startDetachedWorker: async (_d: string, args: string[]) => {
        spawned.push(args);
        return "new-id";
      },
    }));
    try {
      const d = await realDeepResumeDeps();
      const w = {
        id: "q", label: "task q", project: "p", cwd: dir, branch: null, worktreeDir: wt, spec,
        provider: "anthropic", priority: "normal" as const, state: "queued" as const, claudeSession: null, goals: [], order: 0, children: [],
      };
      await d.start(logDir, w, "continue the task");
      const args = spawned[0];
      expect(args[0]).toBe("run");
      const prompt = args[args.indexOf("-p") + 1];
      expect(prompt).toContain(`Your worktree: ${wt}`);
      expect(prompt).toContain("not a directory named after your own worker id");
      expect(prompt).toContain("continue the task");
    } finally {
      vi.doUnmock("./reroute.js");
    }
  });

  it("the record carries the worker's terminal and the resume start anchors its pane to it (status-file fallback for old records)", async () => {
    const spec = join(dir, "t.spec");
    writeFileSync(spec, "the task");
    saveStatus(logDir, worker("t1", "2026-11-18 11:00:00", { term: "w0t0p0:UUID-1", claudeSession: "cs" }));
    await deepFreeze(logDir, "t", deps());
    const w1 = readDeepfreeze()!.workers[0];
    expect(w1.term).toBe("w0t0p0:UUID-1");
    const calls: { args: string[]; env?: NodeJS.ProcessEnv }[] = [];
    vi.doMock("./reroute.js", () => ({
      startDetachedWorker: async (_d: string, args: string[], o: { env?: NodeJS.ProcessEnv }) => {
        calls.push({ args, env: o.env });
        return "new-id";
      },
    }));
    try {
      const d = await realDeepResumeDeps();
      await d.start(logDir, w1, "go on"); // resume branch
      expect(calls[0].args[0]).toBe("resume");
      expect(calls[0].env?.PAI_HOST_TERM).toBe("w0t0p0:UUID-1");
      const old = { ...w1, term: undefined, state: "queued" as const, claudeSession: null, spec };
      await d.start(logDir, old, "go on"); // run branch, record without term: the old status file answers
      expect(calls[1].args[0]).toBe("run");
      expect(calls[1].env?.PAI_HOST_TERM).toBe("w0t0p0:UUID-1");
      saveStatus(logDir, worker("t1", "2026-11-18 11:00:00", { term: "" }));
      await d.start(logDir, old, "go on"); // nowhere to anchor: no env, the start keeps its own refusal
      expect(calls[2].env).toBeUndefined();
    } finally {
      vi.doUnmock("./reroute.js");
    }
  });

  it("thaw --drop (drop) resumes nothing and discards the record", async () => {
    await freezeThree();
    const started: string[] = [];
    const r = await deepResume(logDir, resumeDeps(started), { drop: true });
    expect(started).toEqual([]);
    expect(readDeepfreeze()).toBeNull();
    expect(r.lines[0]).toContain("dropped");
  });

  it("a failed start stays in the record", async () => {
    await freezeThree();
    const r = await deepResume(logDir, resumeDeps([], { start: async (_d, w) => { if (w.id === "c") throw new Error("boom"); saveStatus(logDir, worker(`${w.id}-r`, "2026-11-18 14:00:00", { state: "running" })); return `${w.id}-r`; } }));
    expect(r.failed).toEqual(["c"]);
    expect(readDeepfreeze()!.workers.map((w) => w.id)).toEqual(["c"]);
    expect(readDeepfreeze()!.workers[0].resumeNote).toContain("boom"); // the reason travels with the entry
  });

  it("an announced run whose status never left deepfrozen is not resumed: kept in the record with its reason", async () => {
    await freezeThree();
    const r = await deepResume(logDir, resumeDeps([], { start: async (_d, w) => `${w.id}-r` })); // announces, no status ever written
    expect(r.started).toEqual([]);
    expect(r.queued).toEqual([]);
    expect(r.failed).toEqual(["a", "c"]);
    expect(readDeepfreeze()!.workers.map((w) => w.id)).toEqual(["a", "c"]);
    expect(readDeepfreeze()!.workers[0].resumeNote).toMatch(/status says no status/); // the announced run left nothing behind
  });

  it("9 entries at cap 3: 3 start, 6 queue on their tickets, record kept until all are started or queued", async () => {
    // nine workers frozen; one provider with cap 3 (the slot gate's accounting): the first three runs run,
    // the rest announce and park at the gate with their ticket. Stubs only — no real workers spawn.
    for (const i of "123456789") saveStatus(logDir, worker(`w${i}`, `2026-11-18 11:0${i}:00`, { provider: "gyro-l" }));
    await deepFreeze(logDir, "t", deps());
    const CAP = 3;
    const running = (): number => require_loadStatuses(logDir).filter((s) => s.state === "running").length;
    const r = await deepResume(logDir, resumeDeps([], {
      start: async (_d, w) => {
        // the real gateStart announces before the gates wait: a run past the cap stays queued at the gate
        if (running() < CAP) saveStatus(logDir, worker(`${w.id}-r`, "2026-11-18 14:00:00", { state: "running", provider: w.provider }));
        else mkdirSync(join(logDir, "queue", "gyro-l"), { recursive: true }), writeFileSync(join(logDir, "queue", "gyro-l", `${w.id}-r`), `${process.pid} @0`); // the gate's ticket (writeTicket)
        return `${w.id}-r`;
      },
    }));
    expect(r.started.length).toBe(3);
    expect(r.queued.length).toBe(6);
    expect(r.failed).toEqual([]);
    expect(r.resumed.length).toBe(9); // started or queued = resumed
    expect(readDeepfreeze()).toBeNull(); // every entry took: the record is gone, truthfully this time
  });

  it("an announced run that never takes (status stays deepfrozen) keeps the record even when the others queue", async () => {
    saveStatus(logDir, worker("x1", "2026-11-18 11:00:00"));
    saveStatus(logDir, worker("x2", "2026-11-18 11:01:00"));
    await deepFreeze(logDir, "t", deps());
    const r = await deepResume(logDir, resumeDeps([], {
      start: async (_d, w) => {
        if (w.id === "x2") mkdirSync(join(logDir, "queue", "anthropic"), { recursive: true }), writeFileSync(join(logDir, "queue", "anthropic", `${w.id}-r`), `${process.pid} @0`); // queued at the gate's ticket
        return `${w.id}-r`; // x1 announces and never starts — the 2026-11-19 failure mode
      },
    }));
    expect(r.started).toEqual([]);
    expect(r.queued).toEqual(["x2->x2-r"]);
    expect(r.failed).toEqual(["x1"]);
    const rec = readDeepfreeze()!; // the record survives with only the entry that did not take
    expect(rec.workers.map((w) => w.id)).toEqual(["x1"]);
    expect(rec.workers[0].resumeNote).toMatch(/status says no status/);
  });

  it("deepfrozen workers trigger no failure, stall or escalation", async () => {
    const s = worker("w1", "2026-11-18 10:00:00", { state: "deepfrozen", pid: 999999, spawnerSession: "sess", session: { id: "i", name: "n" }, rc: null, updated: "2026-11-18 10:00:00" });
    const ev = await detectSupervisionEvents([s], { now: new Date("2026-11-18 14:00:00"), stallMs: 60_000, isAlive: () => false });
    expect(ev).toEqual([]);
    expect(escalationReason(s, Date.parse("2026-11-18T14:00:00"))).toBeNull();
  });
});

import { armDeadline } from "./deadline.js";
import { ownMsOf } from "./freeze.js";
import type { SchedSnapshot } from "../router/scheduler.js";

describe("one own-time clock: stall alert and time budget", () => {
  const M = 60_000;
  const quiet = st("OT1", 100, { updated: "2026-11-19 10:00:00", turns: 3, spawnerSession: "own" });
  const at = new Date("2026-11-19 10:15:00"); // 15 min without a turn
  const base = { stallMs: 10 * M, now: at, isAlive: () => true };
  const sched = (waitingSince: number): SchedSnapshot => ({ at: at.getTime(), engines: {}, workers: { OT1: { waitMsTotal: 0, waitingSince } } as unknown as SchedSnapshot["workers"] });

  it("ownMsOf subtracts in-line time from the spell", () => {
    expect(ownMsOf("none", 0, 20 * M, 15 * M, 0)).toBe(5 * M);
  });

  it("stall alert: silent while in line the whole quiet spell, as today without the line", async () => {
    expect(await detectSupervisionEvents([quiet], { ...base, sched: sched(Date.parse("2026-11-19 10:00:00")) })).toEqual([]);
    expect((await detectSupervisionEvents([quiet], base)).map((e) => e.kind)).toEqual(["stalled"]);
  });

  it("budget checkpoint: 15 min in line + 5 min work does not fire at 20 min wall", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      let inLine = 0;
      let fired = 0;
      const proc = { kill: () => true, exitCode: null, signalCode: null };
      armDeadline(proc, { deadlineAt: 20 * M, minutes: 20 }, () => { fired++; }, undefined, () => inLine, Date.now, { active: async () => false, factor: () => 1 });
      inLine = 15 * M; // 15 min of the allowance spent in line
      vi.advanceTimersByTime(20 * M);
      expect(fired).toBe(0); // 20 min wall, 5 own
      vi.advanceTimersByTime(14 * M);
      expect(fired).toBe(0);
      vi.advanceTimersByTime(2 * M);
      expect(fired).toBe(1); // 20 own min reached at 35 wall
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("system sleep is not work time (sleep-clock)", () => {
  it("wall +600s / mono +1s: gap recorded, ledger line once, progress clock does not burn", async () => {
    const { detectSleepGap, resetSleepTick, sleepMsBetween } = await import("./sleep-clock.js");
    const { readFileSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "sleep-"));
    process.env.PAI_SLEEP_FILE = join(dir, "sleep.json");
    try {
      resetSleepTick();
      const t0 = 1_800_000_000_000;
      expect(detectSleepGap(t0, 1000, dir)).toBeNull();
      expect(detectSleepGap(t0 + 600_000, 2000, dir)?.ms).toBe(599_000);
      expect(detectSleepGap(t0 + 601_000, 3000, dir)).toBeNull();
      const lines = readFileSync(join(dir, "ledger.log"), "utf8").split("\n").filter((l) => l.includes("MACHINE-SLEEP"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/from=\d+ to=\d+ seconds=599/);
      expect(sleepMsBetween(t0, t0 + 601_000)).toBe(600_000);
      expect(activeMsOf("w-sleep-test", t0, t0 + 601_000)).toBe(1_000);
    } finally {
      delete process.env.PAI_SLEEP_FILE;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stall monitor labels sleep and saves no profile", async () => {
    const { resetSleepTick } = await import("./sleep-clock.js");
    const { startStallMonitor } = await import("../router/stall.js");
    const dir = mkdtempSync(join(tmpdir(), "sleep-"));
    process.env.PAI_SLEEP_FILE = join(dir, "sleep.json");
    try {
      resetSleepTick();
      let wall = 1_800_000_000_000;
      let mono = 0;
      const logs: string[] = [];
      let stalls = 0;
      const m = startStallMonitor({ tickMs: 5, thresholdMs: 100, now: () => wall, mono: () => mono, log: (l) => logs.push(l), onStall: () => void stalls++, logDir: dir });
      await new Promise((r) => setTimeout(r, 12));
      wall += 600_000;
      mono += 1_000;
      await new Promise((r) => setTimeout(r, 30));
      m.stop();
      expect(logs.some((l) => l.includes("system sleep"))).toBe(true);
      expect(stalls).toBe(0);
    } finally {
      delete process.env.PAI_SLEEP_FILE;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("workerRunLabel (toolerror hint label)", () => {
  it("names the cloud provider/model of the worker", () => {
    expect(workerRunLabel({ provider: "anthropic", model: "sonnet-5.5" }, () => false)).toBe("anthropic/sonnet-5.5");
  });
  it("says local model only for a local provider", () => {
    expect(workerRunLabel({ provider: "signal-2", model: "flash" }, (n) => n === "signal-2")).toBe("local model: flash");
  });
});
