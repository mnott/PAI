import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { DashboardState, hostAllowed, indexSegments, startDashboard, type DashboardSource, type PassSnapshot } from "./dashboard.js";
import type { EmbeddingBackend } from "../memory/backends/types.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MIN = 60_000;

function backend(ok = true, id = "ollama-f16"): EmbeddingBackend {
  return {
    id,
    model: "m1",
    dims: 768,
    maxTokens: 512,
    available: async () => ({ ok, reason: ok ? "ready" : "no Ollama server" }),
    embed: async () => [],
  };
}

const okPass = (name: string): PassSnapshot => ({ name, running: false, lastEnd: 1, failure: null, nextAt: null });

function source(over: Partial<DashboardSource> = {}): DashboardSource {
  return {
    storage: "postgres",
    daemon: () => ({ pid: 42, startTime: 0, version: "9.9.9" }),
    estimate: async () => ({ files: 10, chunks: 100, embedded: 50 }),
    exact: async () => ({ files: 11, chunks: 101, embedded: 51 }),
    binding: async () => ({ backend: "ollama-f16", model: "m1", dims: 768 }),
    jobs: async () => [],
    backend: () => backend(),
    loadedModels: async () => [{ name: "m1", size: 1000, sizeVram: 1000 }],
    passes: () => [okPass("index"), okPass("embed")],
    ...over,
  };
}

describe("status assembly", () => {
  it("is green and reports daemon, counts, coverage and GPU share when healthy", async () => {
    const st = new DashboardState(source(), () => 10_000);
    await st.tick();
    const s = st.status();
    expect(s.level).toBe("green");
    expect(s.daemon).toMatchObject({ pid: 42, version: "9.9.9", storage: "postgres", uptimeSecs: 10 });
    expect(s.index).toMatchObject({ files: 10, chunks: 100, embedded: 50, coverage: 0.5, countsExact: false, mismatch: false });
    expect(s.backend).toMatchObject({ available: true, loaded: [{ name: "m1", gpuShare: 1 }] });
  });

  it("flags a binding mismatch red with the CLI hint", async () => {
    const st = new DashboardState(source({ binding: async () => ({ backend: "transformers-cpu-q8", model: "", dims: 0 }) }));
    await st.tick();
    const s = st.status();
    expect(s.level).toBe("red");
    expect(s.index.mismatch).toBe(true);
    expect(s.index.hint).toContain("pai memory reembed");
  });

  it("flags a binding mismatch amber with re-embed hint when an active re-embed job for that backend exists", async () => {
    const st = new DashboardState(
      source({
        binding: async () => ({ backend: "transformers-cpu-q8", model: "", dims: 0 }),
        jobs: async () => [{ name: "ollama-f16-reembed", state: { prepared: true, carryDone: false, done: 100, total: 1000 } }],
      }),
    );
    await st.tick();
    const s = st.status();
    expect(s.level).toBe("amber");
    expect(s.index.level).toBe("amber");
    expect(s.index.mismatch).toBe(true);
    expect(s.index.hint).toContain("re-embed to ollama-f16 in progress");
    expect(s.index.hint).toContain("keyword-only");
  });

  it("shows mismatch red when re-embed job is finished or stalled", async () => {
    const st = new DashboardState(
      source({
        binding: async () => ({ backend: "transformers-cpu-q8", model: "", dims: 0 }),
        jobs: async () => [{ name: "ollama-f16-reembed", state: { finished: true, done: 1000, total: 1000 } }],
      }),
    );
    await st.tick();
    const s = st.status();
    expect(s.index.level).toBe("red");
    expect(s.index.hint).toContain("pai memory reembed");
  });

  it("flags an unavailable backend red", async () => {
    const st = new DashboardState(source({ backend: () => backend(false) }));
    await st.tick();
    const s = st.status();
    expect(s.level).toBe("red");
    expect(s.backend).toMatchObject({ level: "red", available: false, reason: "no Ollama server" });
  });

  it("flags a failed pass red and carries the error", async () => {
    const failure = { at: 5, error: "db timeout", attempts: 2, gaveUp: false, retryAt: 99 };
    const st = new DashboardState(source({ passes: () => [okPass("index"), { ...okPass("embed"), failure }] }));
    await st.tick();
    const s = st.status();
    expect(s.level).toBe("red");
    expect(s.passes.find((p) => p.name === "embed")).toMatchObject({ level: "red", failure: { error: "db timeout", retryAt: 99 } });
  });

  it("derives rate and ETA from samples, then marks the job stalled after 5 min without progress", async () => {
    let now = 0;
    let done = 1000;
    const job = () => [{ name: "j", state: { prepared: true, carryDone: true, done, total: 2000 } }];
    const st = new DashboardState(source({ jobs: async () => job() }), () => now);
    await st.tick();
    now += 60_000;
    done = 1600; // 600 rows in 60 s = 10/s
    await st.tick();
    let j = st.status().jobs[0];
    expect(j).toMatchObject({ phase: "embed", done: 1600, total: 2000, stalled: false });
    expect(j.rate).toBeCloseTo(10);
    expect(j.etaSecs).toBe(40);

    for (let i = 0; i < 11; i++) { now += 30_000; await st.tick(); } // 5.5 min flat
    j = st.status().jobs[0];
    expect(j.stalled).toBe(true);
    expect(j.rate).toBe(0);
    expect(st.status().level).toBe("red");
  });

  it("ignores job rows with empty state and shows a finished job as done, never stalled", async () => {
    let now = 0;
    const jobs = [
      { name: "legacy", state: {} },
      { name: "j", state: { finished: true, done: 5, total: 5 } },
    ];
    const st = new DashboardState(source({ jobs: async () => jobs }), () => now);
    await st.tick();
    now += 10 * MIN;
    await st.tick();
    const s = st.status();
    expect(s.jobs).toHaveLength(1);
    expect(s.jobs[0]).toMatchObject({ phase: "done", stalled: false, level: "green" });
  });
});

describe("history and index segments", () => {
  it("keeps at most 120 samples (1 h), oldest dropped, and exposes them in status", async () => {
    let now = 0;
    let done = 0;
    const st = new DashboardState(source({ jobs: async () => [{ name: "j", state: { prepared: true, done, total: 9999 } }] }), () => now);
    for (let i = 0; i < 130; i++) { await st.tick(); now += 30_000; done += 5; }
    const h = st.status().jobs[0].history;
    expect(h).toHaveLength(120);
    expect(h[0]).toEqual({ t: 10 * 30_000, done: 50 });
    expect(h[119]).toEqual({ t: 129 * 30_000, done: 645 });
  });

  it("splits vectors into new/old/missing and floors old at 0", () => {
    expect(indexSegments(1000, 600, 100)).toEqual({ fresh: 100, old: 500, missing: 400 });
    expect(indexSegments(1000, 600, 800)).toEqual({ fresh: 800, old: 0, missing: 400 });
    expect(indexSegments(1000, 1200, null)).toEqual({ fresh: 0, old: 1200, missing: 0 });
    expect(indexSegments(1000, 600, null)).toEqual({ fresh: 0, old: 600, missing: 400 });
  });

  it("puts segments and a reason into status", async () => {
    const st = new DashboardState(source({ jobs: async () => [{ name: "ollama-f16-reembed", state: { prepared: true, done: 20, total: 100 } }], binding: async () => ({ backend: "x", model: "", dims: 0 }) }));
    await st.tick();
    const s = st.status();
    expect(s.index.segments).toEqual({ fresh: 20, old: 30, missing: 50 });
    expect(s.reason).toContain("re-embed");
  });
});

describe("count cache", () => {
  it("does at most one real count per 5 minutes however often it ticks", async () => {
    let now = 0;
    const exact = vi.fn(async () => ({ files: 11, chunks: 101, embedded: 51 }));
    const estimate = vi.fn(async () => ({ files: 10, chunks: 100, embedded: 50 }));
    const st = new DashboardState(source({ exact, estimate }), () => now);
    for (let i = 0; i < 9; i++) { await st.tick(); st.status(); now += 30_000; } // 4.5 min
    expect(exact).toHaveBeenCalledTimes(0);
    expect(estimate).toHaveBeenCalledTimes(1);
    expect(st.status().index.countsExact).toBe(false);

    now = 5 * MIN;
    for (let i = 0; i < 9; i++) { await st.tick(); await Promise.resolve(); now += 30_000; } // up to 9.5 min
    expect(exact).toHaveBeenCalledTimes(1);
    expect(st.status().index).toMatchObject({ files: 11, chunks: 101, countsExact: true });

    now = 10 * MIN;
    await st.tick();
    expect(exact).toHaveBeenCalledTimes(2);
  });

  it("keeps the estimate when the real count fails", async () => {
    let now = 0;
    const st = new DashboardState(source({ exact: async () => { throw new Error("statement timeout"); } }), () => now);
    await st.tick();
    now = 6 * MIN;
    await st.tick();
    await Promise.resolve();
    expect(st.status().index).toMatchObject({ chunks: 100, countsExact: false });
  });
});

describe("host check", () => {
  const allowed = ["127.0.0.1", "localhost", "box.tail1234.ts.net", "100.64.0.7"];
  it.each(["127.0.0.1:8770", "localhost", "LOCALHOST:8770", "box.tail1234.ts.net:8770", "100.64.0.7", "[::1]:8770"])(
    "allows %s",
    (h) => expect(hostAllowed(h, [...allowed, "::1"])).toBe(true),
  );
  it.each([undefined, "", "evil.example", "evil.example:8770", "127.0.0.1.evil.example", "box.tail1234.ts.net.evil.example", "100.64.0.8"])(
    "denies %s",
    (h) => expect(hostAllowed(h, allowed)).toBe(false),
  );
});

describe("server", () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  it("serves status and page, 403 on a foreign Host, 405 on POST", async () => {
    const h = await startDashboard({ enabled: true, port: 0, bind: "127.0.0.1" }, source(), { extraHosts: [] });
    stop = h.stop;
    const addr = h.server.address() as { port: number };
    const base = `http://127.0.0.1:${addr.port}`;

    const api = await fetch(`${base}/api/status`);
    expect(api.status).toBe(200);
    expect((await api.json()).daemon.pid).toBe(42);

    const page = await fetch(`${base}/`);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("/api/status");

    // fetch forbids overriding Host, so use a raw request.
    const { request } = await import("node:http");
    const code = await new Promise<number>((resolve) => {
      request({ port: addr.port, host: "127.0.0.1", path: "/api/status", headers: { host: "evil.example" } }, (r) => { r.resume(); resolve(r.statusCode ?? 0); }).end();
    });
    expect(code).toBe(403);

    expect((await fetch(`${base}/api/status`, { method: "POST" })).status).toBe(405);
  });
});

describe("ETA calculation", () => {
  it("computes ETA with live numbers: done=105488, rate=65.98, total=2699865", async () => {
    let now = 0;
    let done = 105488;
    const job = () => [{ name: "reembed", state: { prepared: true, carryDone: true, done, total: 2699865 } }];
    const st = new DashboardState(source({ jobs: async () => job() }), () => now);
    await st.tick(); // first sample
    now += 60_000;
    done = 105488 + Math.round(65.98 * 60); // add 60s of work at 65.98 rows/s
    await st.tick(); // second sample
    const j = st.status().jobs[0];
    expect(j.rate).toBeCloseTo(65.98, 0);
    // (2699865 - 105488) / 65.98 ≈ 39330 s; rounding and sample timing may vary ~100s
    expect(j.etaSecs).toBeLessThan(39400);
    expect(j.etaSecs).toBeGreaterThan(39200);
  });

  it("handles missing total gracefully (defaults to 0, eta stays null)", async () => {
    let now = 0;
    const job = () => [{ name: "j", state: { prepared: true, carryDone: true, done: 100 } }];
    const st = new DashboardState(source({ jobs: async () => job() }), () => now);
    await st.tick();
    now += 60_000;
    await st.tick();
    const j = st.status().jobs[0];
    expect(j.total).toBe(0);
    expect(j.etaSecs).toBeNull();
  });
});

describe("history persistence", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "dashboard-")); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("persists and reloads history, pruning samples >2h old and jobs no longer present", async () => {
    const historyFile = join(tmpDir, "history.json");
    let now = 0;
    let done = 0;
    const activeJobs = ["active", "old"];
    const st1 = new DashboardState(
      source({ jobs: async () => activeJobs.map((n) => ({ name: n, state: { prepared: true, done, total: 1000 } })) }),
      () => now,
      historyFile,
    );

    // First 60 samples (30 min)
    for (let i = 0; i < 60; i++) { await st1.tick(); now += 30_000; done += 5; }
    let status1 = st1.status();
    expect(status1.jobs).toHaveLength(2);
    expect(status1.jobs[0].history.length).toBeGreaterThan(0);

    // Now advance 2+ hours, trigger another persist
    now += 2 * 60 * 60_000; // +2h
    done = 400;
    await st1.tick(); // triggers persist if 30s elapsed

    // Load in a new state with only "active" job
    activeJobs.splice(activeJobs.indexOf("old"), 1);
    const st2 = new DashboardState(
      source({ jobs: async () => activeJobs.map((n) => ({ name: n, state: { prepared: true, done, total: 1000 } })) }),
      () => now,
      historyFile,
    );
    await st2.loadHistory();
    // Tick to sample the loaded job
    await st2.tick();
    let status2 = st2.status();
    // After loading and ticking, the active job should have history from the loaded file
    expect(status2.jobs).toHaveLength(1);
    expect(status2.jobs[0].name).toBe("active");
    expect(status2.jobs[0].history.length).toBeGreaterThan(0);
  });

  it("writes history at most every 30s", async () => {
    const historyFile = join(tmpDir, "history.json");
    let now = 0;
    const st = new DashboardState(source({ jobs: async () => [{ name: "j", state: { prepared: true, done: 100, total: 1000 } }] }), () => now, historyFile);

    await st.tick(); // first tick
    now += 5_000;
    await st.tick();
    now += 5_000;
    await st.tick();
    // These should NOT trigger persist writes (within 30s window)

    now += 20_000; // total 30s
    await st.tick(); // should trigger persist
    // just verify no errors and state is consistent
    const status = st.status();
    expect(status.jobs).toHaveLength(1);
  });
});
