/**
 * Router stall round 3 (#24): per-request lookups must not rebuild or re-parse.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clearJobNameCache, defaultSources } from "./sessions.js";
import { clearParseCache, parseCacheStats } from "../config/parse-cache.js";
import { readLocalConfig } from "../workers/local-tiers.js";
import { SystemMonitor } from "./system.js";

describe("stall round 3 caches", () => {
  it("defaultSources is built once per window", () => {
    clearJobNameCache();
    const first = defaultSources();
    for (let i = 0; i < 100; i++) expect(defaultSources()).toBe(first);
    clearJobNameCache();
    expect(defaultSources()).not.toBe(first);
  });

  it("readLocalConfig parses workers.yaml once for 100 calls, again after a change", () => {
    const dir = mkdtempSync(join(tmpdir(), "stall3-"));
    try {
      const f = join(dir, "workers.yaml");
      writeFileSync(f, "providers: {}\n");
      clearParseCache();
      for (let i = 0; i < 100; i++) readLocalConfig(f);
      expect(parseCacheStats.parses).toBe(1);
      writeFileSync(f, "providers: {}\n# changed, longer\n");
      readLocalConfig(f);
      expect(parseCacheStats.parses).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("SystemMonitor spawns hw.memsize once, not per poll", async () => {
    const calls: string[] = [];
    const run = async (cmd: string, args: string[]) => {
      calls.push(`${cmd} ${args.join(" ")}`);
      return args.includes("hw.memsize") ? "17179869184\n" : "";
    };
    let t = 1_000_000;
    const m = new SystemMonitor({ file: "/dev/null", telemetryFile: "/dev/null", workersLogDir: () => tmpdir(), now: () => t, run, ttlMs: 1 });
    await m.sample();
    t += 10_000;
    await m.sample();
    expect(calls.filter((c) => c.includes("hw.memsize")).length).toBe(1);
    expect(calls.filter((c) => c.startsWith("vm_stat")).length).toBe(2);
  });
});

/**
 * Router stall round 4 (#24): /cockpit/system must never spawn on the request path.
 * One background sampler collects the metrics; the handler returns the latest sample with its age.
 */
describe("background system sampler", () => {
  /** A fake spawner: records every call, resolves on demand (so a sample can be held in flight). */
  function fakeSpawner() {
    const calls: string[] = [];
    let gate: Promise<void> | null = null;
    let open: (() => void) | null = null;
    const run = async (cmd: string, args: string[]): Promise<string> => {
      calls.push(`${cmd} ${args.join(" ")}`);
      if (gate) await gate;
      if (args.includes("hw.memsize")) return "17179869184\n";
      if (args.includes("kern.memorystatus_level")) return "70\n";
      if (args.includes("vm.swapusage")) return "total = 0.00M  used = 0.00M  free = 0.00M\n";
      return "";
    };
    return {
      calls,
      run,
      hold: () => {
        if (!gate) gate = new Promise<void>((r) => (open = r));
      },
      unhold: () => {
        const o = open;
        gate = null;
        open = null;
        o?.();
      },
    };
  }

  const opts = (now: () => number, run: (c: string, a: string[]) => Promise<string>) => ({
    file: "/dev/null",
    telemetryFile: "/dev/null",
    workersLogDir: () => tmpdir(),
    now,
    run,
  });

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  it("N concurrent requests within a second cause at most one sample", async () => {
    const f = fakeSpawner();
    let t = 1_000_000;
    const m = new SystemMonitor(opts(() => t, f.run));
    // cold start: the first request takes one sample; the rest share the cache
    const results = await Promise.all(Array.from({ length: 20 }, () => m.current()));
    expect(f.calls.filter((c) => c.startsWith("vm_stat")).length).toBe(1);
    for (const r of results) expect(r.sample).not.toBeNull();
    // a second burst within the same second: still one sample total
    await Promise.all(Array.from({ length: 20 }, () => m.current()));
    expect(f.calls.filter((c) => c.startsWith("vm_stat")).length).toBe(1);
  });

  it("the request handler never calls the spawner once a sample exists", async () => {
    const f = fakeSpawner();
    let t = 1_000_000;
    const m = new SystemMonitor(opts(() => t, f.run));
    await m.current(); // cold start fills the cache
    const before = f.calls.length;
    t += 60_000; // well past any ttl
    for (let i = 0; i < 50; i++) await m.current();
    expect(f.calls.length).toBe(before);
  });

  it("overlapping samples are skipped: one in flight at a time", async () => {
    const f = fakeSpawner();
    let t = 1_000_000;
    const m = new SystemMonitor(opts(() => t, f.run));
    await m.current(); // warm the cache (hw.memsize is cached after this)
    const warm = f.calls.filter((c) => c.startsWith("vm_stat")).length;
    f.hold(); // the next sample blocks until released
    const inFlight = m.sample();
    await sleep(50); // let the held sample reach the spawner
    expect(f.calls.filter((c) => c.startsWith("vm_stat")).length).toBe(warm + 1); // only the in-flight sample spawned
    const skipped = m.sample(); // joins the in-flight poll: no extra spawn
    f.unhold(); // release the gate: both awaits settle with the same sample
    const s = await skipped;
    expect(s?.t).toBe(1_000_000); // the held poll's own timestamp
    await inFlight;
    expect(f.calls.filter((c) => c.startsWith("vm_stat")).length).toBe(warm + 1);
  });

  it("idle -> 10 s cadence, active -> 1 s", async () => {
    const f = fakeSpawner();
    let t = 1_000_000;
    const m = new SystemMonitor({ ...opts(() => t, f.run), activeMs: 100, idleMs: 1000, activeWindowMs: 1500 });
    const stop = m.startRing();
    try {
      // idle: samples only every idleMs
      const idleStart = f.calls.filter((c) => c.startsWith("vm_stat")).length;
      await sleep(350);
      expect(f.calls.filter((c) => c.startsWith("vm_stat")).length).toBe(idleStart); // 10 s cadence: nothing yet
      await sleep(750); // past the 10 s tick
      expect(f.calls.filter((c) => c.startsWith("vm_stat")).length).toBeGreaterThan(idleStart);

      // active: a request switches the sampler to the 1 s cadence
      const activeStart = f.calls.filter((c) => c.startsWith("vm_stat")).length;
      await m.current();
      await sleep(350);
      expect(f.calls.filter((c) => c.startsWith("vm_stat")).length).toBeGreaterThan(activeStart);
    } finally {
      stop();
    }
  });

  it("response shape unchanged: the sample carries the same fields, plus its age", async () => {
    const f = fakeSpawner();
    let t = 1_000_000;
    const m = new SystemMonitor(opts(() => t, f.run));
    const r = await m.current();
    const s = r.sample!;
    expect(typeof s.t).toBe("number");
    expect(s.source).toBe("direct");
    expect(s.memTotal).toBe(17179869184);
    expect(s.pressureLevel).toBe(70);
    expect(Array.isArray(s.notes)).toBe(true);
    expect(s.slowAgeS).toBe(0);
    // the age grows with the clock, the sample itself is untouched
    t += 5_000;
    const r2 = await m.current();
    expect(r2.sample!.slowAgeS).toBe(5);
    expect(r2.sample!.t).toBe(1_000_000);
    // the snapshot keeps its shape
    const snap = await m.snapshot("1h");
    expect(snap.now).toBe(t);
    expect(snap.window).toBe("1h");
    expect(snap.bucketMs).toBeGreaterThan(0);
    expect(snap.current).not.toBeNull();
    expect(snap.series.window).toBe("1h");
    expect(typeof snap.battery).toBe("string");
    expect(snap.unavailable).toEqual({});
  });

  it("a warm current() resolves without touching the spawner at all", async () => {
    let touched = false;
    const m = new SystemMonitor({
      file: "/dev/null",
      telemetryFile: "/dev/null",
      workersLogDir: () => tmpdir(),
      run: async () => {
        touched = true;
        return "";
      },
    });
    await m.current();
    touched = false;
    const s = (await m.current()).sample;
    expect(touched).toBe(false);
    expect(s).not.toBeNull();
  });
});
