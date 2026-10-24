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
 * Cloud workers and the operator's interactive sessions are never touched:
 * only headless runs on loopback providers are refused or stopped, and chat
 * panes are skipped by the stop pass.
 *
 * The pause state lives in a file the worker CLI (a separate process) reads
 * at admission; the last reading and the drain warning live in a second file
 * the cockpit reads.
 */

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { paiHomePath } from "../config/pai-home.js";
import { appendLedger } from "../workers/ledger.js";
import { ledgerPath } from "../workers/paths.js";
import { isLocalProvider } from "../workers/config.js";
import { isChatPane, isLive, loadStatuses } from "../workers/status.js";
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
}

export const BATTERY_GUARD_DEFAULTS: BatteryGuardConfig = {
  enabled: true,
  intervalSecs: 60,
  pauseBelowPct: 25,
  stopBelowPct: 12,
  hysteresisPct: 10,
  drainWindowReadings: 10,
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
  const batt = /InternalBattery-\d+[^;\n]*;\s*(\d+)%\s*;\s*(charging|discharging|charged|finishing charge)/.exec(stdout);
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
}

export const emptyBatteryState = (): BatteryState => ({
  phase: "ok",
  readings: [],
  lastDrainWarnAt: null,
  lastStopAt: null,
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
  if (cfg.enabled && r.source === "ac" && r.pct !== null) {
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
export function localKillTargets(logDir: string, providers: Record<string, { baseUrl: string }>): string[] {
  const statuses = loadStatuses(logDir).filter(
    (s) => !isChatPane(s) && isLive(s) && (s.state === "running" || s.state === "queued") && isLocalProvider(providers[s.provider]?.baseUrl ?? "")
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

export interface BatteryStopDeps {
  /** End one worker through the `pai worker kill` path (salvage as on any stop). */
  killWorker?: (logDir: string, id: string) => Promise<string[]>;
  /** Stop a runtime PAI started, through its configured stop command. */
  stopRuntime?: (runtime: string) => Promise<{ ok: boolean; message: string }>;
  /** The runtimes to stop: running local servers whose name is a configured runtime. */
  runtimesToStop?: (logDir: string) => string[];
  now?: () => number;
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
  const kill = deps.killWorker ?? ((dir, id) => killTree(dir, id, { only: true, by: "battery guard", reason: why }));
  const lines: string[] = [];
  for (const id of localKillTargets(logDir, providers)) {
    try {
      lines.push(...(await kill(logDir, id)));
    } catch (e) {
      lines.push(`worker ${id}: battery stop failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  appendLedger(ledgerPath(logDir), "BATTERY-STOP", { reason: why, workers: lines.length ? lines.join(" | ").slice(0, 400) : "-" }, new Date(now()));
  const stopRuntime =
    deps.stopRuntime ??
    ((runtime) => runRuntimeOp(runtime, "stop", readRuntimeCommands(), liveRuntimeOpDeps, homedir()));
  const runtimes = (deps.runtimesToStop ?? defaultRuntimesToStop)(logDir);
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
export function batteryGateRefusal(now = Date.now()): string | null {
  const g = readBatteryGate();
  if (!g || g.phase === "ok" || !g.reason) return null;
  const at = Date.parse(g.at);
  if (Number.isFinite(at) && now - at > 3 * BATTERY_GUARD_DEFAULTS.intervalSecs * 1000) return null;
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
