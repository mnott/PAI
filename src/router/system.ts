/**
 * system.ts — machine metrics for the cockpit SYSTEM panel. Sources, no sudo
 * anywhere:
 *
 *   direct   cheap no-sudo commands, polled per request (ttl 5 s): CPU load
 *            from `/usr/bin/top -l 2` (the second sample; refreshed at most
 *            every 10 s), swap from `sysctl vm.swapusage`, memory total and
 *            pressure from `sysctl`, wired/compressed/used from `vm_stat`
 *   mactop   the IOReport/SMC set — GPU/ANE load, SoC temperature, power
 *            rails — has no no-sudo alternative (powermetrics needs sudo), so
 *            it stays as an optional extra: one-shot
 *            `mactop --headless --count 2 --format json` (count 1 can return
 *            an empty frame) with a 1 s interval takes ~2 s, so it
 *            runs as a background probe every probeMs (5 s), never
 *            blocking a request; its values are served from the last good
 *            probe for up to 5 min
 *
 * Every 1-min sample is appended to a small JSONL ring (7 days) so day and
 * week windows chart power and memory history and report watt-hours. Metrics
 * a source does not give stay undefined; the panel shows "n/a" with the
 * sample's notes as tooltip.
 */

import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { paiHomePath } from "../config/pai-home.js";
import { dirname, join } from "node:path";
import { bucketStart, WINDOWS, type CockpitWindow } from "./cockpit.js";
import { batteryCockpitLine, readTelemetryLines, summarizeTelemetry, telemetryFile, type TelemetryLine } from "../daemon/battery-guard.js";

export const systemRingFile = (): string => paiHomePath("logs", "router-system.jsonl");
const MIN = 60_000;
const DAY = 86_400_000;
/** direct commands are sub-second; never wait longer */
const CMD_TIMEOUT = 8_000;
/** mactop measures over an interval; the old 8 s budget killed every probe */
const MACTOP_TIMEOUT = 15_000;
/** count 1 often emits an empty frame before the first IOReport interval closes */
const MACTOP_COUNT = 2;
/** sample window per frame (mactop -i, ms): count 2 finishes in ~2 s */
const MACTOP_INTERVAL_MS = 1000;
/** last-known mactop values are served this long while the probe retries */
const SLOW_TTL = 5 * MIN;
/** CPU load refresh cadence; a `top -l 2` pass costs ~2 s */
const TOP_TTL = 10_000;
const MACTOP_CANDIDATES = ["mactop", "/opt/homebrew/bin/mactop", "/opt/local/bin/mactop"];
/** absolute: `top` is aliased to htop in some shells and PATH order is luck */
const TOP_CMD = "/usr/bin/top";

/** a SoC total above this is a probe fault (mactop derives watts from energy deltas and can emit a bogus delta) */
export const MAX_PLAUSIBLE_SOC_W = 1000;
let implausibleLogged = false;

/** One reading; undefined = this source did not report the metric. */
export interface SystemSample {
  t: number;
  /** percent */
  cpu?: number;
  gpu?: number;
  ane?: number;
  gpuFreqMhz?: number;
  /** °C */
  socTemp?: number;
  /** watts */
  cpuW?: number;
  gpuW?: number;
  aneW?: number;
  systemW?: number;
  totalW?: number;
  /** bytes */
  memTotal?: number;
  memUsed?: number;
  swapTotal?: number;
  swapUsed?: number;
  wired?: number;
  compressed?: number;
  /** kern.memorystatus_level, 1-100; higher = less pressure */
  pressureLevel?: number;
  source: "direct" | "mactop" | "vmstat";
  /** why metrics are missing or stale, shown as tooltip */
  notes?: string[];
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Parse `mactop --headless --count N --format json` (array of frames, last wins). */
export function parseMactopSample(stdout: string, t: number = Date.now()): SystemSample {
  const j = JSON.parse(stdout) as Record<string, unknown> | Array<Record<string, unknown>>;
  const s = (Array.isArray(j) ? j[j.length - 1] : j) ?? {};
  const soc = (s.soc_metrics ?? {}) as Record<string, unknown>;
  const mem = (s.memory ?? {}) as Record<string, unknown>;
  const notes: string[] = [];
  // some SoCs fold the CPU rail into system_power; say so instead of a bare 0
  let cpuW = num(soc.cpu_power);
  let gpuW = num(soc.gpu_power);
  let aneW = num(soc.ane_power);
  let systemW = num(soc.system_power);
  let totalW = num(soc.total_power);
  const rails = [cpuW, gpuW, aneW, systemW, totalW];
  if (rails.some((w) => w !== undefined && (w < 0 || w > MAX_PLAUSIBLE_SOC_W))) {
    if (!implausibleLogged) {
      implausibleLogged = true;
      console.error(`[system] mactop power reading dropped as implausible: ${JSON.stringify(rails)}`);
    }
    cpuW = gpuW = aneW = systemW = totalW = undefined;
    notes.push("power reading from mactop was implausible and dropped");
  }
  if (cpuW === 0 && systemW && systemW > 1) notes.push("CPU rail reads 0 W on this SoC; it is part of the system rail");
  return {
    t,
    cpu: num(s.cpu_usage),
    gpu: num(soc.gpu_active) ?? num(s.gpu_usage),
    ane: num(soc.ane_active),
    gpuFreqMhz: num(soc.gpu_freq_mhz),
    socTemp: num(soc.soc_temp) ?? num(soc.cpu_temp),
    cpuW,
    gpuW,
    aneW,
    systemW,
    totalW,
    memTotal: num(mem.total),
    memUsed: num(mem.used),
    swapTotal: num(mem.swap_total),
    swapUsed: num(mem.swap_used),
    source: "mactop",
    ...(notes.length ? { notes } : {}),
  };
}

export interface VmStat {
  pageSize: number;
  wired: number;
  compressed: number;
  used: number;
  free: number;
}

/** `vm_stat` output → bytes; used = total - reclaimable (free+speculative+inactive). */
export function parseVmStat(out: string, memTotal: number | undefined): VmStat | undefined {
  const pages = (label: string): number | undefined => {
    const m = new RegExp(`${label}:\\s+(\\d+).`).exec(out);
    return m ? Number(m[1]) : undefined;
  };
  const size = /page size of (\d+) bytes/.exec(out);
  const pageSize = size ? Number(size[1]) : 16_384;
  const wired = pages("Pages wired down");
  const compressed = pages("Pages occupied by compressor");
  const free = pages("Pages free");
  const speculative = pages("Pages speculative") ?? 0;
  const inactive = pages("Pages inactive") ?? 0;
  if (wired === undefined || compressed === undefined || free === undefined) return undefined;
  const reclaimable = (free + speculative + inactive) * pageSize;
  const used = memTotal !== undefined ? Math.max(0, memTotal - reclaimable) : undefined;
  return { pageSize, wired: wired * pageSize, compressed: compressed * pageSize, used: used ?? 0, free: free * pageSize };
}

/** `sysctl vm.swapusage` → bytes: "total = 2048.00M  used = 1240.75M  free = ...". */
export function parseSwapUsage(out: string): { total: number; used: number } | undefined {
  const unit: Record<string, number> = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
  const grab = (label: string): number | undefined => {
    const m = new RegExp(`${label} = ([\\d.]+)\\s*([BKMGTP])`).exec(out);
    return m ? Number(m[1]) * unit[m[2]!] : undefined;
  };
  const total = grab("total");
  const used = grab("used");
  return total !== undefined && used !== undefined ? { total, used } : undefined;
}

/** `/usr/bin/top -l 2` → load in % of the whole SoC; the second sample is the
 *  real interval, the first covers the boot-to-now delta. */
export function parseTopCpu(out: string): number | undefined {
  const line = out.match(/CPU usage:.*/g)?.at(-1);
  const idle = line && /([\d.]+)% idle/.exec(line);
  return idle ? Math.max(0, Math.min(100, 100 - Number(idle[1]))) : undefined;
}

export type SystemWindow = CockpitWindow;

export interface SystemBucket {
  t: number;
  n: number;
  cpu?: number;
  gpu?: number;
  ane?: number;
  socTemp?: number;
  totalW?: number;
  systemW?: number;
  gpuW?: number;
  cpuW?: number;
  aneW?: number;
  memPct?: number;
  /** battery guard telemetry (W): charger delivery, charger limit, signed battery power, discharge as a positive number */
  powerInW?: number;
  adapterW?: number;
  batteryW?: number;
  drainW?: number;
}

export interface SystemSeries {
  window: SystemWindow;
  bucketMs: number;
  series: SystemBucket[];
  /** watt-hours per window, from the 1-min samples that carry totalW */
  wh: Record<SystemWindow, number>;
  /** minutes of samples behind each wh number (coverage, the ring has gaps) */
  coveredMin: Record<SystemWindow, number>;
}

export const POWER_KEYS = ["cpuW", "gpuW", "aneW", "systemW", "totalW"] as const;
export const implausibleW = (w: number | undefined): boolean => w !== undefined && (w < 0 || w > MAX_PLAUSIBLE_SOC_W);

/** History written before the probe check holds bogus watts; ignore them on read, the data file stays as is. */
function withoutImplausiblePower(s: SystemSample): SystemSample {
  if (!POWER_KEYS.some((k) => implausibleW(s[k]))) return s;
  const c = { ...s };
  for (const k of POWER_KEYS) delete c[k];
  return c;
}

const AVG_KEYS = ["cpu", "gpu", "ane", "socTemp", "totalW", "systemW", "gpuW", "cpuW", "aneW"] as const;

/**
 * Bucket 1-min samples into the cockpit windows' buckets — the same from/bucket
 * math as buildCockpitData, so the power chart lines up with the token chart.
 */
export function buildSystemSeries(samples: SystemSample[], win: SystemWindow, now: number, telemetry: TelemetryLine[] = []): SystemSeries {
  const { span, bucket } = WINDOWS[win];
  const from = bucketStart(now - span, bucket);
  const series: SystemBucket[] = [];
  for (let t = from; t <= now; t += bucket) series.push({ t, n: 0 });
  const sums = series.map(() => new Map<string, { s: number; n: number }>());

  const wh: Record<SystemWindow, number> = { "1h": 0, "24h": 0, "7d": 0 };
  const coveredMin: Record<SystemWindow, number> = { "1h": 0, "24h": 0, "7d": 0 };
  const spans: Record<SystemWindow, number> = { "1h": 3_600_000, "24h": DAY, "7d": 7 * DAY };

  for (const raw of samples) {
    const s = withoutImplausiblePower(raw);
    const b = Math.floor((bucketStart(s.t, bucket) - from) / bucket);
    if (b >= 0 && b < series.length) {
      const acc = sums[b]!;
      series[b]!.n++;
      for (const k of AVG_KEYS) {
        const v = s[k];
        if (typeof v === "number") {
          const a = acc.get(k) ?? { s: 0, n: 0 };
          a.s += v;
          a.n++;
          acc.set(k, a);
        }
      }
      if (s.memUsed && s.memTotal) {
        const a = acc.get("memPct") ?? { s: 0, n: 0 };
        a.s += (s.memUsed / s.memTotal) * 100;
        a.n++;
        acc.set("memPct", a);
      }
    }
    if (typeof s.totalW === "number") {
      for (const w of Object.keys(spans) as SystemWindow[]) {
        if (s.t >= now - spans[w]) {
          wh[w] += s.totalW / 60; // one sample = one minute
          coveredMin[w]++;
        }
      }
    }
  }

  const tAcc = series.map(() => new Map<string, { s: number; n: number }>());
  const TEL_KEYS = [["powerInW", "systemPowerInW"], ["adapterW", "adapterWatts"], ["batteryW", "batteryW"]] as const;
  for (const l of telemetry) {
    const b = Math.floor((bucketStart(l.at, bucket) - from) / bucket);
    if (b < 0 || b >= series.length) continue;
    for (const [k, src] of TEL_KEYS) {
      const v = l[src];
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      const a = tAcc[b]!.get(k) ?? { s: 0, n: 0 };
      a.s += v;
      a.n++;
      tAcc[b]!.set(k, a);
    }
  }
  series.forEach((b, i) => {
    for (const [k, a] of tAcc[i]!) (b as unknown as Record<string, number>)[k] = a.s / a.n;
    if (b.batteryW !== undefined) b.drainW = Math.max(0, -b.batteryW);
    const acc = sums[i]!;
    for (const [k, a] of acc) {
      const avg = a.n ? a.s / a.n : undefined;
      if (avg !== undefined) (b as unknown as Record<string, number>)[k] = avg;
    }
  });
  for (const w of Object.keys(wh) as SystemWindow[]) wh[w] = Math.round(wh[w] * 10) / 10;

  return { window: win, bucketMs: bucket, series, wh, coveredMin };
}

export interface SystemSnapshot {
  now: number;
  window: SystemWindow;
  bucketMs: number;
  current: SystemSample | null;
  /** metric → reason, when no source produced a reading at all */
  unavailable: Record<string, string>;
  series: SystemSeries;
  /** age in seconds of the mactop-sourced values (gpu/temp/power), when fresh */
  slowAgeS?: number;
  /**
   * The battery guard's line for the System section ("87 % (battery) · battery
   * draining on AC: 62 % → 55 % in 10 min"); "" when the guard has no reading
   * (non-macOS, or the daemon's guard is off).
   */
  battery: string;
  /** Latest battery guard telemetry line; absent with no telemetry file (desktop Mac, guard never ran). */
  power?: PowerReading;
}

export interface PowerReading {
  adapterW: number | null;
  powerInW: number | null;
  loadW: number | null;
  /** negative while discharging */
  batteryW: number | null;
  pct: number | null;
  source: string | null;
  drainPctPerMin: number | null;
  ageS: number;
}

/** The newest telemetry line as the feed's `power` object; undefined without a readable line. */
export function powerReading(now: number, path: string): PowerReading | undefined {
  const t = summarizeTelemetry(0, now, path);
  if (!t) return undefined;
  const l = t.latest;
  return {
    adapterW: l.adapterWatts ?? null,
    powerInW: l.systemPowerInW ?? null,
    loadW: l.systemLoadW ?? null,
    batteryW: l.batteryW ?? null,
    pct: l.pct ?? null,
    source: l.source ?? null,
    drainPctPerMin: l.drainPctPerMin ?? null,
    ageS: t.ageS,
  };
}

export interface SystemDeps {
  file?: string;
  /** battery guard telemetry jsonl (tests); default the guard's own file */
  telemetryFile?: string;
  /** minimum distance between direct-source polls (the page asks every 5 s) */
  ttlMs?: number;
  /** ring append cadence (1 min) */
  ringMs?: number;
  /** mactop probe cadence, independent of the ring */
  probeMs?: number;
  /** ring retention */
  keepMs?: number;
  /** how old a served mactop value may be while the probe retries */
  staleMs?: number;
  /** CPU load refresh cadence */
  topTtlMs?: number;
  /** injectable command runner (tests) */
  run?: (cmd: string, args: string[]) => Promise<string>;
  now?: () => number;
}

function sh(cmd: string, args: string[], timeoutMs = CMD_TIMEOUT): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (e, out) =>
      e ? reject(e) : resolve(String(out))
    )
  );
}

/**
 * Polls the direct sources at most once per ttlMs; the mactop probe runs in
 * the background at the ring cadence and its last good reading is merged in.
 * Keeps the 1-min JSONL ring.
 */
export class SystemMonitor {
  private readonly file: string;
  private readonly telemetryPath: string;
  private readonly ttlMs: number;
  private readonly ringMs: number;
  private readonly probeMs: number;
  private readonly keepMs: number;
  private readonly staleMs: number;
  private readonly topTtlMs: number;
  private readonly run: (cmd: string, args: string[]) => Promise<string>;
  private readonly now: () => number;
  private cached: SystemSample | null = null;
  private cachedAt = 0;
  private lastRingT = 0;
  private ring: SystemSample[] | null = null;
  /** last good mactop probe and when it landed */
  private slow: SystemSample | null = null;
  private slowAt = 0;
  private slowErr = "";
  private slowP: Promise<void> | null = null;
  /** CPU load and when top last reported it */
  private topCpu: number | undefined;
  private topAt = 0;

  constructor(deps: SystemDeps = {}) {
    this.file = deps.file ?? systemRingFile();
    this.telemetryPath = deps.telemetryFile ?? telemetryFile();
    this.ttlMs = deps.ttlMs ?? 5_000;
    this.ringMs = deps.ringMs ?? MIN;
    this.probeMs = deps.probeMs ?? 5_000;
    this.keepMs = deps.keepMs ?? 7 * DAY;
    this.staleMs = deps.staleMs ?? SLOW_TTL;
    this.topTtlMs = deps.topTtlMs ?? TOP_TTL;
    this.run = deps.run ?? sh;
    this.now = deps.now ?? Date.now;
    void this.probe(); // warm power/temp/gpu so the first page does not wait ~10 s
  }

  /**
   * Keeps the ring filling while nobody has the cockpit open: samples are otherwise taken only when
   * a page polls /cockpit/system, so a closed browser left a gap in the power/memory charts while
   * the router kept serving requests. Returns the stop function.
   */
  startRing(): () => void {
    const timer = setInterval(() => void this.current().catch(() => undefined), this.ringMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  /** The last served reading without polling (null before the first `current()`); for cheap periodic readers. */
  cachedSample(): SystemSample | null {
    return this.cached;
  }

  /**
   * Latest reading, direct sources first; sample is null only when every
   * source failed (reason in the sample notes).
   */
  async current(): Promise<{ sample: SystemSample | null; why: string }> {
    const now = this.now();
    if (this.cached && now - this.cachedAt < this.ttlMs) return { sample: this.cached, why: "" };
    void this.probe(); // power/temp/gpu arrive later; the direct sources answer now
    const [vmOut, lvlOut, memOut, swOut, topOut] = await Promise.all([
      this.run("vm_stat", []).catch(() => undefined),
      this.run("sysctl", ["-n", "kern.memorystatus_level"]).catch(() => undefined),
      this.run("sysctl", ["-n", "hw.memsize"]).catch(() => undefined),
      this.run("sysctl", ["vm.swapusage"]).catch(() => undefined),
      now - this.topAt >= this.topTtlMs
        ? this.run(TOP_CMD, ["-l", "2", "-n", "0", "-s", "1"]).catch(() => undefined)
        : Promise.resolve(undefined),
    ]);
    if (topOut !== undefined) {
      const cpu = parseTopCpu(topOut);
      if (cpu !== undefined) {
        this.topCpu = cpu;
        this.topAt = now;
      }
    }
    const memTotal = num(Number(memOut?.trim()));
    const vm = vmOut === undefined ? undefined : parseVmStat(vmOut, memTotal);
    const level = lvlOut === undefined ? undefined : num(Number(lvlOut.trim()));
    const swap = swOut === undefined ? undefined : parseSwapUsage(swOut);
    const slowAge = this.slow ? now - this.slowAt : undefined;
    const slow = this.slow && slowAge !== undefined && slowAge <= this.staleMs ? this.slow : undefined;
    const notes: string[] = [];
    if (slow && slowAge! >= MIN) notes.push(`power/temp/gpu cached from the mactop probe ${Math.round(slowAge! / MIN)} min ago`);
    if (!slow) {
      notes.push(
        this.slow
          ? `power/temp/gpu stale: mactop probe last good ${Math.round((slowAge ?? 0) / MIN)} min ago, retrying`
          : `power/temp/gpu unavailable: ${this.slowErr || "mactop probe running"} (powermetrics would need sudo)`
      );
    }
    const cpuFresh = this.topCpu !== undefined && now - this.topAt <= this.staleMs;
    const sample: SystemSample = {
      t: now,
      ...(cpuFresh ? { cpu: this.topCpu } : {}),
      ...(memTotal ? { memTotal } : {}),
      ...(vm?.used ? { memUsed: vm.used } : {}),
      ...(vm ? { wired: vm.wired, compressed: vm.compressed } : {}),
      ...(swap ? { swapTotal: swap.total, swapUsed: swap.used } : {}),
      ...(level !== undefined ? { pressureLevel: level } : {}),
      // probe-exclusive fields only: memory and CPU load stay with the live sources
      ...(slow
        ? {
            gpu: slow.gpu,
            ane: slow.ane,
            gpuFreqMhz: slow.gpuFreqMhz,
            socTemp: slow.socTemp,
            cpuW: slow.cpuW,
            gpuW: slow.gpuW,
            aneW: slow.aneW,
            systemW: slow.systemW,
            totalW: slow.totalW,
          }
        : {}),
      source: "direct",
      ...(notes.length ? { notes } : {}),
    };
    this.cached = sample;
    this.cachedAt = now;
    if (now - this.lastRingT >= this.ringMs) {
      this.lastRingT = now;
      this.appendRing(sample);
    }
    return { sample, why: "" };
  }

  /** Runs the mactop probe if none is in flight and probeMs has elapsed. */
  probe(): Promise<void> {
    if (this.slowP) return this.slowP;
    const now = this.now();
    if (this.slow && now - this.slowAt < this.probeMs) return Promise.resolve();
    const p = this.mactop()
      .then((s) => {
        this.slow = s;
        this.slowAt = now;
        this.slowErr = "";
      })
      .catch((e: Error) => {
        this.slowErr = e.message.split("\n")[0] ?? "mactop probe failed";
      })
      .finally(() => {
        this.slowP = null;
      });
    this.slowP = p;
    return p;
  }

  private async mactop(): Promise<SystemSample> {
    let last: Error | undefined;
    for (const bin of MACTOP_CANDIDATES) {
      try {
        return parseMactopSample(
          await this.run(bin, ["--headless", "--interval", String(MACTOP_INTERVAL_MS), "--count", String(MACTOP_COUNT), "--format", "json"]),
          this.now()
        );
      } catch (e) {
        last = e as Error;
      }
    }
    throw last ?? new Error("mactop not found");
  }

  private appendRing(s: SystemSample): void {
    try {
      if (!this.ring) this.ring = this.readRing();
      this.ring.push(s);
      mkdirSync(dirname(this.file), { recursive: true });
      const keep = Math.ceil(this.keepMs / this.ringMs) + 240; // rewrite only past a day of slack
      const cutoff = this.now() - this.keepMs;
      if (this.ring.length > keep || this.ring[0]!.t < cutoff) {
        this.ring = this.ring.filter((x) => x.t >= cutoff);
        writeFileSync(this.file, this.ring.map((x) => JSON.stringify(x)).join("\n") + "\n");
      } else {
        appendFileSync(this.file, JSON.stringify(s) + "\n");
      }
    } catch {
      /* the ring is best-effort; the panel works without history */
    }
  }

  private readRing(): SystemSample[] {
    try {
      if (!existsSync(this.file)) return [];
      const out: SystemSample[] = [];
      for (const line of readFileSync(this.file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const s = JSON.parse(line) as SystemSample;
          if (typeof s.t === "number") out.push(s); // stale head is trimmed on the next append
        } catch {
          /* torn tail line from a crash: skip */
        }
      }
      this.lastRingT = out.at(-1)?.t ?? 0;
      return out;
    } catch {
      return [];
    }
  }

  private samples(): SystemSample[] {
    if (!this.ring) this.ring = this.readRing();
    return this.ring;
  }

  async snapshot(win: SystemWindow): Promise<SystemSnapshot> {
    const now = this.now();
    const { sample, why } = await this.current();
    const unavailable: Record<string, string> = {};
    const hasMetric = sample && Object.entries(sample).some(([k, v]) => k !== "t" && typeof v === "number");
    if (!hasMetric) unavailable.all = why || sample?.notes?.join("; ") || "no system source available";
    const slowAge = this.slow ? now - this.slowAt : undefined;
    const tfile = this.telemetryPath;
    const power = powerReading(now, tfile);
    return {
      now,
      window: win,
      bucketMs: WINDOWS[win].bucket,
      current: hasMetric ? sample : null,
      unavailable,
      series: buildSystemSeries(this.samples(), win, now, readTelemetryLines(tfile) ?? []),
      ...(slowAge !== undefined && slowAge <= this.staleMs ? { slowAgeS: Math.round(slowAge / 1000) } : {}),
      battery: batteryCockpitLine(now),
      ...(power ? { power } : {}),
    };
  }
}
