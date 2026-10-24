/**
 * speed.ts — per-model speed aggregation for the cockpit: time to first token,
 * read (prefill) and write (decode) tokens per second, from the ttftMs/decodeMs
 * the router stores with each usage row. Rows without timing (older rows,
 * non-streamed replies, errors) are skipped.
 */

import type { UsageRow } from "./usage.js";
import { strataEngineMetrics } from "./runtime-samples.js";

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

/** Prefill time: the server's own prompt_ms when reported, else time to first token. */
const prefillMs = (r: UsageRow): number | undefined => r.promptMs ?? r.ttftMs;

/** Generation time: the server's own predicted_ms when reported, else (local) first content to end or (cloud) the whole reply. */
function genMs(r: UsageRow, local: boolean): number | undefined {
  if (r.predictedMs !== undefined) return r.predictedMs;
  return local ? r.decodeMs : r.ttftMs === undefined ? undefined : r.ms;
}

/** [uncached prompt tokens, ttft ms] for rows that qualify for the prefill rate, else null. */
function prefillSample(r: UsageRow, local: boolean): [number, number] | null {
  const tok = uncachedPrompt(r);
  const ms = prefillMs(r);
  if (tok === null || tok <= 0 || ms === undefined || ms <= 0) return null;
  const max = Number(process.env.PAI_MAX_LOCAL_PREFILL_TPS) || MAX_PLAUSIBLE_LOCAL_PREFILL_TPS;
  if (local && tok / (ms / 1000) > max) {
    if (!capLogged) {
      capLogged = true;
      console.warn(`[speed] dropping local prefill rows above ${max} tok/s (implausible)`);
    }
    return null;
  }
  return [tok, ms];
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
  const ms = genMs(r, local);
  if (ms === undefined || ms <= 0 || (r.output_tokens ?? 0) < MIN_DECODE_TOKENS) return null;
  return r.output_tokens! / (ms / 1000);
}

/** Generation windows shorter than this are bursts (whole reply in one chunk), not decode time. */
export const MIN_GEN_MS = 50;
/** Fewer output tokens than this are excluded from the aggregate output rate. */
export const MIN_OUTPUT_TOKENS = 8;
/** Output rates above these are measurement artefacts and dropped (env PAI_MAX_LOCAL_OUTPUT_TPS / PAI_MAX_CLOUD_OUTPUT_TPS override). */
export const MAX_PLAUSIBLE_LOCAL_OUTPUT_TPS = 2000;
export const MAX_PLAUSIBLE_CLOUD_OUTPUT_TPS = 1000;
let outCapLogged = false;

/** Output tok/s: median per-row rate over rows with a real generation window (existing median semantics kept). */
export function outputRate(rows: UsageRow[], local = true): number | null {
  const max = (Number(process.env[local ? "PAI_MAX_LOCAL_OUTPUT_TPS" : "PAI_MAX_CLOUD_OUTPUT_TPS"]) || (local ? MAX_PLAUSIBLE_LOCAL_OUTPUT_TPS : MAX_PLAUSIBLE_CLOUD_OUTPUT_TPS));
  const rates: number[] = [];
  for (const r of rows) {
    const g = genMs(r, local);
    const n = r.output_tokens ?? 0;
    if (g === undefined || g < MIN_GEN_MS || n < MIN_OUTPUT_TOKENS) continue;
    if (n / (g / 1000) > max) {
      if (!outCapLogged) {
        outCapLogged = true;
        console.warn(`[speed] dropping output rows above ${max} tok/s (implausible)`);
      }
      continue;
    }
    rates.push(n / (g / 1000));
  }
  return percentile(rates, 0.5);
}

export interface EndpointSpeed {
  prefillTps: number | null;
  /** requests the prefill rate averages */
  prefillN: number;
  /** p50 over requests with a real generation window; buffered replies (whole answer in one chunk) are excluded, not counted as ~0 ms */
  decodeTps: number | null;
  decodeN: number;
  window: "1h" | "24h";
  /** where the numbers come from: the server's own accounting, or measured from the router's rows */
  source: "server" | "measured";
  /** "prefill 245 t/s · decode 38 t/s (n=12/9, 1h)" */
  text: string;
  /** how the two rates are measured, for the tooltip */
  tip: string;
}

export const SPEED_TIP =
  "prefill = uncached prompt tokens / server prompt time (prompt_ms when the server reports it, else time to first token); " +
  "decode = output tokens / generation time (predicted_ms when reported, else first token to end), p50. " +
  "Buffered replies (whole answer in one chunk, e.g. tool calls) are excluded from decode, not counted as ~0 ms. n = requests behind each rate.";

const rate = (v: number | null) => (v === null ? "–" : `${v < 10 ? v.toFixed(1) : Math.round(v)} t/s`);

/** Prefill and decode rate of one endpoint over the last hour (else 24 h): the one computation behind the cockpit tile. */
export function endpointSpeed(rows: UsageRow[], provider: string, now: number, local = true): EndpointSpeed | null {
  for (const [span, window] of [[3_600_000, "1h"], [86_400_000, "24h"]] as const) {
    const ok = rows.filter((r) => r.provider === provider && r.status === 200 && Date.parse(r.ts) >= now - span);
    const prefillN = ok.filter((r) => prefillSample(r, local)).length;
    const decodeN = ok.filter((r) => outputRate([r], local) !== null).length;
    if (!prefillN && !decodeN) continue;
    const prefillTps = round(prefillRate(ok, local));
    const decodeTps = round(outputRate(ok, local));
    const source = ok.some((r) => r.promptMs !== undefined || r.predictedMs !== undefined) ? "server" : "measured";
    const text = `prefill ${rate(prefillTps)} · decode ${rate(decodeTps)} (n=${prefillN}/${decodeN}, ${window}, ${source})`;
    return { prefillTps, prefillN, decodeTps, decodeN, window, source, text, tip: SPEED_TIP };
  }
  return null;
}

const round = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);

function stats(rows: UsageRow[], local: boolean): SpeedStats {
  const ttft = rows.map((r) => r.ttftMs!);
  return {
    requests: rows.length,
    ttftP50: round(percentile(ttft, 0.5)),
    ttftP90: round(percentile(ttft, 0.9)),
    readTps: round(prefillRate(rows, local)),
    writeTps: round(outputRate(rows, local)),
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

/** The previous Strata `totals` per endpoint, so decode = Δoutput_tokens / Δdecode_ms between polls. */
const strataPrev = new Map<string, { out: number; ms: number; decodeTps: number | null }>();

/**
 * Speed from a Strata GET /metrics body: decode from the totals delta since the last poll (kept over idle polls),
 * prefill from the running request's prefill_tok_s_mean, else the last request's fresh tokens / prompt_ms.
 * Null when the body is not Strata's or carries no reading yet.
 */
export function strataSpeed(key: string, body: string, window: "1h" | "24h" = "1h"): EndpointSpeed | null {
  let m: { totals?: { output_tokens?: number; decode_ms?: number } } | null;
  try {
    m = JSON.parse(body) as typeof m;
  } catch {
    return null;
  }
  const eng = strataEngineMetrics(m);
  if (!eng) return null;
  const out = m?.totals?.output_tokens;
  const ms = m?.totals?.decode_ms;
  const prev = strataPrev.get(key);
  let decodeTps = prev?.decodeTps ?? null;
  if (typeof out === "number" && typeof ms === "number") {
    if (prev && ms > prev.ms && out >= prev.out) decodeTps = (out - prev.out) / ((ms - prev.ms) / 1000);
    strataPrev.set(key, { out, ms, decodeTps });
  }
  const prefillTps = eng.prefill;
  if (prefillTps === null && decodeTps === null) return null;
  const r = { prefillTps: round(prefillTps), decodeTps: round(decodeTps) };
  return { ...r, prefillN: 0, decodeN: 0, window, source: "server", text: `prefill ${rate(r.prefillTps)} · decode ${rate(r.decodeTps)} (server)`, tip: SPEED_TIP };
}
