/**
 * speed.ts — per-model speed aggregation for the cockpit: time to first token,
 * read (prefill) and write (decode) tokens per second, from the ttftMs/decodeMs
 * the router stores with each usage row. Rows without timing (older rows,
 * non-streamed replies, errors) are skipped.
 */

import type { UsageRow } from "./usage.js";

/** Fewer output tokens than this make the decode rate noise. */
export const MIN_DECODE_TOKENS = 16;

export interface SpeedStats {
  requests: number;
  ttftP50: number | null;
  ttftP90: number | null;
  readTps: number | null;
  writeTps: number | null;
}

export interface SpeedRow {
  provider: string;
  model: string;
  /** provider base URL is loopback */
  local: boolean;
  h1: SpeedStats;
  h24: SpeedStats;
}

export function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
}

/** A local prefill above this is a measurement artefact; such rows are dropped (env PAI_MAX_LOCAL_PREFILL_TPS overrides). */
export const MAX_PLAUSIBLE_LOCAL_PREFILL_TPS = 20_000;
let capLogged = false;

/**
 * Tokens the server actually had to prefill: input_tokens (which excludes cache reads)
 * plus cache writes. Null when the row carries no cache counts, so a cached prompt is
 * never mistaken for a cold one.
 */
function uncachedPrompt(r: UsageRow): number | null {
  if (r.cache_read_input_tokens === undefined || r.cache_creation_input_tokens === undefined) return null;
  return (r.input_tokens ?? 0) + r.cache_creation_input_tokens;
}

/** [uncached prompt tokens, ttft ms] for rows that qualify for the prefill rate, else null. */
function prefillSample(r: UsageRow, local: boolean): [number, number] | null {
  const tok = uncachedPrompt(r);
  if (tok === null || tok <= 0 || r.ttftMs === undefined || r.ttftMs <= 0) return null;
  const max = Number(process.env.PAI_MAX_LOCAL_PREFILL_TPS) || MAX_PLAUSIBLE_LOCAL_PREFILL_TPS;
  if (local && tok / (r.ttftMs / 1000) > max) {
    if (!capLogged) {
      capLogged = true;
      console.warn(`[speed] dropping local prefill rows above ${max} tok/s (implausible)`);
    }
    return null;
  }
  return [tok, r.ttftMs];
}

/** Prefill tok/s of the uncached prompt tokens over TTFT, aggregated as Σtokens / Σttft. */
export function prefillRate(rows: UsageRow[], local = true): number | null {
  let tok = 0;
  let ms = 0;
  for (const r of rows) {
    const s = prefillSample(r, local);
    if (s) {
      tok += s[0];
      ms += s[1];
    }
  }
  return ms > 0 ? tok / (ms / 1000) : null;
}

/**
 * Output tok/s. A local server streams token by token, so first content to end is the
 * decode time. A cloud reply reaches the router with hidden thinking before the first
 * visible token or in bursts (decode window of a few ms for hundreds of tokens), so
 * its rate is output tokens over the whole reply time: a lower bound, never inflated.
 */
export function writeRate(r: UsageRow, local = true): number | null {
  const ms = local ? r.decodeMs : r.ttftMs === undefined ? undefined : r.ms;
  if (ms === undefined || ms <= 0 || (r.output_tokens ?? 0) < MIN_DECODE_TOKENS) return null;
  return r.output_tokens! / (ms / 1000);
}

const round = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);

function stats(rows: UsageRow[], local: boolean): SpeedStats {
  const ttft = rows.map((r) => r.ttftMs!);
  const writes = rows.map((r) => writeRate(r, local)).filter((v): v is number => v !== null);
  return {
    requests: rows.length,
    ttftP50: round(percentile(ttft, 0.5)),
    ttftP90: round(percentile(ttft, 0.9)),
    readTps: round(prefillRate(rows, local)),
    writeTps: round(percentile(writes, 0.5)),
  };
}

/** One entry per provider+model with timed successful rows in the last 24 h, busiest first. */
export function buildSpeed(allRows: UsageRow[], now: number, canon: (m: string) => string = (m) => m, isLocal: (provider: string) => boolean = () => false): SpeedRow[] {
  const groups = new Map<string, { provider: string; model: string; rows: UsageRow[] }>();
  for (const r of allRows) {
    if (r.status >= 400 || r.ttftMs === undefined) continue;
    const t = Date.parse(r.ts);
    if (!(t >= now - 86_400_000)) continue;
    const model = canon(r.model);
    const g = groups.get(`${r.provider}\u0000${model}`) ?? { provider: r.provider, model, rows: [] };
    g.rows.push(r);
    groups.set(`${r.provider}\u0000${model}`, g);
  }
  return [...groups.values()]
    .map((g) => ({
      provider: g.provider,
      model: g.model,
      local: isLocal(g.provider),
      h1: stats(g.rows.filter((r) => Date.parse(r.ts) >= now - 3_600_000), isLocal(g.provider)),
      h24: stats(g.rows, isLocal(g.provider)),
    }))
    .sort((a, b) => b.h24.requests - a.h24.requests);
}
