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

/**
 * Prompt tok/s = prompt tokens processed / TTFT. Anthropic semantics: input_tokens
 * excludes cache reads and writes, so cloud rows count all three (a cached prompt
 * would otherwise read ~0). Local usage carries no cache fields: input_tokens already
 * is the whole prompt.
 */
export function readRate(r: UsageRow): number | null {
  const prompt = (r.input_tokens ?? 0) + (r.cache_read_input_tokens ?? 0) + (r.cache_creation_input_tokens ?? 0);
  if (r.ttftMs === undefined || r.ttftMs <= 0 || !prompt) return null;
  return prompt / (r.ttftMs / 1000);
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
  const reads = rows.map(readRate).filter((v): v is number => v !== null);
  const writes = rows.map((r) => writeRate(r, local)).filter((v): v is number => v !== null);
  return {
    requests: rows.length,
    ttftP50: round(percentile(ttft, 0.5)),
    ttftP90: round(percentile(ttft, 0.9)),
    readTps: round(percentile(reads, 0.5)),
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
