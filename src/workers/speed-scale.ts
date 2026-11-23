/**
 * speed-scale.ts — the one slowdown factor that turns a slow machine into a
 * longer outer limit instead of reroutes and killed local runs.
 *
 * Low Power Mode, two instances sharing the GPU, or other local load slow
 * decode; wall-clock limits then cut off local work that is merely slower.
 * The factor is reference decode tok/s / currently measured decode tok/s for
 * the provider+model a worker runs on, clamped to 1..maxScale. Reference is
 * the p75 per-request decode rate of that provider+model (its normal full-power
 * rate), so the factor reads 1 on a healthy machine and grows only when
 * the model really runs slower than it can.
 *
 * Cloud providers are never scaled (their measured rate is not our machine).
 * Missing measurement (no usable rows) = factor 1: we never invent slowdown.
 * The factor applies ONLY to the one wall-clock backstop (--max-minutes
 * stretch, deadline.ts). Escalation and stall decisions count turns, calls
 * and repeated failures — see reroute.ts and the loop guard — so they need no
 * clock scaling at all (see workers.yaml workers.escalate.stallCalls).
 */

import { readUsage, type UsageRow } from "../router/usage.js";
import { outputRate, percentile } from "../router/speed.js";
import { isLocalProvider, speedScaleConfig } from "./config.js";
import { cachedLowPowerActive } from "../daemon/low-power.js";

/** Hard ceiling of the slowdown factor (workers.escalate.maxScale default). */
export const MAX_SCALE = 4;

/** Clamp any ratio into the usable range [1, maxScale]; a broken value is 1. */
export function clampScale(r: number, maxScale: number = MAX_SCALE): number {
  if (!Number.isFinite(r) || r <= 0) return 1;
  return Math.min(maxScale, Math.max(1, r));
}

/**
 * Decode tok/s over rows: Σ output tokens / Σ generation ms, considering only
 * rows with a known generation window (a buffered reply is not decode time).
 * Null when no row qualifies — never 0, so a quiet machine reads factor 1.
 */
export function decodeTps(rows: UsageRow[], local: boolean): number | null {
  return outputRate(rows.filter((r) => r.status === 200), local);
}

/**
 * The slowdown factor for a (provider, model) pair from the router's usage
 * records: p75 of the per-request decode rates / decode rate of the recent window, clamped
 * to [1, maxScale]. 1 when the provider is cloud, when the recent window has
 * no measurement, or when the recent rate already matches the reference.
 * `rows` lets tests inject history; the default reads the usage log.
 */
export function speedFactor(
  provider: string,
  model: string,
  opts: {
    rows?: UsageRow[];
    /** Window that counts as "current" (default 30 min). */
    recentMs?: number;
    maxScale?: number;
    nowMs?: number;
    /** Whether a provider runs on this machine; cloud = 1. Absent: the caller vouches it is local. */
    isLocal?: (provider: string) => boolean;
  } = {}
): number {
  const now = opts.nowMs ?? Date.now();
  const recentMs = opts.recentMs ?? 30 * 60 * 1000;
  const maxScale = opts.maxScale ?? MAX_SCALE;
  if (opts.isLocal && !opts.isLocal(provider)) return 1;
  const rows = opts.rows ?? readUsage();
  const forModel = rows.filter((r) => r.provider === provider && r.model === model);
  const recent = forModel.filter((r) => Date.parse(r.ts) >= now - recentMs);
  const current = decodeTps(recent, true);
  if (current === null) return 1;
  // reference = p75 of per-request decode rates: the model's normal full-speed rate, stable against single bursts and outliers
  const rates = forModel.map((r) => outputRate([r], true)).filter((x): x is number => x !== null);
  const reference = percentile(rates, 0.75);
  if (reference === null || reference <= 0) return 1;
  return clampScale(reference / current, maxScale);
}

/**
 * The deadline timer's speed reader for one run: the factor when
 * workers.escalate.scaleWithSpeed is on (cloud/unmeasured = 1), also written
 * to the worker status (`slowdown`, `lowPower`) so ps and the cockpit show
 * "low power: limits x2.1". `save` persists the status when the value moved.
 */
export function speedProbe(
  provider: string,
  baseUrl: string,
  model: string,
  status: { slowdown?: number; lowPower?: boolean },
  save: () => void,
  lowPower: () => boolean = cachedLowPowerActive
): () => number {
  return () => {
    const cfg = speedScaleConfig();
    const f = cfg.scaleWithSpeed ? Math.round(speedFactor(provider, model, { maxScale: cfg.maxScale, isLocal: () => isLocalProvider(baseUrl) }) * 10) / 10 : 1;
    const lp = lowPower();
    if ((status.slowdown ?? 1) !== f || (status.lowPower ?? false) !== lp) {
      status.slowdown = f;
      status.lowPower = lp;
      save();
    }
    return f;
  };
}
