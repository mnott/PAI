/**
 * battery-gate.ts — the keep-above gate and the charge-rate calibration behind
 * `pai power wait|calibrate|status`, the worker scheduler's hold on new local
 * workers and the `battery_status` MCP tool.
 *
 *   keep-above   power.batteryGuard.keepAbovePct (off by default): below it the
 *                next local job waits, in steps, until the battery reaches
 *                resumeAtPct (default keepAbovePct + 5). Running work is never
 *                touched — the pause/stop rules of battery-guard.ts do that.
 *   calibration  idle (no local job) or under load: percent before/after N
 *                minutes -> %/h, stored in power.calibration through the main
 *                config writer.
 *
 * Everything takes an injected battery reader and sleeper, so tests run on a
 * fake percent sequence.
 */

import { batteryGuardConfig, localKillTargets, liveBenchmarkMarker, readBattery, type BatteryGuardConfig, type BatteryReading } from "./battery-guard.js";
import { readMainConfigRaw, writeMainConfigRaw } from "./config.js";
import { lowPowerActive, lowPowerFactor } from "./low-power.js";

export interface Calibration {
  idlePctPerHour: number | null;
  loadPctPerHour: number | null;
  measuredAt: string;
}

export interface GateThresholds {
  keep: number;
  resume: number;
}

export interface GateDeps {
  read: () => Promise<BatteryReading | null>;
  sleep: (ms: number) => Promise<void>;
  out: (line: string) => void;
}

export const liveGateDeps = (out: (line: string) => void): GateDeps => ({
  read: () => readBattery(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  out,
});

/** The effective thresholds: flags over config; null when no keep-above level is set. */
export function gateThresholds(cfg: BatteryGuardConfig, above?: number, resume?: number): GateThresholds | null {
  const keep = above ?? cfg.keepAbovePct;
  if (keep === null || keep === undefined) return null;
  return { keep, resume: resume ?? (above === undefined ? cfg.resumeAtPct : null) ?? keep + 5 };
}

export function readPowerConfig(path?: string): { cfg: BatteryGuardConfig; calibration: Calibration | null } {
  const power = (readMainConfigRaw(...(path ? [path] : [])) as { power?: { calibration?: Partial<Calibration> } }).power;
  const c = power?.calibration;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    cfg: batteryGuardConfig(power),
    calibration: c && typeof c.measuredAt === "string" ? { idlePctPerHour: num(c.idlePctPerHour), loadPctPerHour: num(c.loadPctPerHour), measuredAt: c.measuredAt } : null,
  };
}

/** Minutes until `resume` is reached at the stored idle charge rate; 0 when already there, null when unknown. */
export function minutesToResume(r: BatteryReading | null, resume: number, cal: Calibration | null): number | null {
  if (!r || r.pct === null) return null;
  if (r.pct >= resume) return 0;
  const rate = cal?.idlePctPerHour;
  if (r.source !== "ac" || !rate || rate <= 0) return null;
  return Math.ceil(((resume - r.pct) / rate) * 60);
}

/**
 * Whether the next local job may start. Returns the pause reason, or null when
 * the battery is at or above keep (or unreadable / no battery: a desktop is
 * never held back).
 */
export function keepAboveReason(r: BatteryReading | null, t: GateThresholds | null): string | null {
  if (!t || !r || r.pct === null || r.pct >= t.keep) return null;
  return `battery ${r.pct} % is below keepAbovePct ${t.keep} %`;
}

/**
 * Block until the battery allows the next local job: at or above `keep` passes
 * at once; below it, pause in `stepMs` steps (one line each) until `resume`.
 * Returns the number of pauses. `maxPauses` bounds a wait (default: none).
 */
export async function waitForBattery(
  t: GateThresholds | null,
  cal: Calibration | null,
  deps: GateDeps,
  opts: { stepMs?: number; maxPauses?: number } = {}
): Promise<{ ok: boolean; pauses: number }> {
  const stepMs = opts.stepMs ?? 10 * 60_000;
  let r = await deps.read();
  if (!keepAboveReason(r, t)) return { ok: true, pauses: 0 };
  let pauses = 0;
  while (r && r.pct !== null && r.pct < t!.resume) {
    if (opts.maxPauses !== undefined && pauses >= opts.maxPauses) return { ok: false, pauses };
    const eta = minutesToResume(r, t!.resume, cal);
    deps.out(
      `battery ${r.pct} % (${r.source === "ac" ? "AC" : "battery"}${r.charge === "charging" ? ", charging" : ""}) below keep-above ${t!.keep} %: pausing ${Math.round(stepMs / 60_000)} min until ${t!.resume} %` +
        (eta === null ? "" : `, about ${eta} min to go`)
    );
    pauses++;
    await deps.sleep(stepMs);
    r = await deps.read();
  }
  return { ok: true, pauses };
}

export class CalibrateRefused extends Error {}

/**
 * Charge rate in %/h over `minutes`. Idle mode refuses while `busy()` names a
 * local job; load mode (`load: true`) measures whatever runs. The rate is the
 * percent change per hour (positive = charging, negative = draining).
 */
export async function calibrate(
  opts: { minutes: number; load: boolean },
  deps: GateDeps,
  busy: () => string | null
): Promise<{ mode: "idle" | "load"; from: number; to: number; pctPerHour: number }> {
  if (!opts.load) {
    const why = busy();
    if (why) throw new CalibrateRefused(`${why}; idle calibration needs no local job (use --load to measure the drain of what runs)`);
  }
  const a = await deps.read();
  if (!a || a.pct === null) throw new CalibrateRefused("no battery reading (not macOS, or no internal battery)");
  deps.out(`calibrating ${opts.load ? "under load" : "idle"} for ${opts.minutes} min from ${a.pct} %`);
  await deps.sleep(opts.minutes * 60_000);
  const b = await deps.read();
  if (!b || b.pct === null) throw new CalibrateRefused("battery unreadable at the end of the window");
  if (!opts.load) {
    const why = busy();
    if (why) throw new CalibrateRefused(`${why} during the window; the idle rate is void`);
  }
  const pctPerHour = Math.round(((b.pct - a.pct) / opts.minutes) * 60 * 10) / 10;
  return { mode: opts.load ? "load" : "idle", from: a.pct, to: b.pct, pctPerHour };
}

/** Store a measurement in power.calibration (the other mode's rate is kept). */
export function saveCalibration(mode: "idle" | "load", pctPerHour: number, now: Date = new Date(), path?: string): Calibration {
  const args = path ? ([path] as const) : ([] as const);
  const raw = readMainConfigRaw(...args);
  const power = { ...((raw.power as Record<string, unknown> | undefined) ?? {}) };
  const prev = (power.calibration as Partial<Calibration> | undefined) ?? {};
  const cal: Calibration = {
    idlePctPerHour: mode === "idle" ? pctPerHour : (prev.idlePctPerHour ?? null),
    loadPctPerHour: mode === "load" ? pctPerHour : (prev.loadPctPerHour ?? null),
    measuredAt: now.toISOString(),
  };
  power.calibration = cal;
  writeMainConfigRaw({ ...raw, power }, ...args);
  return cal;
}

/** Local jobs now running (any local provider): the reason idle calibration must not run, or null. */
export function localBusyReason(logDir: string, providers: Record<string, { baseUrl: string }>): string | null {
  const ids = [...localKillTargets(logDir, providers), ...localKillTargets(logDir, providers, true)];
  if (ids.length) return `${ids.length} worker${ids.length === 1 ? "" : "s"} running on a local provider (${ids.slice(0, 3).join(", ")})`;
  const m = liveBenchmarkMarker();
  return m ? `benchmark run "${m.label}" is live (pid ${m.pid})` : null;
}

export interface PowerStatus {
  reading: BatteryReading | null;
  cfg: BatteryGuardConfig;
  calibration: Calibration | null;
  thresholds: GateThresholds | null;
  minutesToResume: number | null;
  /** macOS Low Power Mode right now (pmset "powermode 1"). */
  lowPower?: boolean;
  /** The worker-limit stretch factor (workers.lowPower.factor). */
  lowPowerFactor?: number;
}

export async function powerStatus(deps: Pick<GateDeps, "read">, path?: string): Promise<PowerStatus> {
  const { cfg, calibration } = readPowerConfig(path);
  const reading = await deps.read();
  const thresholds = gateThresholds(cfg);
  const held = keepAboveReason(reading, thresholds) !== null;
  return {
    reading,
    cfg,
    calibration,
    thresholds,
    minutesToResume: held && thresholds ? minutesToResume(reading, thresholds.resume, calibration) : null,
    lowPower: await lowPowerActive(),
    lowPowerFactor: lowPowerFactor(path),
  };
}

export function powerStatusLines(s: PowerStatus): string[] {
  const r = s.reading;
  const now = !r || r.pct === null ? "no battery reading" : `${r.pct} % (${r.source === "ac" ? "AC" : "battery"}, ${r.charge})`;
  const rate = (v: number | null | undefined): string => (typeof v === "number" ? `${v > 0 ? "+" : ""}${v} %/h` : "not measured");
  const held = keepAboveReason(r, s.thresholds);
  return [
    `battery: ${now}`,
    `guard: ${s.cfg.enabled ? "on" : "off"}; pause below ${s.cfg.pauseBelowPct} % (resume above ${s.cfg.pauseBelowPct + s.cfg.hysteresisPct} %), stop below ${s.cfg.stopBelowPct} %`,
    `keep-above: ${s.thresholds ? `${s.thresholds.keep} % (resume at ${s.thresholds.resume} %)${held ? ` — new local work waits${s.minutesToResume === null ? "" : `, about ${s.minutesToResume} min to resume`}` : " — open"}` : "off"}`,
    `calibration: idle ${rate(s.calibration?.idlePctPerHour)}, load ${rate(s.calibration?.loadPctPerHour)}${s.calibration ? ` (measured ${s.calibration.measuredAt})` : ""}`,
    ...(s.lowPower !== undefined
      ? [`low power: ${s.lowPower ? `on — worker limits stretch x${s.lowPowerFactor ?? 1}` : `off (factor ${s.lowPowerFactor ?? 1})`}`]
      : []),
  ];
}
