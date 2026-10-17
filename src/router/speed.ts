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
  h1: SpeedStats;
  h24: SpeedStats;
}

export function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
}

/**
 * Read tok/s = uncached input tokens / TTFT. Anthropic semantics: input_tokens
 * excludes cache reads. Local usage carries no cache fields, so for those the
 * figure is prefill including whatever the server had cached.
 */
export function readRate(r: UsageRow): number | null {
  if (r.ttftMs === undefined || r.ttftMs <= 0 || !r.input_tokens) return null;
  return r.input_tokens / (r.ttftMs / 1000);
}

export function writeRate(r: UsageRow): number | null {
  if (r.decodeMs === undefined || r.decodeMs <= 0 || (r.output_tokens ?? 0) < MIN_DECODE_TOKENS) return null;
  return r.output_tokens! / (r.decodeMs / 1000);
}

const round = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);

function stats(rows: UsageRow[]): SpeedStats {
  const ttft = rows.map((r) => r.ttftMs!);
  const reads = rows.map(readRate).filter((v): v is number => v !== null);
  const writes = rows.map(writeRate).filter((v): v is number => v !== null);
  return {
    requests: rows.length,
    ttftP50: round(percentile(ttft, 0.5)),
    ttftP90: round(percentile(ttft, 0.9)),
    readTps: round(percentile(reads, 0.5)),
    writeTps: round(percentile(writes, 0.5)),
  };
}

/** One entry per provider+model with timed successful rows in the last 24 h, busiest first. */
export function buildSpeed(allRows: UsageRow[], now: number, canon: (m: string) => string = (m) => m): SpeedRow[] {
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
      h1: stats(g.rows.filter((r) => Date.parse(r.ts) >= now - 3_600_000)),
      h24: stats(g.rows),
    }))
    .sort((a, b) => b.h24.requests - a.h24.requests);
}
