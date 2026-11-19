import type { LocalIdleFile } from "../workers/local-idle.js";

/** GPU peak (percent) at or under which the engine counts as showing no activity. */
export const ENGINE_IDLE_PEAK_PCT = 1;

/**
 * Engine-idle signal from the daemon's local-idle.json: the GPU peak over the last minute is ~0. A missing,
 * stale (>120 s) or unreadable-GPU sample is NOT idle - the watchdog never releases on a guess.
 */
export function engineIdleFrom(f: LocalIdleFile | null, now: number): boolean {
  if (!f || now - Date.parse(f.at) > 120_000) return false;
  const peak = f.gpuPeakPct ?? f.gpuAvgPct ?? f.gpuPct;
  return typeof peak === "number" && peak <= ENGINE_IDLE_PEAK_PCT;
}
