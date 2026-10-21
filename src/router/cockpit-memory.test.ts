import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cockpitMemoryPayload, memoryJobProgress, runProgress, type DaemonMemory, type MemoryDeps } from "./cockpit-memory.js";
import { defaultDeps, memoryRunRefusal, readCockpitJob, runCockpitAction, type ActionDeps } from "./cockpit-actions.js";
import { COCKPIT_HTML } from "./cockpit-page.js";
import { cockpitLayout } from "./cockpit-layout.js";
import { acquireRun, readRun, runStateFile, type RunState } from "../memory/run-state.js";

let home = "";
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pai-cockpit-memory-"));
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
    const down = (await cockpitMemoryPayload(deps({ daemon: async () => null }))) as any;
    expect(down).toMatchObject({ daemon: false, level: "red", reason: "daemon not answering" });
    expect(down.counts.backlog).toBeNull();
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
function pageFns() {
  const src = COCKPIT_HTML.match(/var mem=null[\s\S]*?(?=function renderMemory)/)![0];
  const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const fmt = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(Math.round(n)));
  const table = (head: string[], rows: unknown[][]) => `<table>${head.join("|")}${rows.map((r) => r.join("|")).join("\n")}</table>`;
  return new Function("esc", "fmt", "table", `${src}; return {memHtml, memRunLine, memDur};`)(esc, fmt, table) as {
    memHtml: (m: unknown) => string;
    memRunLine: (r: unknown) => string;
    memDur: (s: number) => string;
  };
}

describe("memory section page", () => {
  it("is on the page with its configured title and a poll interval from the layout", () => {
    expect(COCKPIT_HTML).toContain('data-section="memory"');
    expect(COCKPIT_HTML).toContain(`<h2>${cockpitLayout().memoryTitle}`);
    expect(COCKPIT_HTML).toContain(`setInterval(loadMemory,${cockpitLayout().memoryPollMs})`);
  });

  it("renders the live numbers: counts, backlog, backend and model, last passes, nightly schedule", async () => {
    const m = await cockpitMemoryPayload(deps());
    const h = pageFns().memHtml(m);
    expect(h).toContain("122303");
    expect(h).toContain("ollama-f16");
    expect(h).toContain("arctic");
    expect(h).toContain("40 files");
    expect(h).toContain("nightly maintenance at 03:00");
    expect(h).toContain("embed backlog");
    expect(h).not.toContain(" disabled");
    expect(h).not.toContain("memory.stop");
  });

  it("shows the busy state: run line with progress, buttons disabled, stop offered, started by named", async () => {
    const m = await cockpitMemoryPayload(deps({ run: () => run() }));
    const f = pageFns();
    const h = f.memHtml(m);
    expect(h).toContain("embed running (started by cockpit)");
    expect(h).toContain("1.0k / 122.3k chunks (0.8%)");
    expect(h).toContain("ETA");
    expect(h).toContain('data-a="memory.embed" disabled');
    expect(h).toContain('data-a="memory.index" disabled');
    expect(h).toContain('data-a="memory.stop"');
    // a daemon pass: busy, but no stop button
    const d = f.memHtml(await cockpitMemoryPayload(deps({ run: () => run({ by: "daemon" }) })));
    expect(d).toContain("started by daemon");
    expect(d).not.toContain("memory.stop");
  });
});
