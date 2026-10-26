/**
 * battery-guard.ts — the machine must not run out of battery on local-model
 * work. macOS only (pmset); a no-op on every other platform.
 *
 * The daemon samples `pmset -g batt` every power.batteryGuard.intervalSecs
 * (default 60). Three rules ride the readings:
 *
 *   draining on AC   on AC power but the percent falls over the last K
 *                    readings: a warning to the daemon log and the cockpit
 *                    ("battery draining on AC: 62 % → 55 % in 10 min") —
 *                    usually a charger that supplies less than the machine
 *                    draws. Nothing is stopped for it.
 *   pause            at or below power.batteryGuard.pauseBelowPct (default 25)
 *                    new local-model work is refused at the worker gate and
 *                    the scheduled memory index/embed passes do not start,
 *                    with the reason in both places.
 *   stop             at or below power.batteryGuard.stopBelowPct (default 12)
 *                    running local-model work ends cleanly: workers through
 *                    the `pai worker kill` path (salvage as on any stop),
 *                    the embed/index passes stop, and runtimes PAI started
 *                    stop through their configured `models.runtimes.<name>.stop`.
 *                    Each stop is recorded in the ledger.
 *
 * Admission resumes only above pauseBelowPct + hysteresisPct (default 10), so
 * a battery hovering at the threshold never opens and closes the gate.
 * Benchmark / performance runs (strata-bench, the night queue runner, any run
 * labelled benchmark, or a plain script that holds the marker file
 * <PAI home>/state/benchmark-run.json {pid, label, startedAt} while its pid is
 * alive) are exempt from pause and the normal stop: a paused machine would
 * corrupt the measurement. The guard records telemetry every tick, benchmark
 * or not (battery-telemetry.jsonl: adapter watts, SystemPowerIn, SystemLoad,
 * battery watts, percent, from `ioreg -rn AppleSmartBattery`; lines older than
 * 14 days are dropped once a day or when the file passes 5 MB) and, for a
 * benchmark, warns at pauseBelowPct. Their last-resort stop leaves time to save: at or
 * below benchmarkStopBelowPct (default 15), or earlier when the drain rate over
 * the last drainWindowReadings readings projects benchmarkProjectFloorPct
 * (default 10) within benchmarkProjectMins (default 20). No new benchmark item
 * starts; the running item gets SIGTERM and up to benchmarkSaveSecs (default
 * 120) to write its result/progress files; then PAI-started runtimes stop. A
 * marker pid gets the SIGTERM first and is waited on up to that long.
 *
 * Cloud workers and the operator's interactive sessions are never touched:
 * only headless runs on loopback providers are refused or stopped, and chat
 * panes are skipped by the stop pass.
 *
 * The pause state lives in a file the worker CLI (a separate process) reads
 * at admission; the last reading and the drain warning live in a second file
 * the cockpit reads.
 */

import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { paiHomePath } from "../config/pai-home.js";
import { appendLedger } from "../workers/ledger.js";
import { ledgerPath } from "../workers/paths.js";
import { isLocalProvider } from "../workers/config.js";
import { isChatPane, isLive, loadStatuses, waitForTerminalStatus } from "../workers/status.js";
import { killTree } from "../workers/kill-tree.js";
import { readRuntimeCommands, runRuntimeOp, liveRuntimeOpDeps } from "../workers/model-runtimes.js";
import { readLocalStatus } from "../workers/local-status.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface BatteryGuardConfig {
  /** Off = no sampling, no gate, no stops. Default true (macOS only anyway). */
  enabled: boolean;
  /** Seconds between pmset readings. Default 60. */
  intervalSecs: number;
  /** Pause new local work at or below this percent. Default 25. */
  pauseBelowPct: number;
  /** Stop running local work at or below this percent. Default 12. */
  stopBelowPct: number;
  /** Admission resumes only above pauseBelowPct + this. Default 10. */
  hysteresisPct: number;
  /** Readings the draining-on-AC check looks back over. Default 10. */
  drainWindowReadings: number;
  /** Last-resort stop for benchmark runs at or below this percent. Default 15. */
  benchmarkStopBelowPct: number;
  /** Early benchmark stop when the drain rate projects this percent ... Default 10. */
  benchmarkProjectFloorPct: number;
  /** ... within this many minutes. Default 20. */
  benchmarkProjectMins: number;
  /** Seconds a stopped benchmark item gets to write its result/progress files. Default 120. */
  benchmarkSaveSecs: number;
  /** Keep-above gate (battery-gate.ts): new local work waits below this percent. null = off. */
  keepAbovePct: number | null;
  /** ... and starts again at this percent. Default keepAbovePct + 5. */
  resumeAtPct: number | null;
}

export const BATTERY_GUARD_DEFAULTS: BatteryGuardConfig = {
  enabled: true,
  intervalSecs: 60,
  pauseBelowPct: 25,
  stopBelowPct: 12,
  hysteresisPct: 10,
  drainWindowReadings: 10,
  benchmarkStopBelowPct: 15,
  benchmarkProjectFloorPct: 10,
  benchmarkProjectMins: 20,
  benchmarkSaveSecs: 120,
  keepAbovePct: null,
  resumeAtPct: null,
};

/** The effective config: the shipped/loaded `power.batteryGuard` block over the code defaults. */
export function batteryGuardConfig(power: unknown): BatteryGuardConfig {
  const block = (power as { batteryGuard?: Record<string, unknown> } | undefined)?.batteryGuard ?? {};
  const num = (k: keyof BatteryGuardConfig, d: number): number =>
    typeof block[k] === "number" && Number.isFinite(block[k] as number) ? (block[k] as number) : d;
  return {
    enabled: typeof block.enabled === "boolean" ? block.enabled : BATTERY_GUARD_DEFAULTS.enabled,
    intervalSecs: num("intervalSecs", BATTERY_GUARD_DEFAULTS.intervalSecs),
    pauseBelowPct: num("pauseBelowPct", BATTERY_GUARD_DEFAULTS.pauseBelowPct),
    stopBelowPct: num("stopBelowPct", BATTERY_GUARD_DEFAULTS.stopBelowPct),
    hysteresisPct: num("hysteresisPct", BATTERY_GUARD_DEFAULTS.hysteresisPct),
    drainWindowReadings: num("drainWindowReadings", BATTERY_GUARD_DEFAULTS.drainWindowReadings),
    benchmarkStopBelowPct: num("benchmarkStopBelowPct", BATTERY_GUARD_DEFAULTS.benchmarkStopBelowPct),
    benchmarkProjectFloorPct: num("benchmarkProjectFloorPct", BATTERY_GUARD_DEFAULTS.benchmarkProjectFloorPct),
    benchmarkProjectMins: num("benchmarkProjectMins", BATTERY_GUARD_DEFAULTS.benchmarkProjectMins),
    benchmarkSaveSecs: num("benchmarkSaveSecs", BATTERY_GUARD_DEFAULTS.benchmarkSaveSecs),
    keepAbovePct: typeof block.keepAbovePct === "number" && Number.isFinite(block.keepAbovePct) ? block.keepAbovePct : null,
    resumeAtPct:
      typeof block.resumeAtPct === "number" && Number.isFinite(block.resumeAtPct)
        ? block.resumeAtPct
        : typeof block.keepAbovePct === "number" && Number.isFinite(block.keepAbovePct)
          ? block.keepAbovePct + 5
          : null,
  };
}

// ---------------------------------------------------------------------------
// pmset parsing (pure)
// ---------------------------------------------------------------------------

export type PowerSource = "ac" | "battery";
export type ChargeState = "charging" | "discharging" | "charged" | "unknown";

export interface BatteryReading {
  at: number;
  /** Battery charge percent; null when pmset names no internal battery (a desktop). */
  pct: number | null;
  source: PowerSource;
  charge: ChargeState;
}

/**
 * Parse `pmset -g batt` stdout. Real sample (macOS, 2026-10-24):
 *   Now drawing from 'AC Power'
 *    -InternalBattery-0 (id=37290083)\t92%; charging; 1:02 remaining present: true
 * Unparsable output returns null: a failed read must never look like a reading.
 */
export function parsePmsetBatt(stdout: string, at: number = Date.now()): BatteryReading | null {
  const src = /Now drawing from '(AC|Battery) Power'/.exec(stdout);
  if (!src) return null;
  const source: PowerSource = src[1] === "AC" ? "ac" : "battery";
  // pmset separates the battery line's fields with a tab:
  // `-InternalBattery-0 (id=…)\t92%; charging; …`
  const batt = /InternalBattery-\d+[^\n]*?\s(\d+)%\s*;\s*(charging|discharging|charged|finishing charge)/.exec(stdout);
  const charge: ChargeState =
    batt?.[2] === "charging" || batt?.[2] === "finishing charge" ? "charging"
      : batt?.[2] === "charged" ? "charged"
        : batt?.[2] === "discharging" ? "discharging"
          : source === "ac" ? "unknown" : "discharging";
  return { at, pct: batt ? Number(batt[1]) : null, source, charge };
}

/** One pmset run; null when the command fails or the output is not parsable. */
export function readBattery(now: number = Date.now()): Promise<BatteryReading | null> {
  if (process.platform !== "darwin") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("pmset", ["-g", "batt"], { timeout: 5000 }, (err, stdout) =>
      resolve(err ? null : parsePmsetBatt(stdout, now))
    );
  });
}

// ---------------------------------------------------------------------------
// ioreg power telemetry (pure parser)
// ---------------------------------------------------------------------------

export interface PowerTelemetry {
  at: number;
  /** AdapterDetails "Watts": what the charger can supply (W); null with no adapter. */
  adapterWatts: number | null;
  /** PowerTelemetryData SystemPowerIn (W): drawn from the adapter. */
  systemPowerInW: number | null;
  /** PowerTelemetryData SystemLoad (W): what the machine consumes. */
  systemLoadW: number | null;
  /** PowerTelemetryData BatteryPower (W): negative = discharging. */
  batteryW: number | null;
  /** Top-level CurrentCapacity (percent). */
  pct: number | null;
}

/** ioreg prints negative numbers as unsigned 64-bit; read them back signed. */
function signed64(digits: string): number {
  return Number(BigInt.asIntN(64, BigInt(digits)));
}

/**
 * Parse `ioreg -rn AppleSmartBattery` stdout. Real keys (macOS, 2026-10-24):
 *   "AdapterDetails" = {...,"Watts"=100,...}
 *   "PowerTelemetryData" = {...,"SystemLoad"=68735,...,"SystemPowerIn"=68514,...,"BatteryPower"=18446744073709551395}
 *   "CurrentCapacity" = 100
 * Telemetry values are milliwatts. Missing keys give null; no AppleSmartBattery
 * at all gives null for the whole reading.
 */
export function parseIoregPower(stdout: string, at: number = Date.now()): PowerTelemetry | null {
  if (!/"(CurrentCapacity|PowerTelemetryData|AdapterDetails)"/.test(stdout)) return null;
  const block = (key: string): string => new RegExp(`"${key}"\\s*=\\s*\\{([^\\n]*)\\}`).exec(stdout)?.[1] ?? "";
  const field = (text: string, key: string): string | null => new RegExp(`"${key}"=(-?\\d+)`).exec(text)?.[1] ?? null;
  const w = (v: string | null): number | null => (v === null ? null : Math.round((signed64(v) / 1000) * 100) / 100);
  const tel = block("PowerTelemetryData");
  const adapter = field(block("AdapterDetails"), "Watts");
  const cap = /^\s*\|?\s*"CurrentCapacity"\s*=\s*(\d+)/m.exec(stdout)?.[1];
  return {
    at,
    adapterWatts: adapter === null ? null : Number(adapter),
    systemPowerInW: w(field(tel, "SystemPowerIn")),
    systemLoadW: w(field(tel, "SystemLoad")),
    batteryW: w(field(tel, "BatteryPower")),
    pct: cap === undefined ? null : Number(cap),
  };
}

/** One ioreg run; null on failure or off macOS. */
export function readPowerTelemetry(now: number = Date.now()): Promise<PowerTelemetry | null> {
  if (process.platform !== "darwin") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("ioreg", ["-rn", "AppleSmartBattery"], { timeout: 5000, maxBuffer: 4 << 20 }, (err, stdout) =>
      resolve(err ? null : parseIoregPower(stdout, now))
    );
  });
}

// ---------------------------------------------------------------------------
// Benchmark runs (pure)
// ---------------------------------------------------------------------------

/** A run marked benchmark: its label names strata-bench, the night queue, or says bench/benchmark. */
export function isBenchmarkLabel(label: string | undefined | null): boolean {
  return !!label && /strata-bench|night[- ]?queue|\bbench(mark)?\b/i.test(label);
}

/** Percent per minute lost over the last `windowReadings` readings; null when too short or not falling. */
export function drainRatePctPerMin(readings: BatteryReading[], windowReadings: number): number | null {
  const win = readings.filter((x) => x.pct !== null).slice(-windowReadings);
  const first = win[0];
  const last = win.at(-1);
  if (!first || !last || win.length < Math.min(windowReadings, 5)) return null;
  const mins = (last.at - first.at) / 60_000;
  if (mins < 4) return null;
  const rate = ((first.pct as number) - (last.pct as number)) / mins;
  return rate > 0 ? rate : null;
}

export interface BenchmarkVerdict {
  state: BatteryState;
  /** Warn (log + ledger) that the battery is at pauseBelowPct while a benchmark runs; once per spell. */
  warn: boolean;
  /** Last-resort stop starts now (one move; latched until the battery recovers). */
  stop: boolean;
  /** Why the stop fired; null without one. */
  reason: string | null;
  drainRate: number | null;
}

/**
 * Benchmark rules on a state that already holds `r` (evaluateBattery ran
 * first): warn at pauseBelowPct, stop at benchmarkStopBelowPct or when the
 * drain rate projects benchmarkProjectFloorPct within benchmarkProjectMins.
 */
export function evaluateBenchmark(state: BatteryState, r: BatteryReading, cfg: BatteryGuardConfig): BenchmarkVerdict {
  const next: BatteryState = { ...state };
  const none = { state: next, warn: false, stop: false, reason: null, drainRate: null as number | null };
  if (!cfg.enabled || r.pct === null) return none;
  const rate = drainRatePctPerMin(state.readings, cfg.drainWindowReadings);
  none.drainRate = rate;
  const projected = rate === null ? null : r.pct - rate * cfg.benchmarkProjectMins;
  const early = projected !== null && projected <= cfg.benchmarkProjectFloorPct;
  if (next.benchStopped) {
    if (r.pct > cfg.benchmarkStopBelowPct + cfg.hysteresisPct && !early) next.benchStopped = false;
    return { ...none, state: next };
  }
  let warn = false;
  if (r.pct <= cfg.pauseBelowPct) {
    warn = !next.benchWarned;
    next.benchWarned = true;
  } else if (r.pct > cfg.pauseBelowPct + cfg.hysteresisPct) {
    next.benchWarned = false;
  }
  let reason: string | null = null;
  if (r.pct <= cfg.benchmarkStopBelowPct) {
    reason = `battery at ${r.pct} % (at or below power.batteryGuard.benchmarkStopBelowPct ${cfg.benchmarkStopBelowPct})`;
  } else if (early && rate !== null) {
    reason =
      `battery at ${r.pct} %, draining ${rate.toFixed(2)} %/min: projects ${Math.max(0, Math.round(projected as number))} % ` +
      `within ${cfg.benchmarkProjectMins} min (floor ${cfg.benchmarkProjectFloorPct} %)`;
  }
  if (reason) next.benchStopped = true;
  return { state: next, warn, stop: reason !== null, reason, drainRate: rate };
}

// ---------------------------------------------------------------------------
// The state machine (pure)
// ---------------------------------------------------------------------------

export type BatteryPhase = "ok" | "paused" | "stopped";

export interface BatteryState {
  /** "ok" → "paused" → "stopped"; admission resumes only above pauseBelowPct + hysteresisPct. */
  phase: BatteryPhase;
  /** Recent readings, oldest first; the drain window reads the last `drainWindowReadings` of them. */
  readings: BatteryReading[];
  /** Epoch ms of the last draining-on-AC warning (repeats at most once per window). */
  lastDrainWarnAt: number | null;
  /** Epoch ms of the last stop sweep (one sweep per spell, not one per tick). */
  lastStopAt: number | null;
  /** Benchmark last-resort stop latched (cleared above benchmarkStopBelowPct + hysteresisPct and no projection). */
  benchStopped: boolean;
  /** Epoch ms of the last benchmark low-battery warning (once per spell). */
  benchWarned: boolean;
}

export const emptyBatteryState = (): BatteryState => ({
  phase: "ok",
  readings: [],
  lastDrainWarnAt: null,
  lastStopAt: null,
  benchStopped: false,
  benchWarned: false,
});

/** Readings kept: enough to cover the drain window with slack. */
const KEEP_READINGS = 60;

export interface BatteryVerdict {
  state: BatteryState;
  /** A draining-on-AC warning is due now (first spell crossing the window). */
  drainWarn: boolean;
  /** ok → paused. */
  paused: boolean;
  /** paused → stopped: stop the running local work now. */
  stopped: boolean;
  /** paused/stopped → ok: admission opens again. */
  resumed: boolean;
}

/**
 * One guard step; pure. The phase only moves while a battery percent exists
 * (a desktop with no battery never pauses anything); the drain check needs a
 * percent on AC. A reading with no percent refreshes the window but cannot
 * move the phase.
 */
export function evaluateBattery(
  state: BatteryState,
  r: BatteryReading,
  cfg: BatteryGuardConfig,
  /** true = the daemon is shutting down: no stops, no pause moves. */
  shutdown = false
): BatteryVerdict {
  const readings = [...state.readings, r].slice(-KEEP_READINGS);
  const next: BatteryState = { ...state, readings };
  let drainWarn = false;
  if (cfg.enabled && r.source === "ac" && r.charge !== "charging" && r.pct !== null) {
    const win = readings.slice(-cfg.drainWindowReadings);
    const first = win[0];
    if (win.length >= cfg.drainWindowReadings && first.pct !== null && r.pct <= first.pct - 1) {
      // one warning per drain spell: repeat only after a full window has passed
      if (next.lastDrainWarnAt === null || r.at - next.lastDrainWarnAt >= cfg.drainWindowReadings * cfg.intervalSecs * 1000) {
        drainWarn = true;
        next.lastDrainWarnAt = r.at;
      }
    }
  }
  if (shutdown || !cfg.enabled || r.pct === null) return { state: next, drainWarn, paused: false, stopped: false, resumed: false };
  if (next.phase === "ok") {
    if (r.pct <= cfg.stopBelowPct) {
      next.phase = "stopped";
      next.lastStopAt = r.at;
      return { state: next, drainWarn, paused: true, stopped: true, resumed: false };
    }
    if (r.pct <= cfg.pauseBelowPct) {
      next.phase = "paused";
      return { state: next, drainWarn, paused: true, stopped: false, resumed: false };
    }
    return { state: next, drainWarn, paused: false, stopped: false, resumed: false };
  }
  if (next.phase === "paused") {
    if (r.pct <= cfg.stopBelowPct) {
      next.phase = "stopped";
      next.lastStopAt = r.at;
      return { state: next, drainWarn, paused: false, stopped: true, resumed: false };
    }
    if (r.pct > cfg.pauseBelowPct + cfg.hysteresisPct) {
      next.phase = "ok";
      return { state: next, drainWarn, paused: false, stopped: false, resumed: true };
    }
    return { state: next, drainWarn, paused: false, stopped: false, resumed: false };
  }
  // stopped: the way out is the same hysteresis line, never straight back to running work
  if (r.pct > cfg.pauseBelowPct + cfg.hysteresisPct) {
    next.phase = "ok";
    return { state: next, drainWarn, paused: false, stopped: false, resumed: true };
  }
  return { state: next, drainWarn, paused: false, stopped: false, resumed: false };
}

/** "battery draining on AC: 62 % → 55 % in 10 min" — the log and cockpit line. */
export function drainLine(readings: BatteryReading[], cfg: BatteryGuardConfig): string | null {
  const win = readings.slice(-cfg.drainWindowReadings);
  const first = win[0];
  const last = win.at(-1);
  if (!first || !last || first.pct === null || last.pct === null) return null;
  const mins = Math.max(1, Math.round((last.at - first.at) / 60_000));
  return `battery draining on AC: ${first.pct} % → ${last.pct} % in ${mins} min`;
}

// ---------------------------------------------------------------------------
// On-disk state
// ---------------------------------------------------------------------------

/** What the worker gate (a separate process) reads: is new local work admitted? */
export interface BatteryGateFile {
  at: string;
  phase: BatteryPhase;
  pct: number | null;
  source: PowerSource | null;
  /** Why admission is refused while paused/stopped; null when open. */
  reason: string | null;
  /** Benchmark last-resort stop latched: no new benchmark item starts. */
  benchStop?: boolean;
  /** Why; null when not latched. */
  benchReason?: string | null;
}

/** What the cockpit reads: the last reading and the drain warning. */
export interface BatteryCockpitFile {
  at: string;
  pct: number | null;
  source: PowerSource | null;
  charge: ChargeState | null;
  phase: BatteryPhase;
  /** The draining-on-AC warning line, null when nothing is draining. */
  drainingOnAc: string | null;
}

const gateFile = (): string => paiHomePath("battery-guard.json");
const cockpitFile = (): string => paiHomePath("battery-cockpit.json");

export function readBatteryGate(): BatteryGateFile | null {
  try {
    return JSON.parse(readFileSync(gateFile(), "utf8")) as BatteryGateFile;
  } catch {
    return null;
  }
}

export function readBatteryCockpit(): BatteryCockpitFile | null {
  try {
    return JSON.parse(readFileSync(cockpitFile(), "utf8")) as BatteryCockpitFile;
  } catch {
    return null;
  }
}

function writeJson(path: string, v: unknown): void {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(v), "utf8");
  } catch {
    /* state files are extras: never fail a tick over them */
  }
}

const pauseReason = (pct: number, cfg: BatteryGuardConfig, stopped: boolean): string =>
  stopped
    ? `battery at ${pct} % (at or below power.batteryGuard.stopBelowPct ${cfg.stopBelowPct})`
    : `battery at ${pct} % (at or below power.batteryGuard.pauseBelowPct ${cfg.pauseBelowPct})`;

// ---------------------------------------------------------------------------
// The stop pass
// ---------------------------------------------------------------------------

/**
 * Live headless runs on loopback providers, leaves first. Chat panes (the
 * operator's interactive sessions) and cloud providers are never in this list.
 */
export function localKillTargets(
  logDir: string,
  providers: Record<string, { baseUrl: string }>,
  /** true = the benchmark runs; false (default) = every other local run. */
  benchmark = false
): string[] {
  const statuses = loadStatuses(logDir).filter(
    (s) =>
      !isChatPane(s) &&
      isLive(s) &&
      (s.state === "running" || s.state === "queued") &&
      isLocalProvider(providers[s.provider]?.baseUrl ?? "") &&
      isBenchmarkLabel(s.label) === benchmark
  );
  const ids = new Set(statuses.map((s) => s.id));
  // deepest first: a parent's kill takes its descendants anyway, but leaves
  // first is what killTree does for a tree, and each id is killed on its own
  const depth = (id: string, seen = new Set<string>()): number => {
    const s = statuses.find((x) => x.id === id);
    if (!s || !s.parent || seen.has(s.parent)) return 0;
    seen.add(id);
    return 1 + depth(s.parent, seen);
  };
  return [...ids].sort((a, b) => depth(b) - depth(a));
}

// ---------------------------------------------------------------------------
// The benchmark marker (a plain script that is not a pai worker)
// ---------------------------------------------------------------------------

export interface BenchmarkMarker {
  pid: number;
  label: string;
  startedAt: string;
}

const markerFile = (): string => paiHomePath("state", "benchmark-run.json");

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The marker of a live benchmark script; a stale file (dead pid, unreadable) is removed and gives null. */
export function liveBenchmarkMarker(alive: (pid: number) => boolean = pidAlive): BenchmarkMarker | null {
  let m: BenchmarkMarker;
  try {
    m = JSON.parse(readFileSync(markerFile(), "utf8")) as BenchmarkMarker;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    rmSync(markerFile(), { force: true });
    return null;
  }
  if (Number.isInteger(m?.pid) && m.pid > 0 && alive(m.pid)) return m;
  rmSync(markerFile(), { force: true });
  return null;
}

export interface BatteryStopDeps {
  /** Benchmark stop: SIGTERM the marker pid (default process.kill). */
  signalPid?: (pid: number) => void;
  /** Liveness of the marker pid (default kill -0). */
  pidAlive?: (pid: number) => boolean;
  /** Wait step while the marker pid exits (default setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /** End one worker through the `pai worker kill` path (salvage as on any stop). */
  killWorker?: (logDir: string, id: string) => Promise<string[]>;
  /** Stop a runtime PAI started, through its configured stop command. */
  stopRuntime?: (runtime: string) => Promise<{ ok: boolean; message: string }>;
  /** The runtimes to stop: running local servers whose name is a configured runtime. */
  runtimesToStop?: (logDir: string) => string[];
  now?: () => number;
  /** Benchmark stop: wait up to this long for each run's own terminal status (it writes result/progress files). */
  saveMs?: number;
  /** Benchmark stop: ledger/log facts (percent, drain rate). */
  facts?: string;
}

/**
 * Stop the running local-model work: each live local-provider worker through
 * killTree (`by: "battery guard"` — the run's SIGTERM handler salvages as on
 * any stop), then the runtimes PAI started. Every stop lands in the ledger.
 */
export async function stopLocalWork(
  logDir: string,
  providers: Record<string, { baseUrl: string }>,
  why: string,
  deps: BatteryStopDeps = {}
): Promise<string[]> {
  const now = deps.now ?? Date.now;
  const benchmark = deps.saveMs !== undefined;
  const kill =
    deps.killWorker ??
    ((dir, id) =>
      killTree(dir, id, {
        only: true,
        by: "battery guard",
        reason: why,
        // SIGTERM, then the run's own terminal status is awaited this long: time to save
        ...(benchmark ? { deps: { waitTerminal: (d: string, i: string) => waitForTerminalStatus(d, i, deps.saveMs) } } : {}),
      }));
  const lines: string[] = [];
  const stopEvent = benchmark ? "BATTERY-BENCH-STOP" : "BATTERY-STOP";
  if (benchmark) {
    const alive = deps.pidAlive ?? pidAlive;
    const marker = liveBenchmarkMarker(alive);
    if (marker) {
      try {
        (deps.signalPid ?? ((pid) => process.kill(pid, "SIGTERM")))(marker.pid);
        lines.push(`sent SIGTERM to benchmark script ${marker.label} (pid ${marker.pid})`);
        const sleep = deps.sleep ?? ((ms) => new Promise<void>((res) => setTimeout(res, ms)));
        const deadline = now() + (deps.saveMs ?? 0);
        while (alive(marker.pid) && now() < deadline) await sleep(1000);
        lines.push(alive(marker.pid) ? `benchmark script pid ${marker.pid} still running after the save window` : `benchmark script pid ${marker.pid} exited`);
      } catch (e) {
        lines.push(`benchmark script pid ${marker.pid}: battery stop failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  for (const id of localKillTargets(logDir, providers, benchmark)) {
    try {
      lines.push(...(await kill(logDir, id)));
    } catch (e) {
      lines.push(`worker ${id}: battery stop failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  appendLedger(
    ledgerPath(logDir),
    stopEvent,
    { reason: why, facts: deps.facts, saved: benchmark ? "SIGTERM + result/progress save window" : undefined, workers: lines.length ? lines.join(" | ").slice(0, 400) : "-" },
    new Date(now())
  );
  const stopRuntime =
    deps.stopRuntime ??
    ((runtime) => runRuntimeOp(runtime, "stop", readRuntimeCommands(), liveRuntimeOpDeps, homedir()));
  // a normal stop never takes the model out from under a live benchmark run
  const runtimes = !benchmark && localKillTargets(logDir, providers, true).length ? [] : (deps.runtimesToStop ?? defaultRuntimesToStop)(logDir);
  for (const runtime of runtimes) {
    const r = await stopRuntime(runtime).catch((e: unknown) => ({ ok: false, message: e instanceof Error ? e.message : String(e) }));
    appendLedger(ledgerPath(logDir), "BATTERY-RUNTIME-STOP", { runtime, ok: r.ok ? 1 : 0, message: r.message.slice(0, 200) }, new Date(now()));
    lines.push(`${runtime}: ${r.message}`);
  }
  return lines;
}

/** Running local servers whose runtime name is configured in `models.runtimes`. */
function defaultRuntimesToStop(logDir: string): string[] {
  const running = new Set((readLocalStatus(logDir)?.running ?? []).map((r) => r.provider));
  return Object.keys(readRuntimeCommands()).filter((name) => running.has(name));
}

// ---------------------------------------------------------------------------
// The daemon tick
// ---------------------------------------------------------------------------

export interface BatteryTickDeps {
  read?: (now: number) => Promise<BatteryReading | null>;
  now?: () => number;
  /** Daemon shutdown in progress: no stops, no pause moves. */
  shutdown?: () => boolean;
  stop?: (logDir: string, providers: Record<string, { baseUrl: string }>, why: string) => Promise<string[]>;
  /** A benchmark run is live (the benchmark rules apply). Default: the marker file, then the status files. Only asked when a warn/stop is due. */
  benchmarkLive?: (logDir: string) => boolean;
  /** The benchmark last-resort stop: SIGTERM + save window, then the runtimes. */
  benchStop?: (logDir: string, providers: Record<string, { baseUrl: string }>, why: string, saveMs: number, facts: string) => Promise<string[]>;
  /** One ioreg reading; default `ioreg -rn AppleSmartBattery`. */
  readPower?: (now: number) => Promise<PowerTelemetry | null>;
}

function liveBenchmark(logDir: string): boolean {
  if (liveBenchmarkMarker()) return true;
  return loadStatuses(logDir).some((s) => !isChatPane(s) && isLive(s) && isBenchmarkLabel(s.label));
}

const TELEMETRY_KEEP_MS = 14 * 24 * 3600_000;
const TELEMETRY_MAX_BYTES = 5 << 20;
const DAY_MS = 24 * 3600_000;
export const telemetryFile = (): string => paiHomePath("battery-telemetry.jsonl");
let lastTelemetryRotate = 0;

/** Drop telemetry lines older than 14 days (an unparsable line goes too). Returns how many were dropped. */
export function rotateTelemetry(path: string, now: number): number {
  try {
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    const keep = lines.filter((l) => {
      try {
        const at = (JSON.parse(l) as { at?: number | string }).at;
        const ms = typeof at === "number" ? at : Date.parse(String(at));
        return Number.isFinite(ms) && ms >= now - TELEMETRY_KEEP_MS;
      } catch {
        return false;
      }
    });
    if (keep.length !== lines.length) writeFileSync(path, keep.length ? keep.join("\n") + "\n" : "", "utf8");
    return lines.length - keep.length;
  } catch {
    return 0;
  }
}

export interface TelemetryLine extends Partial<Omit<PowerTelemetry, "at">> {
  at: number;
  source?: string;
  drainPctPerMin?: number | null;
}

export interface TelemetrySummary {
  latest: TelemetryLine;
  ageS: number;
  /** Lines inside the window. */
  samples: number;
  systemPowerInW: { max: number; avg: number } | null;
  systemLoadW: { max: number; avg: number } | null;
  /** Largest discharge (W, positive); batteryW is negative while discharging. null with no samples. */
  maxDrainW: number | null;
  minPct: number | null;
}

let telemetryCache: { path: string; mtimeMs: number; size: number; lines: TelemetryLine[] } | null = null;

/** Every parsable line of the telemetry jsonl, cached by path, mtime and size. null for a missing file. */
export function readTelemetryLines(path: string = telemetryFile()): TelemetryLine[] | null {
  let st;
  try {
    st = statSync(path);
  } catch {
    return null;
  }
  if (telemetryCache && telemetryCache.path === path && telemetryCache.mtimeMs === st.mtimeMs && telemetryCache.size === st.size) return telemetryCache.lines;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const lines: TelemetryLine[] = [];
  for (const l of raw.split("\n")) {
    if (!l) continue;
    try {
      const o = JSON.parse(l) as Omit<TelemetryLine, "at"> & { at?: number | string };
      const at = typeof o.at === "number" ? o.at : Date.parse(String(o.at));
      if (Number.isFinite(at)) lines.push({ ...o, at });
    } catch {
      /* skip an unparsable line */
    }
  }
  telemetryCache = { path, mtimeMs: st.mtimeMs, size: st.size, lines };
  return lines;
}

/** Read the telemetry jsonl: latest line plus max/average over the window. null for a missing or empty file. */
export function summarizeTelemetry(windowMs: number, now: number = Date.now(), path: string = telemetryFile()): TelemetrySummary | null {
  const lines = readTelemetryLines(path);
  if (!lines) return null;
  if (!lines.length) return null;
  const latest = lines.reduce((a, b) => (b.at >= a.at ? b : a));
  const win = lines.filter((x) => x.at >= now - windowMs);
  const nums = (k: "systemPowerInW" | "systemLoadW" | "batteryW" | "pct"): number[] =>
    win.map((x) => x[k]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const maxAvg = (v: number[]): { max: number; avg: number } | null =>
    v.length ? { max: Math.max(...v), avg: Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 } : null;
  const bat = nums("batteryW");
  const pct = nums("pct");
  return {
    latest,
    ageS: Math.max(0, Math.round((now - latest.at) / 1000)),
    samples: win.length,
    systemPowerInW: maxAvg(nums("systemPowerInW")),
    systemLoadW: maxAvg(nums("systemLoadW")),
    maxDrainW: bat.length && Math.min(...bat) < 0 ? -Math.min(...bat) : bat.length ? 0 : null,
    minPct: pct.length ? Math.min(...pct) : null,
  };
}

/** Once a day, or at over 5 MB (at most hourly): rotate. */
function maybeRotateTelemetry(now: number): void {
  const due = now - lastTelemetryRotate >= DAY_MS || (now - lastTelemetryRotate >= 3600_000 && fileSize(telemetryFile()) > TELEMETRY_MAX_BYTES);
  if (!due) return;
  lastTelemetryRotate = now;
  rotateTelemetry(telemetryFile(), now);
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Append one telemetry line (jsonl) next to the guard's other state files. */
function recordTelemetry(t: PowerTelemetry | null, r: BatteryReading, drainRate: number | null): void {
  try {
    mkdirSync(paiHomePath("."), { recursive: true });
    appendFileSync(
      telemetryFile(),
      JSON.stringify({ pct: r.pct, source: r.source, ...t, at: new Date(r.at).toISOString(), drainPctPerMin: drainRate }) + "\n",
      "utf8"
    );
  } catch {
    /* telemetry is an extra: never fail a tick over it */
  }
}

const daemonState = { current: emptyBatteryState() };

/**
 * One daemon tick: read pmset, run the state machine, persist the gate and
 * cockpit files, log/ledger the moves, and on the stop move end the running
 * local work. Non-macOS or an unreadable pmset: nothing happens.
 */
export async function batteryGuardTick(
  logDir: string,
  workers: { providers: Record<string, { baseUrl: string }> },
  cfg: BatteryGuardConfig,
  deps: BatteryTickDeps = {},
  state: { current: BatteryState } = daemonState
): Promise<BatteryVerdict | null> {
  const now = (deps.now ?? Date.now)();
  const r = await (deps.read ?? readBattery)(now);
  if (!r) return null;
  const v = evaluateBattery(state.current, r, cfg, (deps.shutdown ?? (() => false))());
  state.current = v.state;
  const pct = r.pct;
  const gate: BatteryGateFile = {
    at: new Date(r.at).toISOString(),
    phase: v.state.phase,
    pct,
    source: r.source,
    reason:
      v.state.phase === "ok" || pct === null
        ? null
        : pauseReason(pct, cfg, v.state.phase === "stopped"),
  };
  // benchmark rules ride the same state: warn / last-resort stop (never a pause)
  const bv = !(deps.shutdown ?? (() => false))() ? evaluateBenchmark(v.state, r, cfg) : null;
  // the status-file scan (~100 ms on a big log dir) only when a warn/stop is actually due
  const benchLive = !!(bv?.warn || bv?.stop) && (deps.benchmarkLive ?? liveBenchmark)(logDir);
  if (bv) {
    state.current = bv.state;
    gate.benchStop = bv.state.benchStopped;
    gate.benchReason = bv.state.benchStopped ? (bv.reason ?? readBatteryGate()?.benchReason ?? "battery low") : null;
  }
  maybeRotateTelemetry(now);
  recordTelemetry(await (deps.readPower ?? readPowerTelemetry)(now).catch(() => null), r, bv?.drainRate ?? null);
  writeJson(gateFile(), gate);
  writeJson(cockpitFile(), {
    at: new Date(r.at).toISOString(),
    pct,
    source: r.source,
    charge: r.charge,
    phase: v.state.phase,
    drainingOnAc: v.drainWarn ? drainLine(v.state.readings, cfg) : null,
  } satisfies BatteryCockpitFile);

  if (v.drainWarn) {
    const line = drainLine(v.state.readings, cfg) ?? "battery draining on AC";
    process.stderr.write(`[pai-daemon] battery guard: ${line}\n`);
    appendLedger(ledgerPath(logDir), "BATTERY-DRAIN-AC", { line }, new Date(r.at));
  }
  if (v.paused) {
    process.stderr.write(`[pai-daemon] battery guard: new local-model work paused (${gate.reason}).\n`);
    appendLedger(ledgerPath(logDir), "BATTERY-PAUSE", { pct, reason: gate.reason }, new Date(r.at));
  }
  if (v.resumed) {
    process.stderr.write(`[pai-daemon] battery guard: local-model work resumed (${pct ?? "?"} %).\n`);
    appendLedger(ledgerPath(logDir), "BATTERY-RESUME", { pct }, new Date(r.at));
  }
  if (bv?.warn && benchLive) {
    process.stderr.write(`[pai-daemon] battery guard: benchmark run in progress at ${pct} % — not paused.\n`);
    appendLedger(ledgerPath(logDir), "BATTERY-BENCH-WARN", { pct, drainPctPerMin: bv.drainRate?.toFixed(2) }, new Date(r.at));
  }
  if (bv?.stop && benchLive) {
    const why = bv.reason ?? "battery low";
    const facts = `pct=${pct} drainPctPerMin=${bv.drainRate?.toFixed(2) ?? "?"}`;
    process.stderr.write(`[pai-daemon] battery guard: stopping benchmark run (${why}); no new item starts, ${cfg.benchmarkSaveSecs}s to save.\n`);
    const lines = await (deps.benchStop ?? ((dir, providers, w, saveMs, f) => stopLocalWork(dir, providers, w, { saveMs, facts: f })))(
      logDir,
      workers.providers,
      why,
      cfg.benchmarkSaveSecs * 1000,
      facts
    );
    for (const l of lines) process.stderr.write(`[pai-daemon] battery guard benchmark stop: ${l}\n`);
  }
  if (v.stopped) {
    const why = gate.reason ?? "battery low";
    process.stderr.write(`[pai-daemon] battery guard: stopping local-model work (${why}).\n`);
    const lines = await (deps.stop ?? ((dir, providers, w) => stopLocalWork(dir, providers, w)))(logDir, workers.providers, why);
    for (const l of lines) process.stderr.write(`[pai-daemon] battery guard stop: ${l}\n`);
  }
  return v;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/**
 * The worker gate's answer: why new local-model work must not start now, or
 * null when admission is open. A stale file (older than three intervals) is
 * not trusted — the guard stops writing when the daemon does, and a dead
 * guard must never hold workers back.
 */
export function batteryGateRefusal(now = Date.now(), benchmark = false): string | null {
  const g = readBatteryGate();
  if (!g) return null;
  const at = Date.parse(g.at);
  if (Number.isFinite(at) && now - at > 3 * BATTERY_GUARD_DEFAULTS.intervalSecs * 1000) return null;
  // a benchmark item is exempt from the pause; only the last-resort stop holds it back
  if (benchmark) return g.benchStop ? (g.benchReason ?? "battery low") : null;
  if (g.phase === "ok" || !g.reason) return null;
  return g.reason;
}

/** The scheduled memory passes' answer: why an index/embed pass must not start now, or null. */
export function batteryPassRefusal(now = Date.now()): string | null {
  return batteryGateRefusal(now);
}

/** The cockpit System line: the last reading and the drain warning; "" with no reading. */
export function batteryCockpitLine(now = Date.now()): string {
  const f = readBatteryCockpit();
  if (!f) return "";
  const at = Date.parse(f.at);
  if (Number.isFinite(at) && now - at > 3 * BATTERY_GUARD_DEFAULTS.intervalSecs * 1000) return "";
  const pct = f.pct === null ? "no battery" : `${f.pct} %`;
  const src = f.source === "ac" ? "AC" : f.source === "battery" ? `battery${f.charge === "charging" ? ", charging" : ""}` : "?";
  const parts = [`${pct} (${src})`, f.phase === "ok" ? null : `local work ${f.phase}`];
  if (f.drainingOnAc) parts.push(f.drainingOnAc);
  return parts.filter(Boolean).join(" · ");
}
