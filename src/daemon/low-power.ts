/**
 * low-power.ts — macOS Low Power Mode awareness for worker time limits.
 *
 * During the day the operator runs Low Power Mode for less fan noise; local
 * runs then take longer, so minutes spent in it count as 1/factor minutes
 * against a worker's limits. The factor lives in config under
 * `power.lowPower.factor` (default 2; 1 turns the stretch off).
 *
 * Detection reads the same pmset the battery guard uses: `pmset -g`'s
 * "powermode 1" line (also "lowpowermode 1", older macOS). Sampled at most
 * once per 30 s and cached; non-macOS or a failing pmset is always off.
 */

import { execFile } from "node:child_process";
import { readMainConfigRaw } from "./config.js";

/** Seconds between pmset samples; a reading is cached for this long. */
export const LOW_POWER_SAMPLE_SEC = 30;

/** workers/power default when config names none. */
export const DEFAULT_LOW_POWER_FACTOR = 2;

/** Parse `pmset -g` stdout: true only on "powermode 1" / "lowpowermode 1". */
export function parseLowPowerMode(stdout: string): boolean {
  return /^\s*(powermode|lowpowermode)\s+1\s*$/im.test(stdout);
}

/** The config factor (power.lowPower.factor); >= 1, non-finite or absent counts as the default. */
export function lowPowerFactor(path?: string): number {
  try {
    const power = (readMainConfigRaw(...(path ? [path] : [])) as { power?: { lowPower?: { factor?: unknown } } }).power;
    const f = power?.lowPower?.factor;
    return typeof f === "number" && Number.isFinite(f) && f >= 1 ? f : DEFAULT_LOW_POWER_FACTOR;
  } catch {
    return DEFAULT_LOW_POWER_FACTOR;
  }
}

export interface LowPowerDeps {
  /** Sample command; resolves with `pmset -g` stdout, rejects when it fails. */
  run?: () => Promise<string>;
  /** Clock for the cache window. */
  now?: () => number;
}

let cached: { at: number; active: boolean } | null = null;
let inflight: Promise<boolean> | null = null;

async function defaultRun(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("pmset", ["-g"], { timeout: 5000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/**
 * Whether macOS is in Low Power Mode right now. At most one pmset sample per
 * LOW_POWER_SAMPLE_SEC (the reading is cached); a failing pmset reads as off.
 * `deps` replaces the pmset run and clock (tests); the cache applies to both
 * the default and injected paths, `resetLowPowerCache()` clears it.
 */
export async function lowPowerActive(deps: LowPowerDeps = {}): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const now = deps.now ?? Date.now;
  if (cached && now() - cached.at < LOW_POWER_SAMPLE_SEC * 1000) return cached.active;
  if (!inflight) {
    const run = deps.run ?? defaultRun;
    inflight = run()
      .then((stdout) => parseLowPowerMode(stdout))
      .catch(() => false)
      .then((active) => {
        cached = { at: now(), active };
        inflight = null;
        return active;
      });
  }
  return inflight;
}

/** Drop the cached reading (tests, or a caller that just changed power mode). */
export function resetLowPowerCache(): void {
  cached = null;
  inflight = null;
}

/** The cached reading without sampling: false until the first pmset sample lands. */
export function cachedLowPowerActive(): boolean {
  return cached?.active ?? false;
}

/**
 * Whether the run's minutes-based limits are stretched right now: low power on
 * and a factor above 1. `active` defaults to the cached pmset reading (false
 * until the first sample lands).
 */
export function lowPowerStretchActive(active: boolean = cachedLowPowerActive(), factor: number = lowPowerFactor()): boolean {
  return active && factor > 1;
}
