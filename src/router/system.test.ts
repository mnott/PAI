import { describe, it, expect, vi } from "vitest";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { buildCockpitData, handleCockpit } from "./cockpit.js";
import {
  buildSystemSeries,
  parseMactopSample,
  parseSwapUsage,
  parseTopCpu,
  parseVmStat,
  SystemMonitor,
  type SystemSample,
} from "./system.js";

const dir = () => mkdtempSync(join(tmpdir(), "pai-system-"));
const MIB = 1024 ** 2;
const MIN = 60_000;
/** sysctl vm.swapusage, verbatim */
const SWAP_FIXTURE = "vm.swapusage: total = 2048.00M  used = 1240.75M  free = 807.25M  (encrypted)\n";
/** /usr/bin/top -l 2 -n 0 -s 1, the two "CPU usage" lines kept verbatim */
const TOP_FIXTURE = `Processes: 1103 total, 4 running, 1099 sleeping, 2767 threads

Load Avg: 19.07, 11.86, 7.73
CPU usage: 24.98% user, 41.51% sys, 33.49% idle

Load Avg: 19.07, 11.86, 7.73
CPU usage: 16.91% user, 32.52% sys, 50.56% idle
`;
const TOP_CPU = 100 - 50.56; // the second sample is the real interval

const runner = (mactop: boolean | "fails-later") => {
  const calls: string[] = [];
  let mactopCalls = 0;
  const run = (cmd: string, args: string[]) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    if (/mactop/.test(cmd)) {
      mactopCalls++;
      if (mactop === true) return Promise.resolve(MACTOP_FIXTURE);
      if (mactop === "fails-later") return mactopCalls === 1 ? Promise.resolve(MACTOP_FIXTURE) : Promise.reject(new Error("probe timed out"));
      return Promise.reject(new Error("spawn mactop ENOENT"));
    }
    if (cmd === "vm_stat") return Promise.resolve(VM_FIXTURE);
    if (cmd === "sysctl") {
      if (args.includes("hw.memsize")) return Promise.resolve(`${MEM_TOTAL}\n`);
      if (args.includes("vm.swapusage")) return Promise.resolve(SWAP_FIXTURE);
      return Promise.resolve("89\n");
    }
    if (cmd === "/usr/bin/top") return Promise.resolve(TOP_FIXTURE);
    return Promise.reject(new Error(`unexpected ${cmd} ${args.join(" ")}`));
  };
  return { run, calls };
};

// real `mactop --headless --count 1 --format json` output, processes trimmed to 3
const MACTOP_FIXTURE = String.raw`[{"timestamp":"2026-10-16T16:10:58+02:00","soc_metrics":{"cpu_power":0,"gpu_power":0.03335058699898433,"ane_power":0,"dram_power":0,"gpu_sram_power":0,"system_power":47.028607725989296,"total_power":47.06195831298828,"gpu_freq_mhz":338,"gpu_active":6.546877187534572,"e_cluster_active":0,"p_cluster_active":67.73721213322847,"s_cluster_active":99.99981443114548,"e_cluster_freq_mhz":0,"p_cluster_freq_mhz":3548,"s_cluster_freq_mhz":4608,"soc_temp":67.29194,"cpu_temp":67.29194,"gpu_temp":57.366943,"dram_read_bw_gbs":0,"dram_write_bw_gbs":0,"dram_bw_combined_gbs":0,"ane_read_bw_gbs":0,"ane_write_bw_gbs":0,"ane_bw_combined_gbs":0,"ane_active":0},"memory":{"total":137438953472,"used":55653498880,"available":81785454592,"swap_total":2147483648,"swap_used":1342963712},"cpu_usage":49.59570411579888,"gpu_usage":6.546877187534572,"gpu_metrics":{"freq_mhz":338,"active_percent":6.546877187534572},"system_info":{"name":"Apple M5 Max","core_count":18},"thermal_state":"Nominal","processes":[{"pid":98074,"command":"swift-driver","cpu_percent":0,"gpu_ms_per_sec":0,"memory_percent":0.008821487426757812,"rss_kb":11840},{"pid":98073,"command":"node","cpu_percent":0,"gpu_ms_per_sec":0,"memory_percent":0.03,"rss_kb":40960},{"pid":98072,"command":"mactop","cpu_percent":1.2,"gpu_ms_per_sec":0,"memory_percent":0.05,"rss_kb":65536}]}]`;

// real `mactop --headless --count 2` shape: an array of interval frames, the parser takes the last
const MACTOP_COUNT2 = (() => {
  const frame = JSON.parse(MACTOP_FIXTURE)[0];
  return JSON.stringify([
    { ...frame, cpu_usage: 58.813809987022054, soc_metrics: { ...frame.soc_metrics, total_power: 58.36479949951172, soc_temp: 64.792725, gpu_active: 34.022244578826275 } },
    frame,
  ]);
})();

// real `vm_stat` output, lines that matter kept verbatim
const VM_FIXTURE = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                  2471817.
Pages active:                                2471337.
Pages inactive:                              2461256.
Pages speculative:                             16500.
Pages throttled:                                   0.
Pages wired down:                             474420.
Pages purgeable:                               21840.
Pages stored in compressor:                   509983.
Pages occupied by compressor:                   368524.
`;

const PAGE = 16384;
const MEM_TOTAL = 137438953472;
const NOW = Date.parse("2026-10-16T14:00:00Z");
const min = (n: number) => NOW - n * 60_000;

describe("system parsers", () => {
  it("maps a real mactop headless frame", () => {
    const s = parseMactopSample(MACTOP_FIXTURE, NOW);
    expect(s).toMatchObject({
      t: NOW,
      source: "mactop",
      cpu: 49.59570411579888,
      gpu: 6.546877187534572,
      ane: 0,
      gpuFreqMhz: 338,
      socTemp: 67.29194,
      cpuW: 0,
      gpuW: 0.03335058699898433,
      systemW: 47.028607725989296,
      totalW: 47.06195831298828,
    });
    // the CPU rail reads 0 on this SoC: say so instead of a bare 0
    expect(s.notes?.[0]).toContain("system rail");
  });

  it("drops an implausible mactop power frame (counter-delta fault: cpu_power 39529 W)", () => {
    const frame = JSON.parse(MACTOP_FIXTURE)[0];
    const bad = (soc: Record<string, number | undefined>) =>
      parseMactopSample(JSON.stringify([{ ...frame, soc_metrics: { ...frame.soc_metrics, ...soc } }]), NOW);
    for (const soc of [{ cpu_power: 39529.26, total_power: 44708.19 }, { total_power: -5 }, { total_power: 1000.5 }]) {
      const s = bad(soc);
      expect(s.totalW).toBeUndefined();
      expect(s.cpuW).toBeUndefined();
      expect(s.systemW).toBeUndefined();
      expect(s.gpu).toBe(6.546877187534572);
      expect(s.notes?.join()).toContain("implausible");
    }
    expect(bad({ total_power: 999 }).totalW).toBe(999);
  });

  it("ignores an old implausible power point when reading history (chart, sparkline, Wh)", () => {
    const d = buildSystemSeries(
      [
        { t: min(10), source: "mactop", totalW: 50, cpuW: 10, cpu: 20 },
        { t: min(5), source: "mactop", totalW: 44708.19, cpuW: 39529.26, cpu: 30 },
      ],
      "1h",
      NOW,
    );
    expect(Math.max(...d.series.map((b) => b.totalW ?? 0))).toBe(50);
    expect(Math.max(...d.series.map((b) => b.cpuW ?? 0))).toBe(10);
    expect(d.wh["1h"]).toBe(Math.round((50 / 60) * 10) / 10);
    expect(d.series.reduce((n, b) => n + b.n, 0)).toBe(2);
  });

  it("count-2 mactop frames resolve to the last interval, not the first", () => {
    const s = parseMactopSample(MACTOP_COUNT2, NOW);
    expect(s.cpu).toBe(49.59570411579888); // not frame 0's 58.81
    expect(s.totalW).toBe(47.06195831298828); // not frame 0's 58.36
    expect(s.socTemp).toBe(67.29194); // not frame 0's 64.79
  });

  it("rejects garbage mactop output", () => {
    expect(() => parseMactopSample("mactop: error", NOW)).toThrow();
  });

  it("parses sysctl vm.swapusage into bytes", () => {
    expect(parseSwapUsage(SWAP_FIXTURE)).toEqual({ total: 2048 * MIB, used: 1240.75 * MIB });
    expect(parseSwapUsage("vm.swapusage: total = 1.50G  used = 0.25G  free = 1.25G")).toEqual({ total: 1.5 * 1024 ** 3, used: 0.25 * 1024 ** 3 });
    expect(parseSwapUsage("vm.swapusage: disabled")).toBeUndefined();
  });

  it("parses the second top sample as CPU load", () => {
    expect(parseTopCpu(TOP_FIXTURE)).toBe(TOP_CPU);
    expect(parseTopCpu("no cpu line here")).toBeUndefined();
    expect(parseTopCpu("CPU usage: 0.00% user, 0.00% sys, 100.00% idle")).toBe(0);
  });

  it("maps vm_stat bytes: wired, compressed, used", () => {
    const vm = parseVmStat(VM_FIXTURE, MEM_TOTAL)!;
    expect(vm).toEqual({
      pageSize: PAGE,
      wired: 474420 * PAGE,
      compressed: 368524 * PAGE,
      free: 2471817 * PAGE,
      used: MEM_TOTAL - (2471817 + 16500 + 2461256) * PAGE,
    });
  });
});

describe("system series", () => {
  it("buckets align with the token chart and average per bucket", () => {
    const samples: SystemSample[] = [];
    for (let i = 0; i < 10; i++) samples.push({ t: min(50 - i), source: "mactop", totalW: 40 + i, gpu: 10, cpu: 20 });
    const d = buildSystemSeries(samples, "1h", NOW);
    const tokens = buildCockpitData([], "1h", NOW);
    expect(d.series.map((b) => b.t)).toEqual(tokens.series.map((b) => b.t)); // same from/bucket math
    expect(d.bucketMs).toBe(300_000);
    // samples land 13:10-13:19: two 5-min buckets, 45-49 W averages to 47 in the second
    expect(d.series.filter((b) => b.n)).toHaveLength(2);
    expect(d.series[3]!).toMatchObject({ n: 5, totalW: (45 + 46 + 47 + 48 + 49) / 5, gpu: 10, cpu: 20 } as Partial<SystemSample>);
    // each sample = one minute; ten samples, totalW 40..49
    expect(d.wh["1h"]).toBeCloseTo(445 / 60, 1);
    expect(d.coveredMin["1h"]).toBe(10);
    expect(d.coveredMin["24h"]).toBe(10);
  });

  it("windows older than 7d drop out of wh", () => {
    const d = buildSystemSeries([{ t: min(60 * 24 * 8), source: "mactop", totalW: 100 }], "7d", NOW);
    expect(d.wh["7d"]).toBe(0);
    expect(d.series.every((b) => b.n === 0)).toBe(true);
  });
});

describe("SystemMonitor", () => {
  it("polls direct sources, merges the probe, caches within ttl, rings every minute", async () => {
    const d = dir();
    let t = NOW;
    const { run, calls } = runner(true);
    const m = new SystemMonitor({ file: join(d, "ring.jsonl"), ttlMs: 5000, run, now: () => t });
    await m.probe(); // constructor already kicked it; settle it
    const first = await m.current();
    expect(first.sample?.source).toBe("direct");
    expect(first.sample?.cpu).toBe(TOP_CPU); // /usr/bin/top, not mactop
    expect(first.sample?.swapUsed).toBe(1240.75 * MIB); // sysctl vm.swapusage
    expect(first.sample?.swapTotal).toBe(2048 * MIB);
    expect(first.sample?.wired).toBe(474420 * PAGE);
    expect(first.sample?.pressureLevel).toBe(89);
    expect(first.sample?.gpu).toBe(6.546877187534572); // fresh probe merged
    expect(first.sample?.totalW).toBe(47.06195831298828);
    expect(readFileSync(join(d, "ring.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);

    t += 3_000;
    await m.current(); // cached: no further poll
    expect(calls.filter((c) => /mactop/.test(c))).toHaveLength(1);

    t += 60_000;
    const third = await m.current(); // probe due again at the ring cadence
    expect(third.sample?.cpu).toBe(TOP_CPU);
    expect(calls.filter((c) => /mactop/.test(c))).toHaveLength(2);
    expect(readFileSync(join(d, "ring.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);

    const snap = await m.snapshot("1h");
    expect(snap.unavailable).toEqual({});
    expect(snap.slowAgeS).toBe(0);
    expect(snap.series.coveredMin["1h"]).toBe(2);
    expect(snap.series.wh["1h"]).toBeCloseTo((47.06195831298828 * 2) / 60, 1);
    rmSync(d, { recursive: true, force: true });
  });

  it("answers every direct field while the probe is still warming up", async () => {
    const d = dir();
    let release!: (v: string) => void;
    const gate = new Promise<string>((r) => (release = r));
    let firstMactop = true;
    const run = (cmd: string, args: string[]) => {
      if (/mactop/.test(cmd) && firstMactop) {
        firstMactop = false;
        return gate; // the constructor probe hangs here until the test releases it
      }
      return runner(true).run(cmd, args);
    };
    let t = NOW;
    const m = new SystemMonitor({ file: join(d, "ring.jsonl"), run, now: () => t });
    const { sample } = await m.current(); // direct fields are ready, the probe is not
    expect(sample?.cpu).toBe(TOP_CPU);
    expect(sample?.swapUsed).toBe(1240.75 * MIB);
    expect(sample?.wired).toBe(474420 * PAGE);
    expect(sample?.gpu).toBeUndefined();
    expect(sample?.totalW).toBeUndefined();
    expect(sample?.notes?.join(" ")).toContain("probe running");
    release(MACTOP_FIXTURE); // the probe lands, the next read merges it
    await m.probe();
    t += 10_000; // past the ttl: rebuilt, now with probe values
    const merged = await m.current();
    expect(merged.sample?.gpu).toBe(6.546877187534572);
    expect(merged.sample?.totalW).toBe(47.06195831298828);
    rmSync(d, { recursive: true, force: true });
  });

  it("serves the last good probe as cached, then drops it past the stale window", async () => {
    const d = dir();
    let t = NOW;
    const { run } = runner("fails-later");
    const m = new SystemMonitor({ file: join(d, "ring.jsonl"), ttlMs: 5000, run, now: () => t });
    await m.probe(); // first probe succeeds
    t += 3 * MIN; // probe starts failing; last good reading is 3 min old
    const mid = await m.current();
    expect(mid.sample?.gpu).toBe(6.546877187534572); // still served
    expect(mid.sample?.notes?.join(" ")).toContain("cached");
    expect(mid.sample?.notes?.join(" ")).toContain("3 min ago");
    const midSnap = await m.snapshot("1h");
    expect(midSnap.slowAgeS).toBe(180);
    t += 3 * MIN; // 6 min old: past the stale window
    const late = await m.current();
    expect(late.sample?.gpu).toBeUndefined();
    expect(late.sample?.totalW).toBeUndefined();
    expect(late.sample?.cpu).toBe(TOP_CPU); // direct fields unaffected
    expect(late.sample?.notes?.join(" ")).toContain("stale");
    rmSync(d, { recursive: true, force: true });
  });

  it("works without mactop at all, noting what is lost", async () => {
    const d = dir();
    const { run } = runner(false);
    const m = new SystemMonitor({ file: join(d, "ring.jsonl"), run, now: () => NOW });
    await m.probe();
    const { sample } = await m.current();
    expect(sample?.source).toBe("direct");
    expect(sample?.cpu).toBe(TOP_CPU); // real CPU load, no mactop needed
    expect(sample?.swapUsed).toBe(1240.75 * MIB);
    expect(sample?.gpu).toBeUndefined();
    const snap = await m.snapshot("24h");
    expect(snap.unavailable).toEqual({}); // memory metrics still there
    expect(snap.current?.notes?.join(" ")).toContain("ENOENT");
    rmSync(d, { recursive: true, force: true });
  });

  it("snapshot carries the battery guard's power telemetry, and omits it without a file", async () => {
    const d = dir();
    const t0 = 1_800_000_000_000;
    const tel = join(d, "battery-telemetry.jsonl");
    const mk = (file?: string) => new SystemMonitor({ file: join(d, "ring.jsonl"), telemetryFile: file, run: runner(true).run, now: () => t0 });
    const none = await mk(join(d, "missing.jsonl")).snapshot("1h");
    expect(none.power).toBeUndefined();
    expect(none.series.series.every((b) => b.powerInW === undefined)).toBe(true);

    const line = (at: number, extra: object) => JSON.stringify({ at, adapterWatts: 100, systemPowerInW: 60, systemLoadW: 65, batteryW: -5, pct: 80, ...extra });
    writeFileSync(tel, [line(t0 - 10 * MIN, {}), line(t0 - 30_000, { source: "ioreg", drainPctPerMin: -0.5 }), "not json"].join("\n") + "\n");
    const snap = await mk(tel).snapshot("1h");
    expect(snap.power).toEqual({ adapterW: 100, powerInW: 60, loadW: 65, batteryW: -5, pct: 80, source: "ioreg", drainPctPerMin: -0.5, ageS: 30 });
    const last = snap.series.series.filter((b) => b.powerInW !== undefined).at(-1)!;
    expect(last.powerInW).toBe(60);
    expect(last.adapterW).toBe(100);
    expect(last.batteryW).toBe(-5);
    expect(last.drainW).toBe(5);
    rmSync(d, { recursive: true, force: true });
  });

  it("prunes the ring to the retention window on append", async () => {
    const d = dir();
    const file = join(d, "ring.jsonl");
    const old = { t: min(30), source: "mactop", totalW: 10 };
    const fresh = { t: min(1), source: "mactop", totalW: 20 };
    writeFileSync(file, [old, fresh].map((s) => JSON.stringify(s)).join("\n") + "\n");
    const { run } = runner(true);
    const m = new SystemMonitor({ file, keepMs: 10 * 60_000, run, now: () => NOW });
    await m.current();
    const kept = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as SystemSample);
    expect(kept.map((s) => s.t)).toEqual([fresh.t, NOW]); // 30-min-old sample dropped
    rmSync(d, { recursive: true, force: true });
  });
});

describe("cockpit system http", () => {
  const limitsStub = {
    get: async () => [
      { provider: "llamacpp", kind: "local" as const, windows: [], up: true, rssMb: 4321, served: ["qwen3"], fetchedAt: 0 },
    ],
  };

  it("serves /cockpit/system with current, series and local servers", async () => {
    const d = dir();
    const m = new SystemMonitor({ file: join(d, "ring.jsonl"), run: runner(true).run, now: () => NOW });
    const srv = http.createServer((req, res) => {
      if (!handleCockpit(req, res, limitsStub, () => [], () => new Map(), m)) res.end("other");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    const get = (path: string, method = "GET") =>
      new Promise<{ status: number; body: string }>((resolve) => {
        const rq = http.request({ host: "127.0.0.1", port, path, method }, (res) => {
          let b = "";
          res.on("data", (c) => (b += c));
          res.on("end", () => resolve({ status: res.statusCode!, body: b }));
        });
        rq.end();
      });
    const j = JSON.parse((await get("/cockpit/system?window=24h")).body);
    expect(j.window).toBe("24h");
    expect(j.current.cpu).toBe(TOP_CPU); // direct top sample
    expect(j.current.swapUsed).toBe(1240.75 * MIB); // direct sysctl sample
    expect(j.current.wired).toBe(474420 * PAGE);
    expect(j.series.series.length).toBe(buildCockpitData([], "24h", NOW).series.length);
    expect(j.servers).toEqual([{ provider: "llamacpp", up: true, rssMb: 4321, served: ["qwen3"] }]);
    expect((await get("/cockpit/system", "POST")).status).toBe(405);
    expect((await get("/cockpit/nonsense")).status).toBe(404);
    srv.close();
    rmSync(d, { recursive: true, force: true });
  });

  it("503 when no monitor is configured", async () => {
    const srv = http.createServer((req, res) => {
      if (!handleCockpit(req, res, limitsStub, () => [], () => new Map())) res.end("other");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    const body = await new Promise<string>((resolve) => {
      http.get({ host: "127.0.0.1", port, path: "/cockpit/system" }, (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve(`${res.statusCode} ${b}`));
      });
    });
    expect(body).toContain("503");
    srv.close();
  });
});

describe("SystemMonitor ring without a cockpit page", () => {
  it("fills the ring across hours nobody polls /cockpit/system (02:00-06:00 local gap)", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-24T00:00:00Z"), toFake: ["setInterval", "clearInterval", "Date"] });
    const d = dir();
    try {
      const file = join(d, "ring.jsonl");
      const m = new SystemMonitor({ file, run: runner(true).run, now: () => Date.now() });
      await m.current(); // a page was open at 00:00Z, then closed
      const rows = () => readFileSync(file, "utf8").trim().split("\n").length;
      for (let i = 0; i < 120; i++) await vi.advanceTimersByTimeAsync(MIN); // 2 h, no poll
      expect(rows()).toBe(1); // the gap
      const stop = m.startRing();
      for (let i = 0; i < 120; i++) await vi.advanceTimersByTimeAsync(MIN);
      stop();
      expect(rows()).toBeGreaterThanOrEqual(100); // one sample a minute
    } finally {
      vi.useRealTimers();
      rmSync(d, { recursive: true, force: true });
    }
  });
});
