/**
 * system.ts — machine metrics for the cockpit SYSTEM panel. Sources, no sudo
 * anywhere:
 *
 *   direct   cheap no-sudo reads: CPU load from os.cpus() tick deltas (no
 *            subprocess), swap from `sysctl vm.swapusage`, memory total and
 *            pressure from `sysctl`, wired/compressed/used from `vm_stat`
 *   daemon   readings the daemon already takes, read from its state files — no
 *            subprocess per cockpit request: GPU load from the local-idle fast
 *            sampler (avg + peak of ~5 s ioreg instants), system watts from the
 *            battery guard's telemetry. ANE and the SoC power rails stay
 *            unsampled (mactop is never spawned; powermetrics needs sudo).
 *
 * Every 1-min sample is appended to a small JSONL ring (7 days) so day and
 * week windows chart power and memory history and report watt-hours. Metrics
 * a source does not give stay undefined; the panel shows "n/a" with the
 * sample's notes as tooltip.
 */

import { execFile } from "node:child_process";
import { cpus } from "node:os";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { paiHomePath } from "../config/pai-home.js";
import { dirname, join } from "node:path";
import { bucketStart, WINDOWS, type CockpitWindow } from "./cockpit.js";
import { batteryCockpitLine, readTelemetryLines, summarizeTelemetry, telemetryFile, type TelemetryLine } from "../daemon/battery-guard.js";
import { readLocalIdle, type LocalIdleFile } from "../workers/local-idle.js";
import { defaultWorkersConfig, expandHome } from "../workers/config.js";

export const systemRingFile = (): string => paiHomePath("logs", "router-system.jsonl");
/** The daemon's local-idle state (the GPU sampler's persisted 1-min summary). */
const defaultWorkersLogDir = (): string => process.env.PAI_HOME ? paiHomePath("logs", "workers") : expandHome(defaultWorkersConfig().logDir);
const MIN = 60_000;
const DAY = 86_400_000;
/** direct commands are sub-second; never wait longer */
const CMD_TIMEOUT = 8_000;

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
  /** peak GPU % of the last minute's ~5 s instants (daemon sampler), beside the avg `gpu` */
  gpuPeak?: number;
  source: "direct" | "mactop" | "vmstat";
  /** why metrics are missing or stale, shown as tooltip */
  notes?: string[];
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export interface VmStat {
  pageSize: number;
  wired: number;
  compressed: number;
  used: number;
  free: number;
  /** What a new allocation can take, bytes: free + inactive + speculative + purgeable — the same sum macOS calls "available". */
  available: number;
}

/** `vm_stat` output → bytes; used = total - reclaimable (free+speculative+inactive). */
export function parseVmStat(out: string, memTotal: number | undefined): VmStat | undefined {
  const pages = (label: string): number | undefined => {
    // the trailing dot is consumed by [^0-9], not `.`: a real vm_stat line ends "123." and '.' would match any digit of a zero-padded page count (a 0-page line read as its first digit)
    const m = new RegExp(`${label}:\\s+(\\d+)[^0-9]`).exec(out);
    return m ? Number(m[1]) : undefined;
  };
  const size = /page size of (\d+) bytes/.exec(out);
  const pageSize = size ? Number(size[1]) : 16_384;
  const wired = pages("Pages wired down");
  const compressed = pages("Pages occupied by compressor");
  const free = pages("Pages free");
  const speculative = pages("Pages speculative") ?? 0;
  const inactive = pages("Pages inactive") ?? 0;
  const purgeable = pages("Pages purgeable") ?? 0;
  if (wired === undefined || compressed === undefined || free === undefined) return undefined;
  const reclaimable = (free + speculative + inactive) * pageSize;
  const available = (free + inactive + speculative + purgeable) * pageSize;
  const used = memTotal !== undefined ? Math.max(0, memTotal - reclaimable) : undefined;
  return { pageSize, wired: wired * pageSize, compressed: compressed * pageSize, used: used ?? 0, free: free * pageSize, available };
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

/** Summed CPU ticks of all cores (busy, total); load is the delta between two readings, no subprocess. */
export function cpuTicks(): { busy: number; total: number } {
  let busy = 0;
  let total = 0;
  for (const c of cpus()) {
    const t = c.times;
    const all = t.user + t.nice + t.sys + t.idle + t.irq;
    total += all;
    busy += all - t.idle;
  }
  return { busy, total };
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
  /** peak GPU % in the bucket, beside its avg `gpu` (the tile shows both; the sparkline stays the averages) */
  gpuPeak?: number;
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
  /** bucket index -> max GPU peak of its samples (a peak is a max over the bucket, not an average) */
  const gpuPeaks = new Map<number, number>();

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
      if (typeof s.gpuPeak === "number") gpuPeaks.set(b, Math.max(gpuPeaks.get(b) ?? 0, s.gpuPeak));
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
    // the bucket's peak GPU rides beside its average (the instant read jumps 0↔97 within seconds)
    const gp = gpuPeaks.get(i);
    if (gp !== undefined) b.gpuPeak = gp;
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
  /** Why a metric can never be shown here (tooltip); e.g. the SoC temperature needs sudo. */
  hints?: Record<string, string>;
}

/** Shown while no source gives a SoC temperature without sudo (powermetrics is root-only; AppleSmartBattery has no temp key). */
export const SOC_TEMP_HINT = "SoC temperature needs sudo (powermetrics); no non-sudo source on this Mac";

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
  /** ring retention */
  keepMs?: number;
  /** injectable command runner (tests) */
  run?: (cmd: string, args: string[]) => Promise<string>;
  /** the daemon's local-idle state dir (GPU sampler summary); default the workers logDir */
  workersLogDir?: () => string;
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
  private readonly keepMs: number;
  private readonly run: (cmd: string, args: string[]) => Promise<string>;
  private readonly idleDir: () => string;
  private readonly now: () => number;
  private cached: SystemSample | null = null;
  private cachedAt = 0;
  private lastRingT = 0;
  private ring: SystemSample[] | null = null;
  /** CPU load and when top last reported it */
  private topCpu: number | undefined;
  private prevTicks = cpuTicks();

  constructor(deps: SystemDeps = {}) {
    this.file = deps.file ?? systemRingFile();
    this.telemetryPath = deps.telemetryFile ?? telemetryFile();
    this.ttlMs = deps.ttlMs ?? 5_000;
    this.ringMs = deps.ringMs ?? MIN;
    this.keepMs = deps.keepMs ?? 7 * DAY;
    this.run = deps.run ?? sh;
    this.idleDir = deps.workersLogDir ?? defaultWorkersLogDir;
    this.now = deps.now ?? Date.now;
  }

  /** The daemon's local-idle GPU summary (the ~5 s sampler's 1-min avg/peak), null with no fresh sample. */
  private gpuSample(now: number): { avg: number; peak?: number; at: number } | undefined {
    let f: LocalIdleFile | null = null;
    try {
      f = readLocalIdle(this.idleDir());
    } catch {
      /* the daemon has not written yet */
    }
    if (!f) return undefined;
    const at = Date.parse(f.at);
    if (!Number.isFinite(at) || now - at > 120_000) return undefined; // stale: the sampler stopped
    const avg = f.gpuAvgPct ?? (f.gpuPct === null ? undefined : Math.round(f.gpuPct));
    if (typeof avg !== "number") return undefined;
    return { avg, ...(f.gpuPeakPct != null ? { peak: f.gpuPeakPct } : {}), at };
  }

  /** System watts from the battery guard's latest telemetry line (its own tick reads ioreg; none here). */
  private powerWatts(now: number): { w?: number; at: number } | undefined {
    const lines = readTelemetryLines(this.telemetryPath);
    const l = lines?.at(-1);
    if (!l) return undefined;
    const at = typeof l.at === "number" ? l.at : Date.parse(String(l.at));
    if (!Number.isFinite(at) || now - at > 30 * 60_000) return undefined; // stale: the guard stopped
    const w = l.systemLoadW ?? undefined;
    return { ...(w !== undefined && !implausibleW(w) ? { w } : {}), at };
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
    const [vmOut, lvlOut, memOut, swOut] = await Promise.all([
      this.run("vm_stat", []).catch(() => undefined),
      this.run("sysctl", ["-n", "kern.memorystatus_level"]).catch(() => undefined),
      this.run("sysctl", ["-n", "hw.memsize"]).catch(() => undefined),
      this.run("sysctl", ["vm.swapusage"]).catch(() => undefined),
    ]);
    const ticks = cpuTicks();
    if (ticks.total > this.prevTicks.total) this.topCpu = (100 * (ticks.busy - this.prevTicks.busy)) / (ticks.total - this.prevTicks.total);
    this.prevTicks = ticks;
    const memTotal = num(Number(memOut?.trim()));
    const vm = vmOut === undefined ? undefined : parseVmStat(vmOut, memTotal);
    const level = lvlOut === undefined ? undefined : num(Number(lvlOut.trim()));
    const swap = swOut === undefined ? undefined : parseSwapUsage(swOut);
    const notes: string[] = ["ANE and the SoC power rails are not sampled (mactop is never spawned; powermetrics needs sudo)"];
    const cpuFresh = this.topCpu !== undefined;
    // the daemon's own readings, merged in without any subprocess here: GPU from the local-idle
    // fast sampler's persisted summary, watts from the battery guard's telemetry line
    const gpu = this.gpuSample(now);
    if (gpu) {
      notes.push(`GPU avg ${Math.round(gpu.avg)}% of ~5 s samples (${Math.round((now - gpu.at) / 1000)}s ago)`);
      if (gpu.peak !== undefined) notes.push(`GPU peak ${Math.round(gpu.peak)}%`);
    } else {
      notes.push("GPU unavailable: the daemon's sampler has no fresh sample (local-idle off?)");
    }
    const pw = this.powerWatts(now);
    if (pw?.w !== undefined) notes.push(`system watts from the battery guard's ioreg telemetry (${Math.round((now - pw.at) / 1000)}s ago)`);
    else if (!pw) notes.push("power unavailable: no battery guard telemetry line");
    const sample: SystemSample = {
      t: now,
      ...(cpuFresh ? { cpu: this.topCpu } : {}),
      ...(gpu ? { gpu: gpu.avg } : {}),
      ...(gpu?.peak !== undefined ? { gpuPeak: gpu.peak } : {}),
      ...(pw?.w !== undefined ? { systemW: pw.w, totalW: pw.w } : {}),
      ...(memTotal ? { memTotal } : {}),
      ...(vm?.used ? { memUsed: vm.used } : {}),
      ...(vm ? { wired: vm.wired, compressed: vm.compressed } : {}),
      ...(swap ? { swapTotal: swap.total, swapUsed: swap.used } : {}),
      ...(level !== undefined ? { pressureLevel: level } : {}),
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
    const tfile = this.telemetryPath;
    const power = powerReading(now, tfile);
    return {
      now,
      window: win,
      bucketMs: WINDOWS[win].bucket,
      current: hasMetric ? sample : null,
      unavailable,
      series: buildSystemSeries(this.samples(), win, now, readTelemetryLines(tfile) ?? []),
      battery: batteryCockpitLine(now),
      ...(power ? { power } : {}),
      hints: { "soc-temp": SOC_TEMP_HINT },
    };
  }
}
