import { describe, it, expect } from "vitest";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { buildCockpitData, handleCockpit } from "./cockpit.js";
import { buildSystemSeries, fallbackSample, parseMactopSample, parseVmStat, SystemMonitor, type SystemSample } from "./system.js";

const dir = () => mkdtempSync(join(tmpdir(), "pai-system-"));
const runner = (mactop: boolean) => {
  const calls: string[] = [];
  const run = (cmd: string) => {
    calls.push(cmd);
    if (/mactop$/.test(cmd)) return mactop ? Promise.resolve(MACTOP_FIXTURE) : Promise.reject(new Error("spawn mactop ENOENT"));
    if (cmd === "vm_stat") return Promise.resolve(VM_FIXTURE);
    if (cmd === "sysctl") return Promise.resolve("89\n");
    return Promise.reject(new Error(`unexpected ${cmd}`));
  };
  return { run, calls };
};

// real `mactop --headless --count 1 --format json` output, processes trimmed to 3
const MACTOP_FIXTURE = String.raw`[{"timestamp":"2026-10-16T16:10:58+02:00","soc_metrics":{"cpu_power":0,"gpu_power":0.03335058699898433,"ane_power":0,"dram_power":0,"gpu_sram_power":0,"system_power":47.028607725989296,"total_power":47.06195831298828,"gpu_freq_mhz":338,"gpu_active":6.546877187534572,"e_cluster_active":0,"p_cluster_active":67.73721213322847,"s_cluster_active":99.99981443114548,"e_cluster_freq_mhz":0,"p_cluster_freq_mhz":3548,"s_cluster_freq_mhz":4608,"soc_temp":67.29194,"cpu_temp":67.29194,"gpu_temp":57.366943,"dram_read_bw_gbs":0,"dram_write_bw_gbs":0,"dram_bw_combined_gbs":0,"ane_read_bw_gbs":0,"ane_write_bw_gbs":0,"ane_bw_combined_gbs":0,"ane_active":0},"memory":{"total":137438953472,"used":55653498880,"available":81785454592,"swap_total":2147483648,"swap_used":1342963712},"cpu_usage":49.59570411579888,"gpu_usage":6.546877187534572,"gpu_metrics":{"freq_mhz":338,"active_percent":6.546877187534572},"system_info":{"name":"Apple M5 Max","core_count":18},"thermal_state":"Nominal","processes":[{"pid":98074,"command":"swift-driver","cpu_percent":0,"gpu_ms_per_sec":0,"memory_percent":0.008821487426757812,"rss_kb":11840},{"pid":98073,"command":"node","cpu_percent":0,"gpu_ms_per_sec":0,"memory_percent":0.03,"rss_kb":40960},{"pid":98072,"command":"mactop","cpu_percent":1.2,"gpu_ms_per_sec":0,"memory_percent":0.05,"rss_kb":65536}]}]`;

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
      memTotal: MEM_TOTAL,
      memUsed: 55653498880,
      swapTotal: 2147483648,
      swapUsed: 1342963712,
    });
    // the CPU rail reads 0 on this SoC: say so instead of a bare 0
    expect(s.notes?.[0]).toContain("system rail");
  });

  it("rejects garbage mactop output", () => {
    expect(() => parseMactopSample("mactop: error", NOW)).toThrow();
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

  it("memory-only fallback carries the reason and no load metrics", () => {
    const vm = parseVmStat(VM_FIXTURE, MEM_TOTAL)!;
    const s = fallbackSample(vm, 89, "mactop binary not found", NOW);
    expect(s.source).toBe("vmstat");
    expect(s.cpu).toBeUndefined();
    expect(s.wired).toBe(474420 * PAGE);
    expect(s.pressureLevel).toBe(89);
    expect(s.notes?.[0]).toContain("mactop unavailable");
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
  it("samples mactop, enriches with vm_stat, caches within ttl, rings every minute", async () => {
    const d = dir();
    let t = NOW;
    const { run, calls } = runner(true);
    const m = new SystemMonitor({ file: join(d, "ring.jsonl"), ttlMs: 5000, run, now: () => t });
    const first = await m.current();
    expect(first.sample?.cpu).toBe(49.59570411579888);
    expect(first.sample?.wired).toBe(474420 * PAGE);
    expect(first.sample?.pressureLevel).toBe(89);
    expect(readFileSync(join(d, "ring.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);

    t += 3_000;
    await m.current(); // cached: no further mactop poll
    expect(calls.filter((c) => /mactop$/.test(c))).toHaveLength(1);

    t += 60_000;
    const third = await m.current();
    expect(third.sample?.cpu).toBe(49.59570411579888);
    expect(readFileSync(join(d, "ring.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);

    const snap = await m.snapshot("1h");
    expect(snap.unavailable).toEqual({});
    expect(snap.series.coveredMin["1h"]).toBe(2);
    expect(snap.series.wh["1h"]).toBeCloseTo((47.06195831298828 * 2) / 60, 1);
    rmSync(d, { recursive: true, force: true });
  });

  it("falls back to vm_stat when mactop is missing, noting why", async () => {
    const d = dir();
    const { run } = runner(false);
    const m = new SystemMonitor({ file: join(d, "ring.jsonl"), run, now: () => NOW });
    const { sample } = await m.current();
    expect(sample?.source).toBe("vmstat");
    expect(sample?.wired).toBe(474420 * PAGE);
    expect(sample?.cpu).toBeUndefined();
    const snap = await m.snapshot("24h");
    expect(snap.unavailable).toEqual({}); // memory metrics still there
    expect(snap.current?.notes?.[0]).toContain("mactop");
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
      { provider: "llamacpp", kind: "local" as const, windows: [], up: true, rssMb: 4321, tokensPerSec: 7.3, served: ["qwen3"], fetchedAt: 0 },
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
    expect(j.current.cpu).toBe(49.59570411579888);
    expect(j.current.wired).toBe(474420 * PAGE);
    expect(j.series.series.length).toBe(buildCockpitData([], "24h", NOW).series.length);
    expect(j.servers).toEqual([{ provider: "llamacpp", up: true, rssMb: 4321, tokensPerSec: 7.3, served: ["qwen3"] }]);
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
