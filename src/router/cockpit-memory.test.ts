import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cockpitMemoryPayload, resetMemoryStale, memoryJobProgress, runProgress, type DaemonMemory, type MemoryDeps } from "./cockpit-memory.js";
import { defaultDeps, memoryRunRefusal, readCockpitJob, runCockpitAction, type ActionDeps } from "./cockpit-actions.js";
import { COCKPIT_HTML } from "./cockpit-page.js";
import { cockpitLayout } from "./cockpit-layout.js";
import { WIN_MEMORY_JS } from "./cockpit-page/win/cards-memory.js";
import { lessonsDir, serializeLesson, type LessonState } from "../memory/lessons.js";
import { acquireRun, readFinishedRun, readRun, runStateFile, type RunState } from "../memory/run-state.js";

let home = "";
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pai-cockpit-memory-"));
  resetMemoryStale();
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const NOW = Date.parse("2026-10-21T12:00:00Z");

function status(over: Record<string, unknown> = {}): DaemonMemory["status"] {
  return {
    generatedAt: NOW,
    level: "green",
    reason: "all systems healthy",
    daemon: { pid: 1, uptimeSecs: 10, version: "1", storage: "postgres" },
    index: {
      level: "green", files: 500, chunks: 2_000_000, embedded: 1_877_697, coverage: 0.9388, countsExact: true, countsAt: NOW, segments: null,
      binding: null, configured: { backend: "ollama-f16", model: "arctic", dims: 768 }, mismatch: false, hint: null, error: null,
    },
    jobs: [],
    passes: [],
    backend: { level: "green", id: "ollama-f16", model: "arctic", available: true, reason: "ready", loaded: null },
    ...over,
  } as unknown as DaemonMemory["status"];
}

function daemon(over: Partial<DaemonMemory> = {}): DaemonMemory {
  return {
    status: status(),
    embedBacklog: 122_303,
    maintenanceHour: 3,
    indexIntervalSecs: 86400,
    embedIntervalSecs: 86400,
    embedMaxMinutes: 60,
    lastIndexPass: { at: NOW - 3600_000, durationMs: 95_000, projects: 12, files: 40, chunks: 300 },
    lastEmbedPass: { at: NOW - 1800_000, durationMs: 3_600_000, outcome: "budget", embedded: 9000 },
    ...over,
  };
}

function deps(over: Partial<MemoryDeps> = {}): MemoryDeps {
  return { daemon: async () => daemon(), run: () => null, home, now: () => NOW, ...over };
}

function run(over: Partial<RunState> = {}): RunState {
  return {
    kind: "embed", pid: 4242, by: "cockpit", startedAt: new Date(NOW - 100_000).toISOString(), backlogStart: 122_303, done: 1000,
    updatedAt: new Date(NOW - 10_000).toISOString(), jobId: "", ...over,
  };
}

describe("memory payload", () => {
  it("carries counts, backlog, backend, passes and schedule from the injected daemon data", async () => {
    const p = (await cockpitMemoryPayload(deps())) as any;
    expect(p.counts).toMatchObject({ files: 500, chunks: 2_000_000, embedded: 1_877_697, backlog: 122_303, exact: true });
    expect(p.counts.coverage).toBeCloseTo(0.9388, 4);
    expect(p.backend).toMatchObject({ id: "ollama-f16", model: "arctic", dims: 768, available: true });
    expect(p.lastIndex).toEqual({ at: NOW - 3600_000, durationSec: 95, files: 40, chunks: 300 });
    expect(p.lastEmbed).toMatchObject({ durationSec: 3600, chunks: 9000, outcome: "budget" });
    expect(p.schedule).toMatchObject({ maintenanceHour: 3 });
    expect(p.title).toBe(cockpitLayout().memoryTitle);
    expect(p.run).toBeNull();
  });

  it("colours coverage from the layout thresholds, not literals", async () => {
    const L = cockpitLayout();
    const at = async (coverage: number) => ((await cockpitMemoryPayload(deps({ daemon: async () => daemon({ status: status({ index: { ...status()!.index, coverage } }) }) }))) as any).counts.coverageLevel;
    expect(await at(L.memoryCoverageWarn + 0.001)).toBe("green");
    expect(await at((L.memoryCoverageWarn + L.memoryCoverageBad) / 2)).toBe("amber");
    expect(await at(L.memoryCoverageBad - 0.1)).toBe("red");
  });

  it("derives the backlog from chunks and vectors when the daemon did not count it, and reads red when the daemon is down", async () => {
    const p = (await cockpitMemoryPayload(deps({ daemon: async () => daemon({ embedBacklog: null }) }))) as any;
    expect(p.counts.backlog).toBe(2_000_000 - 1_877_697);
    resetMemoryStale();
    const down = (await cockpitMemoryPayload(deps({ daemon: async () => null }))) as any;
    expect(down).toMatchObject({ daemon: false, level: "red", reason: "daemon not answering" });
    expect(down.counts.backlog).toBeNull();
  });

  it("marks a payload transient when the daemon does not answer or the binding check failed, and only then", async () => {
    expect(((await cockpitMemoryPayload(deps())) as any).transient).toBeUndefined();
    const down = (await cockpitMemoryPayload(deps({ daemon: async () => null }))) as any;
    expect(down.transient).toBe("daemon not answering");
    const bad = (await cockpitMemoryPayload(deps({ daemon: async () => daemon({ status: status({ index: { ...status()!.index, error: "probe timed out" } }) }) }))) as any;
    expect(bad.transient).toBe("binding check: probe timed out");
  });

  it("reports the running run with progress and the last finished job's message", async () => {
    writeFileSync(join(home, "x"), "");
    mkdirSync(`${home}/cockpit-jobs`, { recursive: true });
    writeFileSync(`${home}/cockpit-jobs/aa.json`, JSON.stringify({ id: "aa", kind: "memory", tier: "", what: "index", state: "done", message: "index finished", at: new Date(NOW - 5000).toISOString() }));
    const p = (await cockpitMemoryPayload(deps({ run: () => run() }))) as any;
    expect(p.run).toMatchObject({ kind: "embed", by: "cockpit", done: 1000, backlogStart: 122_303, stoppable: true });
    expect(p.lastRun).toEqual({ op: "index", ok: true, message: "index finished", at: new Date(NOW - 5000).toISOString() });
  });
});

describe("a run whose process died", () => {
  it("shows once as 'ended unexpectedly' in its Last-run card, not as a live run", async () => {
    const p = (await cockpitMemoryPayload(deps({ deadRun: () => run({ kind: "index", done: 0, backlogStart: null }) }))) as any;
    expect(p.run).toBeNull();
    const last = p.jobs.filter((j: any) => j.finished);
    expect(last).toHaveLength(1);
    expect(last[0]).toMatchObject({ id: "last-index", finished: { outcome: "failed" } });
    expect(last[0].finished.reason).toMatch(/^ended unexpectedly at \d\d:\d\d:\d\d$/);
    expect(p.jobs.filter((j: any) => !j.finished)).toHaveLength(0);
  });
  it("is superseded by a later finished record of the same kind", async () => {
    const fin = { kind: "index" as const, by: "cli" as const, startedAt: new Date(NOW - 50_000).toISOString(), endedAt: new Date(NOW - 20_000).toISOString(), backlogStart: null, done: 5, outcome: "done" as const, reason: "" };
    const p = (await cockpitMemoryPayload(deps({ deadRun: () => run({ kind: "index", startedAt: new Date(NOW - 100_000).toISOString() }), finished: (k) => (k === "index" ? fin : null) }))) as any;
    expect(p.jobs.filter((j: any) => j.finished).map((j: any) => j.finished.outcome)).toEqual(["done"]);
  });
});

describe("run progress", () => {
  it("computes elapsed, rate over the time to the last update, and the ETA from the backlog at start", () => {
    const pr = runProgress(run(), NOW, home);
    expect(pr.elapsedSec).toBe(100);
    // 1000 chunks in the 90 s up to the last update
    expect(pr.rate).toBeCloseTo(11.1, 1);
    expect(pr.etaSec).toBe(Math.round((122_303 - 1000) / (1000 / 90)));
  });

  it("has no rate or ETA before the first chunk, and none without a backlog (index)", () => {
    expect(runProgress(run({ done: 0 }), NOW, home)).toMatchObject({ rate: null, etaSec: null });
    expect(runProgress(run({ kind: "index", backlogStart: null, done: 50 }), NOW, home).etaSec).toBeNull();
  });

  it("marks a daemon pass not stoppable and reads the log's last line for a cockpit run", () => {
    expect(runProgress(run({ by: "daemon" }), NOW, home).stoppable).toBe(false);
    mkdirSync(`${home}/state`, { recursive: true });
    writeFileSync(`${home}/state/memory-run.log`, "starting\n  5000 / 122303 chunks embedded...\n");
    expect(runProgress(run(), NOW, home).tail).toBe("5000 / 122303 chunks embedded...");
    expect(runProgress(run({ by: "cli" }), NOW, home).tail).toBe("");
  });

  it("gives a running memory job its elapsed seconds and the log tail for /cockpit/job", () => {
    mkdirSync(`${home}/state`, { recursive: true });
    writeFileSync(`${home}/state/memory-run.log`, "a\nlast line\n");
    const j = { id: "j", kind: "memory" as const, tier: "", state: "running" as const, message: "", at: new Date(NOW - 7000).toISOString() };
    expect(memoryJobProgress(home, j, NOW)).toEqual({ elapsedSec: 7, tail: "last line" });
    expect(memoryJobProgress(home, { ...j, state: "done" }, NOW)).toBeNull();
  });
});

describe("run marker", () => {
  it("is taken once, refuses a second holder, shows progress and is removed on release", () => {
    const a = acquireRun("embed", { home, by: "cli", minGapMs: 0 });
    expect(a).not.toBeNull();
    // this process holds it: a live pid
    a!.setBacklog(500);
    a!.progress(120);
    expect(readRun(home)).toMatchObject({ kind: "embed", by: "cli", backlogStart: 500, done: 120, pid: process.pid });
    a!.release();
    expect(readRun(home)).toBeNull();
  });

  it("ignores a marker whose pid is gone", () => {
    mkdirSync(`${home}/state`, { recursive: true });
    writeFileSync(runStateFile(home), JSON.stringify(run({ pid: 999_999 })));
    expect(readRun(home, () => false)).toBeNull();
    expect(readRun(home, () => true)).not.toBeNull();
  });
});

function actDeps(over: Partial<ActionDeps> = {}): ActionDeps {
  return { ...defaultDeps(), home, ledger: join(home, "ledger.log"), readRun: () => null, daemonMemoryBusy: async () => null, killRun: () => {}, ...over };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("memory actions", () => {
  it("memory.embed creates a job, runs the memory job and records its result", async () => {
    const ran: string[] = [];
    const r = await runCockpitAction({ action: "memory.embed" }, actDeps(), { runMemoryJob: async (kind) => { ran.push(kind); return { ok: true, message: "122303 chunks embedded" }; } });
    expect(r.ok).toBe(true);
    expect(r.jobId).toMatch(/^[0-9a-f]+$/);
    await settle();
    expect(ran).toEqual(["embed"]);
    expect(readCockpitJob(home, r.jobId!)).toMatchObject({ kind: "memory", what: "embed", state: "done", message: "122303 chunks embedded" });
  });

  it("memory.index runs the index kind; a failed run reads failed with its message", async () => {
    const r = await runCockpitAction({ action: "memory.index" }, actDeps(), { runMemoryJob: async () => ({ ok: false, message: "index ended (1)" }) });
    await settle();
    expect(readCockpitJob(home, r.jobId!)).toMatchObject({ what: "index", state: "failed", message: "index ended (1)" });
  });

  it("refuses a second run while a marker is live (CLI, daemon pass or cockpit), naming who started it", async () => {
    let called = 0;
    const hooks = { runMemoryJob: async () => { called++; return { ok: true, message: "" }; } };
    for (const by of ["cli", "daemon", "cockpit"] as const) {
      const r = await runCockpitAction({ action: "memory.embed" }, actDeps({ readRun: () => run({ by }) }), hooks);
      expect(r).toMatchObject({ ok: false, message: `embed already running (started by ${by}, pid 4242)` });
    }
    expect(called).toBe(0);
  });

  it("refuses while a cockpit job is still starting and while the daemon's own pass runs", async () => {
    const first = await runCockpitAction({ action: "memory.index" }, actDeps(), { runMemoryJob: () => new Promise(() => {}) });
    expect(first.ok).toBe(true);
    const second = await runCockpitAction({ action: "memory.embed" }, actDeps(), { runMemoryJob: async () => ({ ok: true, message: "" }) });
    expect(second.ok).toBe(false);
    expect(second.message).toContain(`already starting (job ${first.jobId})`);
    rmSync(`${home}/cockpit-jobs`, { recursive: true, force: true });
    expect(await memoryRunRefusal(actDeps({ daemonMemoryBusy: async () => "embed already running (started by daemon)" }))).toBe("embed already running (started by daemon)");
  });

  it("memory.stop signals the run's pid, refuses the daemon's pass and an idle system", async () => {
    const killed: number[] = [];
    const ok = await runCockpitAction({ action: "memory.stop" }, actDeps({ readRun: () => run(), killRun: (p) => killed.push(p) }));
    expect(ok).toMatchObject({ ok: true });
    expect(killed).toEqual([4242]);
    expect((await runCockpitAction({ action: "memory.stop" }, actDeps({ readRun: () => run({ by: "daemon" }) }))).ok).toBe(false);
    expect(await runCockpitAction({ action: "memory.stop" }, actDeps())).toMatchObject({ ok: false, message: "nothing running" });
    expect(readdirSync(home)).toContain("ledger.log");
    expect(readFileSync(join(home, "ledger.log"), "utf8")).toContain("memory.stop");
  });
});

/** The page functions of the Memory section, evaluated from the served page. */
/** The memory view functions of the window runtime (win/cards-memory.ts) run in isolation on a payload: the cards' text
 *  as one string, the group's actions with their enabled-or-reason, the running pill. */
function pageFns() {
  const helpers = COCKPIT_HTML.match(/var mem=null[\s\S]*?(?=function loadMemory)/)![0];
  const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const fmt = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(Math.round(n)));
  const fns = new Function("esc", "fmt", `${helpers}\n${WIN_MEMORY_JS}\nreturn {memKvView, memMetricView, MEM_ACTS, memPillText};`)(esc, fmt) as {
    memKvView: (m: unknown) => { v: string; s: string; t?: string; status: string[] };
    memMetricView: (m: unknown, ctx: { id: string }) => { v: string; u: string; s: string; x: string; status: string[] | null };
    MEM_ACTS: [string, string, string, (m: unknown) => true | string][];
    memPillText: (m: unknown) => string;
  };
  return {
    /** Every memory card's text: the status card, the four metric cards and one per job. */
    memHtml: (m: any, only?: string[]) => {
      const kv = fns.memKvView(m);
      const parts = [kv.v, kv.s, kv.t ?? "", kv.status.join(" ")];
      for (const id of only ?? ["index", "backend", "passes", "lessons", "daemon", ...(m.jobs ?? []).map((j: any) => "job:" + j.id)]) {
        const v = fns.memMetricView(m, { id: "memory." + id });
        parts.push(v.v, v.u, v.s, v.x, ...(v.status ?? []));
      }
      return parts.join("\n");
    },
    /** The group's actions: true when enabled, else the reason shown in the tooltip. */
    memActs: (m: unknown) => Object.fromEntries(fns.MEM_ACTS.map((a) => [a[0], a[3](m)])) as Record<string, true | string>,
    memKv: fns.memKvView,
    memRunPill: fns.memPillText,
  };
}

describe("memory section page", () => {
  it("is on the page with its configured title and a poll interval from the layout", () => {
    expect(COCKPIT_HTML).toContain('{id:"memory",type:"group",title:"Memory"');
    expect(COCKPIT_HTML).toContain(`setInterval(loadMemory,${cockpitLayout().memoryPollMs})`);
  });

  it("renders the live numbers: counts, backlog, backend and model, last passes, nightly schedule", async () => {
    const m = await cockpitMemoryPayload(deps());
    const f = pageFns();
    const h = f.memHtml(m);
    expect(h).toContain("missing 122.3k");
    expect(h).toContain("ollama-f16");
    expect(h).toContain("arctic");
    expect(h).toContain("nightly maintenance at 03:00");
    expect(f.memActs(m)).toMatchObject({ embed: true, index: true }); // not disabled
    expect(f.memActs(m).stop).toBe("nothing to stop"); // no stop on an idle system
  });

  it("shows the busy state: run line with progress, buttons disabled, stop offered, started by named", async () => {
    const m = await cockpitMemoryPayload(deps({ run: () => run() }));
    const f = pageFns();
    const h = f.memHtml(m);
    expect(h).toContain("embed running (started by cockpit)");
    expect(h).toContain("1.0k / 122.3k chunks (0.8%)");
    expect(h).toContain("ETA");
    expect(f.memActs(m)).toMatchObject({ embed: "a run is in progress", index: "a run is in progress", stop: true });
    // a daemon pass: busy, but no stop
    const dm = await cockpitMemoryPayload(deps({ run: () => run({ by: "daemon" }) }));
    expect(f.memHtml(dm)).toContain("started by daemon");
    expect(f.memActs(dm).stop).toBe("nothing to stop");
  });
});

describe("memory payload: tiles data", () => {
  const L = cockpitLayout();
  const hist = (n: number, step: number, per: number) => Array.from({ length: n }, (_, i) => ({ t: NOW - (n - i) * step * 1000, done: i * per }));

  it("carries segments, bound vs configured with the hint, and the daemon fields", async () => {
    const st = status({
      daemon: { pid: 77, uptimeSecs: 3700, version: "9.9.9", storage: "pg" },
      index: {
        ...status()!.index, segments: { fresh: 100, old: 800, missing: 100 },
        binding: { backend: "backend-a", model: "model-a", dims: 4 }, configured: { backend: "backend-b", model: "model-b", dims: 8 }, mismatch: true, hint: "re-embed in progress", error: null,
      },
      jobs: [{ name: "backend-b-reembed", phase: "embed", done: 100, total: 1000, rate: 2, etaSecs: 450, lastProgressAt: NOW - 1000, stalled: false, level: "green", history: [] }],
    });
    const p = (await cockpitMemoryPayload(deps({ daemon: async () => daemon({ status: st }) }))) as any;
    expect(p.segments).toEqual({ fresh: 100, old: 800, missing: 100 });
    expect(p.reembedding).toBe(true);
    expect(p.binding).toMatchObject({ mismatch: true, hint: "re-embed in progress", bound: { backend: "backend-a", model: "model-a" }, configured: { backend: "backend-b", model: "model-b", dims: 8 } });
    expect(p.daemonInfo).toEqual({ pid: 77, uptimeSecs: 3700, version: "9.9.9", storage: "pg" });
  });

  it("derives the backend gpu share and loaded model", async () => {
    const st = status({ backend: { level: "green", id: "b", model: "m", available: true, reason: "ready", loaded: [{ name: "other:1", size: 10, sizeVram: 10, gpuShare: 1 }, { name: "m:latest", size: 10, sizeVram: 8, gpuShare: 0.8 }] } });
    const p = (await cockpitMemoryPayload(deps({ daemon: async () => daemon({ status: st }) }))) as any;
    expect(p.backend).toMatchObject({ loadedModel: "m:latest", gpuShare: 0.8, available: true });
  });

  it("job tile: pct, rate, ETA, done-at, per-interval rate series bounded by the layout", async () => {
    const h = hist(L.memoryHistoryLen + 20, 30, 15);
    const st = status({ jobs: [{ name: "x-reembed", phase: "embed", done: 500, total: 1000, rate: 0.5, etaSecs: 1000, lastProgressAt: NOW - 5000, stalled: false, level: "green", history: h }] });
    const p = (await cockpitMemoryPayload(deps({ daemon: async () => daemon({ status: st }) }))) as any;
    const j = p.jobs[0];
    expect(j).toMatchObject({ kind: "reembed", name: "x-reembed", pct: 50, rate: 0.5, etaSec: 1000, doneAt: NOW + 1_000_000, stalled: false });
    expect(j.series).toHaveLength(L.memoryHistoryLen);
    expect(j.series.every((v: number) => v === 0.5)).toBe(true);
  });

  it("stalls a job after the layout stall time, not the daemon's", async () => {
    const mk = (age: number) => status({ jobs: [{ name: "x-reembed", phase: "embed", done: 5, total: 10, rate: null, etaSecs: null, lastProgressAt: NOW - age * 1000, stalled: false, level: "green", history: [] }] });
    const at = async (age: number) => (await cockpitMemoryPayload(deps({ daemon: async () => daemon({ status: mk(age) }) }))) as any;
    expect((await at(L.memoryStallSecs - 1)).jobs[0].stalled).toBe(false);
    const p = await at(L.memoryStallSecs + 1);
    expect(p.jobs[0].stalled).toBe(true);
    expect(p.level).toBe("red");
    expect(p.reason).toContain("stalled");
  });

  it("a running embed run becomes a job tile with backlog total, history-based rate series and stall", async () => {
    let t = NOW;
    const d = deps({ run: () => run({ done: 0 }), now: () => t });
    await cockpitMemoryPayload(d);
    t += 10_000;
    const d2 = deps({ run: () => run({ done: 100 }), now: () => t });
    const p = (await cockpitMemoryPayload(d2)) as any;
    const j = p.jobs.find((x: any) => x.kind === "embed");
    expect(j).toMatchObject({ done: 100, total: 122_303, by: "cockpit", stalled: false });
    expect(j.series).toEqual([10]);
    expect(j.lastProgressAt).toBe(t);
    t += (L.memoryStallSecs + 1) * 1000;
    const p3 = (await cockpitMemoryPayload(deps({ run: () => run({ done: 100 }), now: () => t }))) as any;
    expect(p3.jobs.find((x: any) => x.kind === "embed").stalled).toBe(true);
  });

  it("passes carry next run, failure with retry or gave-up, and the embed pass log detail; vault is left out", async () => {
    const st = status({
      passes: [
        { name: "index", running: false, lastEnd: NOW - 1000, nextAt: NOW + 5000, failure: null, level: "green" },
        { name: "embed", running: false, lastEnd: NOW - 2000, nextAt: NOW + 9000, failure: { at: NOW - 500, error: "boom", attempts: 2, gaveUp: false, retryAt: NOW + 60_000 }, level: "red" },
        { name: "vault", running: false, lastEnd: 0, nextAt: null, failure: null, level: "green" },
      ],
    });
    const p = (await cockpitMemoryPayload(deps({
      daemon: async () => daemon({ status: st }),
      embedPasses: () => [{ start: NOW - 9000, end: NOW - 2000, embedded: 321, backlogLeft: 55, stopReason: "pass-budget" }],
    }))) as any;
    expect(p.passes.map((x: any) => x.name)).toEqual(["index", "embed"]);
    expect(p.passes[0]).toMatchObject({ state: "ok", nextAt: NOW + 5000, detail: null });
    expect(p.passes[1]).toMatchObject({ state: "failed", failure: { error: "boom", retryAt: NOW + 60_000 }, detail: { embedded: 321, backlogLeft: 55, stopReason: "pass-budget" } });
  });
});

describe("memory faults: backend tile, pass merge, kept finished run, empty backlog", () => {
  const emb = (over: Record<string, unknown> = {}) => status({ backend: { level: "green", id: "rt", model: "embed-m", available: true, reason: "ready", loaded: [
    { name: "chat-x:8b", size: 100, sizeVram: 100, gpuShare: 1 }, { name: "embed-m:latest", size: 10, sizeVram: 7, gpuShare: 0.7 }], ...over } });
  const pay = async (st: DaemonMemory["status"], o: Partial<MemoryDeps> = {}) => (await cockpitMemoryPayload(deps({ daemon: async () => daemon({ status: st }), ...o }))) as any;
  const fin = (over: Record<string, unknown> = {}) => ({ kind: "embed" as const, by: "cockpit" as const, startedAt: new Date(NOW - 600_000).toISOString(), endedAt: new Date(NOW - 300_000).toISOString(), backlogStart: 600, done: 600, outcome: "done" as const, reason: "", ...over });

  it("backend picks the loaded entry of the configured model (tag-tolerant), not the first; others are 'also loaded'", async () => {
    const p = await pay(emb());
    expect(p.backend).toMatchObject({ loadedModel: "embed-m:latest", gpuShare: 0.7, alsoLoaded: ["chat-x:8b"] });
    const h = pageFns().memHtml(p);
    expect(h).toContain("loaded: embed-m:latest");
    expect(h).toContain("also loaded: chat-x:8b");
    expect(h).not.toMatch(/(^|>)loaded: chat-x/);
  });

  it("backend says '<model> (not loaded)' when only other models are loaded", async () => {
    const p = await pay(emb({ loaded: [{ name: "chat-x:8b", size: 1, sizeVram: 1, gpuShare: 1 }] }));
    expect(p.backend).toMatchObject({ loadedModel: null, gpuShare: null, alsoLoaded: ["chat-x:8b"] });
    const h = pageFns().memHtml(p);
    expect(h).toContain("embed-m (not loaded)");
    expect(h).toContain("also loaded: chat-x:8b");
  });

  it("a finished cockpit embed run counts as the last pass: newest wins over the daemon data, with who started it", async () => {
    const st = status({ passes: [{ name: "embed", running: false, lastEnd: NOW - 86_400_000, nextAt: null, failure: null }, { name: "index", running: false, lastEnd: NOW - 3600_000, nextAt: null, failure: null }] });
    const p = await pay(st, { finished: (k) => (k === "embed" ? fin({ done: 1234 }) : null) });
    const e = p.passes.find((x: any) => x.name === "embed");
    expect(e.last).toEqual({ at: NOW - 300_000, chunks: 1234, result: "done", by: "cockpit" });
    expect(e.lastEnd).toBe(NOW - 300_000);
    expect(p.passes.find((x: any) => x.name === "index").last).toMatchObject({ at: NOW - 3_600_000, by: "nightly" });
    const h = pageFns().memHtml(p);
    expect(h).toContain("1.2k chunks · done · by cockpit");
    expect(h).not.toContain("none since start");
  });

  it("an older finished run does not displace a newer scheduled pass", async () => {
    const st = status({ passes: [{ name: "embed", running: false, lastEnd: NOW - 1000, nextAt: null, failure: null }] });
    const p = await pay(st, { finished: () => fin({ endedAt: new Date(NOW - 900_000).toISOString() }), embedPasses: () => [{ start: NOW - 5000, end: NOW - 1000, embedded: 77, backlogLeft: 0, stopReason: "done" }] });
    expect(p.passes[0].last).toEqual({ at: NOW - 1000, chunks: 77, result: "done", by: "nightly" });
  });

  it("keeps the finished run as a job tile with result, rate, duration until a run of that kind starts", async () => {
    const f = fin({ outcome: "stopped", reason: "stopped on request", done: 300 });
    const p = await pay(status(), { finished: (k) => (k === "embed" ? f : null) });
    const t = p.jobs.find((j: any) => j.id === "last-embed");
    expect(t).toMatchObject({ done: 300, total: 600, rate: 1, by: "cockpit", finished: { outcome: "stopped", reason: "stopped on request", durationSec: 300 } });
    const h = pageFns().memHtml(p);
    expect(p.jobs.find((j: any) => j.id === "last-embed")).toMatchObject({ name: "embed run", finished: { outcome: "stopped" } });
    expect(COCKPIT_HTML).toContain('(list[i].finished?"Last ":"")'); // the card is titled "Last embed run"
    for (const x of ["finished · stopped", "stopped on request", "300 / 600 done", "took 5 m 00 s", "1.0 chunks/s average", "by cockpit"]) expect(h, x).toContain(x);
    // a running run of the same kind replaces the kept tile
    const q = await pay(status(), { run: () => run(), finished: (k) => (k === "embed" ? f : null) });
    expect(q.jobs.map((j: any) => j.id)).toEqual(["run-embed"]);
  });

  it("run-state keeps the last finished run per kind and clears it when the next run of that kind starts", () => {
    const h1 = acquireRun("embed", { home, by: "cli", backlogStart: 10, minGapMs: 100000 })!;
    h1.progress(7);
    h1.release({ outcome: "budget", reason: "time budget reached" });
    const f = readFinishedRun("embed", home)!;
    expect(f).toMatchObject({ kind: "embed", by: "cli", backlogStart: 10, done: 7, outcome: "budget" });
    expect(readFinishedRun("index", home)).toBeNull();
    const h2 = acquireRun("embed", { home })!;
    expect(readFinishedRun("embed", home)).toBeNull();
    h2.release();
    expect(readFinishedRun("embed", home)).toMatchObject({ outcome: "failed" });
  });

  it("memory.embed with backlog 0 answers at once without a run; with a backlog it starts", async () => {
    let called = 0;
    const hooks = { runMemoryJob: async () => { called++; return { ok: true, message: "" }; } };
    const r = await runCockpitAction({ action: "memory.embed" }, actDeps({ embedBacklog: async () => 0 }), hooks);
    expect(r).toEqual({ ok: true, message: "nothing to embed (backlog 0)" });
    await settle();
    expect(called).toBe(0);
    expect((await runCockpitAction({ action: "memory.embed" }, actDeps({ embedBacklog: async () => 5 }), hooks)).jobId).toBeDefined();
    await settle();
    expect(called).toBe(1);
  });

  it("embed button is disabled with the tooltip at backlog 0, enabled otherwise; index stays enabled", async () => {
    const p = await pay(status(), { daemon: async () => daemon({ status: status(), embedBacklog: 0 }) });
    const acts = pageFns().memActs(p);
    expect(acts.embed).toBe("nothing to embed (backlog 0)"); // disabled, the reason is the tooltip
    expect(acts.index).toBe(true);
    const q = await pay(status(), { daemon: async () => daemon({ status: status(), embedBacklog: 5 }) });
    expect(pageFns().memActs(q)).toMatchObject({ embed: true, index: true });
  });

  it("while a run is going: running pill text, front tile with stop and tail, busy marker; before the marker a starting tile", async () => {
    const f = pageFns();
    const p = await pay(status(), { run: () => run({ done: 61_000, backlogStart: 122_000 }), finished: () => fin() });
    expect(p.jobs[0].id).toBe("run-embed");
    const h = f.memHtml(p);
    expect(f.memActs(p).stop).toBe(true); // stop offered
    expect(f.memActs(p).embed).toBe("a run is in progress"); // busy
    expect(h).toContain("embed running (started by cockpit)"); // the run line on the status card
    expect(h).toContain("chunks/s"); // the run is the front job card
    expect(f.memRunPill(p)).toMatch(/embedding 50% · [\d.]+\/s · ETA/);
    // starting gap
    const at = new Date(NOW - 1000).toISOString();
    mkdirSync(`${home}/cockpit-jobs`, { recursive: true });
    writeFileSync(`${home}/cockpit-jobs/j1.json`, JSON.stringify({ id: "j1", kind: "memory", tier: "", what: "index", state: "running", message: "index now", at, startedAt: at }));
    const s = await pay(status());
    expect(s.jobs[0]).toMatchObject({ id: "run-starting", done: 0, phase: "starting" });
    expect(f.memRunPill(s)).toContain("starting");
    expect(f.memHtml(s)).toContain("starting…");
  });
});

describe("transient marker on a failing source", () => {
  const T = (n: number) => NOW + n * 1000;
  it("serves last good data marked transient on a daemon blip and recovers on the next good answer", async () => {
    resetMemoryStale();
    await cockpitMemoryPayload(deps());
    let p = (await cockpitMemoryPayload(deps({ daemon: async () => null, now: () => T(5) }))) as Record<string, any>;
    expect(p).toMatchObject({ transient: "daemon not answering", failures: 1, staleSince: T(5), level: "red", counts: { chunks: 2_000_000 } });
    p = (await cockpitMemoryPayload(deps({ daemon: async () => null, now: () => T(9) }))) as Record<string, any>;
    expect(p).toMatchObject({ transient: "daemon not answering", failures: 2, staleSince: T(5) });
    const ok = (await cockpitMemoryPayload(deps())) as Record<string, any>;
    expect(ok.transient).toBeUndefined();
    expect(ok).toMatchObject({ failures: 0, staleSince: null, level: "green" });
  });

  it("a failing binding check is transient", async () => {
    resetMemoryStale();
    const bf = (failures: number, since: number) => daemon({ status: status({ index: { ...(status() as any).index, bindingFailure: { failures, since, reason: "connection timeout" } } }) });
    const p = (await cockpitMemoryPayload(deps({ daemon: async () => bf(1, NOW) }))) as Record<string, any>;
    expect(p).toMatchObject({ transient: "binding check failed: connection timeout", failures: 1 });
  });
});

describe("cockpit Lessons card", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.PAI_HOME;
    process.env.PAI_HOME = home;
    mkdirSync(lessonsDir(), { recursive: true });
    const put = (id: string, state: LessonState, ageH: number) =>
      writeFileSync(join(lessonsDir(), `${id}.md`), serializeLesson({
        id, title: `Title ${id}`, state, kind: "gotcha", applies_when: "always", project: "", evidence: [],
        created: new Date(NOW - ageH * 3600_000).toISOString(), updated: new Date(NOW).toISOString(), body: "b",
      }));
    for (let i = 1; i <= 7; i++) put(`cand-${i}`, "candidate", i); // cand-1 newest
    put("appr-1", "approved", 50);
    put("appr-2", "approved", 60);
    put("rej-1", "rejected", 70);
    put("sup-1", "superseded", 80);
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.PAI_HOME;
    else process.env.PAI_HOME = prev;
  });

  it("payload: counts per state and the 5 newest candidates with their age", async () => {
    const p = (await cockpitMemoryPayload(deps())) as Record<string, any>;
    expect(p.lessons.counts).toEqual({ candidate: 7, approved: 2, rejected: 1, superseded: 1 });
    expect(p.lessons.candidates.map((c: any) => c.id)).toEqual(["cand-1", "cand-2", "cand-3", "cand-4", "cand-5"]);
    expect(p.lessons.candidates[0]).toEqual({ id: "cand-1", title: "Title cand-1", ageSec: 3600 });
  });

  it("payload: no lessons gives zero counts and no candidates", async () => {
    const p = (await cockpitMemoryPayload(deps({ lessons: () => [] }))) as Record<string, any>;
    expect(p.lessons).toEqual({ counts: { candidate: 0, approved: 0, rejected: 0, superseded: 0 }, candidates: [] });
  });

  it("page: the card renders the counts and candidate titles through the real renderer", async () => {
    const p = await cockpitMemoryPayload(deps());
    const html = pageFns().memHtml({ ...(p as object), jobs: [] }, ["lessons"]);
    expect(html).toContain("awaiting review");
    expect(html).toContain('<span class="chip" data-part="candidate"><b>7</b> candidate</span>');
    expect(html).toContain('<span class="chip" data-part="approved"><b>2</b> approved</span>');
    expect(html).toContain('<span class="chip" data-part="rejected"><b>1</b> rejected</span>');
    expect(html).toContain('<span class="chip" data-part="superseded"><b>1</b> superseded</span>');
    expect(html).toContain('class="chips" data-part="counts"');
    expect(html).not.toContain("approved ·");
    expect(html).toContain("Title cand-1 · 60 m 00 s ago");
    expect(html).not.toContain("Title cand-6");
  });
});

describe("run-progress tiles", () => {
  const rec = (over: Record<string, unknown> = {}) => ({
    kind: "index", pid: 1, startedAt: new Date(NOW - 100_000).toISOString(), phase: "index", done: 120, total: 254, unit: "projects", files: 9, chunks: 30, skipped: 1,
    current: "proj", elapsedSec: 100, updatedAt: new Date(NOW - 1000).toISOString(), movedAt: new Date(NOW - 5000).toISOString(), ratePerMin: 72, etaSec: 110, state: "running", ...over,
  }) as any;

  it("the Index tile shows index progress with a bar while a run is active, nothing once finished", async () => {
    const f = pageFns();
    const m = (await cockpitMemoryPayload(deps({ runRecord: (k) => (k === "index" ? rec() : null) }))) as any;
    const h = f.memHtml(m, ["index"]);
    expect(h).toContain("indexing: 120/254 projects · 1:40");
    expect(h).toContain('data-part="runbar-index"');
    expect(h).toContain("width:47.2%");
    const done = (await cockpitMemoryPayload(deps({ runRecord: () => rec({ state: "finished" }) }))) as any;
    expect(f.memHtml(done, ["index"])).not.toContain("runbar");
  });

  it("the embed run shows N/M this run, per-minute rate and ETA, and the coverage follows its counters", async () => {
    const f = pageFns();
    const e = rec({ kind: "embed", unit: "chunks", phase: "embed", done: 22_303, total: 122_303, ratePerMin: 1500, etaSec: 4000 });
    const m = (await cockpitMemoryPayload(deps({ runRecord: (k) => (k === "embed" ? e : null) }))) as any;
    expect(f.memHtml(m, ["index"])).toContain("embedding: 22.3k/122.3k this run · 1.5k/min · ETA 1:06:40");
    expect(m.counts.backlog).toBe(100_000);
    expect(m.counts.coverage).toBeCloseTo(0.95, 4);
  });

  it("a record whose pid is gone reads ended, and a stalled one names the silent seconds", async () => {
    const f = pageFns();
    const gone = (await cockpitMemoryPayload(deps({ runRecord: () => rec({ state: "ended" }) }))) as any;
    expect(f.memHtml(gone, ["index"])).toContain("run ended without finishing");
    const stuck = (await cockpitMemoryPayload(deps({ runRecord: (k) => (k === "index" ? rec({ movedAt: new Date(NOW - 200_000).toISOString() }) : null) }))) as any;
    expect(stuck.runs.index.stalledSec).toBe(200);
    expect(f.memHtml(stuck, ["index"])).toContain("no progress for");
  });

  it("a big project that keeps counting files is not stalled in the run tile", async () => {
    const r = run({ kind: "index", backlogStart: null, done: 0, startedAt: new Date(NOW - 600_000).toISOString() });
    const p = (await cockpitMemoryPayload(deps({ run: () => r, runRecord: () => rec({ movedAt: new Date(NOW - 3000).toISOString() }) }))) as any;
    expect(p.jobs.find((j: any) => j.id === "run-index").stalled).toBe(false);
    resetMemoryStale();
    const q = (await cockpitMemoryPayload(deps({ run: () => r, runRecord: () => null }))) as any;
    expect(q.jobs.find((j: any) => j.id === "run-index").stalled).toBe(true);
  });
});
