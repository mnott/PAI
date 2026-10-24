/**
 * usage.ts — per-request token and cache accounting for the router.
 *
 * Usage is parsed from the response as it streams (SSE message_start /
 * message_delta) or from the JSON body; only numbers and hashes are stored,
 * never bodies, keys or content.
 */

import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { paiHomePath } from "../config/pai-home.js";
import { dirname, join } from "node:path";

export const usageLogFile = (): string => paiHomePath("logs", "router-usage.jsonl");

export type CacheVerdict = "hit" | "write" | "miss";

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface UsageRow extends Usage {
  ts: string;
  model: string;
  provider: string;
  /** copy of a local model that served the request ("#2"); absent for single-instance and cloud rows */
  instance?: string;
  /** host:port of the endpoint that served the request (managed or registered); absent for cloud rows */
  host?: string;
  status: number;
  ms: number;
  bytes: number;
  cache: CacheVerdict;
  /** short hash of x-claude-code-session-id, when sent */
  session?: string;
  /** x-claude-code-session-id as sent (an identifier, not a credential) */
  session_id?: string;
  /** model as the client asked for it, before routing */
  requested_model?: string;
  /** model the request was routed to (same value as `model`) */
  routed_model?: string;
  /** seconds since the previous request of the same session */
  gap_s?: number;
  /** non-sensitive client identification headers */
  user_agent?: string;
  x_app?: string;
  /** which prompt part changed inside a session: system, tools, messages */
  bust?: string[];
  /** ms from request start to the first content token; absent on old rows and non-streamed replies */
  ttftMs?: number;
  /** ms from the first content token to the end of the reply */
  decodeMs?: number;
  /** server-reported prompt processing / generation ms (llama.cpp-style `timings`), when the backend returns them */
  promptMs?: number;
  predictedMs?: number;
  /** input_tokens was estimated from the request size because the server did not report it */
  input_estimated?: boolean;
}

const KEYS: Array<keyof Usage> = [
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
];

export function emptyUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
}

function mergeUsage(into: Usage, u: unknown): void {
  if (!u || typeof u !== "object") return;
  for (const k of KEYS) {
    const v = (u as Record<string, unknown>)[k];
    if (typeof v === "number" && Number.isFinite(v)) into[k] = v;
  }
}

export function verdict(u: Usage): CacheVerdict {
  if (u.cache_read_input_tokens > 0) return "hit";
  if (u.cache_creation_input_tokens > 0) return "write";
  return "miss";
}

/** Usage object of a non-streaming /v1/messages JSON response. */
export function usageFromJson(text: string): Usage {
  const u = emptyUsage();
  try {
    mergeUsage(u, (JSON.parse(text) as { usage?: unknown }).usage);
  } catch {
    /* not JSON (error page): zero usage */
  }
  return u;
}

const MAX_LINE = 256 * 1024;
const MAX_JSON = 4 * 1024 * 1024;

/**
 * Incremental response sniffer. Feed every chunk that is piped to the client.
 * SSE: only the current partial line is held, usage events are parsed as they
 * complete. JSON: the body is held (capped) and parsed at finish().
 */
export class UsageSniffer {
  private usage = emptyUsage();
  private line = "";
  private skipLine = false;
  private json = "";
  private jsonOverflow = false;
  private mode: "sse" | "json" | undefined;
  /** wall-clock ms of the first content_block_delta (text or tool-input), SSE only */
  firstContentAt: number | undefined;
  /** the response carries a tool call that runs `pai build` (the worker is about to wait on the build gate) */
  buildCall = false;
  /** server-reported timings (`timings` or `usage` carrying prompt_ms / predicted_ms), when present */
  serverTimings: { promptMs?: number; predictedMs?: number } | undefined;
  private toolTail = "";

  constructor(contentType: string | undefined) {
    if (contentType) this.mode = /text\/event-stream/i.test(contentType) ? "sse" : "json";
  }

  push(chunk: Buffer): void {
    const text = chunk.toString("utf8");
    if (!this.mode) this.mode = /^\s*(event:|data:|:)/.test(text) ? "sse" : "json";
    if (this.mode === "json") {
      if (this.json.length + text.length > MAX_JSON) this.jsonOverflow = true;
      else this.json += text;
      return;
    }
    let rest = text;
    for (;;) {
      const nl = rest.indexOf("\n");
      if (nl < 0) {
        if (!this.skipLine) {
          this.line += rest;
          if (this.line.length > MAX_LINE) {
            this.line = "";
            this.skipLine = true;
          }
        }
        return;
      }
      if (!this.skipLine) this.handleLine(this.line + rest.slice(0, nl));
      this.line = "";
      this.skipLine = false;
      rest = rest.slice(nl + 1);
    }
  }

  private handleLine(raw: string): void {
    const line = raw.replace(/\r$/, "");
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (this.firstContentAt === undefined && data.includes('"content_block_delta"') && /"(text|partial_json|thinking)":\s*"[^"]/.test(data)) {
      this.firstContentAt = Date.now();
    }
    if (!this.buildCall && data.includes('"partial_json"')) {
      const m = /"partial_json":\s*"((?:[^"\\]|\\.)*)"/.exec(data);
      if (m) {
        this.toolTail = (this.toolTail + m[1]).slice(-120);
        if (/pai build (run|lock)/.test(this.toolTail)) this.buildCall = true;
      }
    }
    // cheap prefilter: only usage- or timings-bearing events are parsed
    if (!data.includes('"usage"') && !data.includes('"timings"')) return;
    try {
      const ev = JSON.parse(data) as { type?: string; usage?: unknown; timings?: unknown; message?: { usage?: unknown } };
      this.noteTimings(ev.timings ?? ev.usage ?? ev.message?.usage);
      if (ev.type === "message_start") mergeUsage(this.usage, ev.message?.usage);
      else if (ev.type === "message_delta") mergeUsage(this.usage, ev.usage);
    } catch {
      /* malformed event: ignore */
    }
  }

  private noteTimings(t: unknown): void {
    if (!t || typeof t !== "object") return;
    const o = t as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
    const ns = (v: unknown) => (num(v) === undefined ? undefined : num(v)! / 1e6); // Ollama reports nanoseconds
    const promptMs = num(o.prompt_ms) ?? ns(o.prompt_eval_duration);
    const predictedMs = num(o.predicted_ms) ?? ns(o.eval_duration);
    if (promptMs !== undefined || predictedMs !== undefined) this.serverTimings = { ...this.serverTimings, ...(promptMs !== undefined && { promptMs }), ...(predictedMs !== undefined && { predictedMs }) };
  }

  finish(): Usage {
    if (this.mode === "json" && !this.jsonOverflow && /pai build (run|lock)/.test(this.json)) this.buildCall = true;
    if (this.mode === "sse") {
      if (this.line && !this.skipLine) this.handleLine(this.line);
      this.line = "";
    } else if (!this.jsonOverflow && this.json) {
      let body: { usage?: unknown; timings?: unknown } = {};
      try {
        body = JSON.parse(this.json) as typeof body;
      } catch {
        /* not JSON: zero usage */
      }
      mergeUsage(this.usage, body.usage);
      this.noteTimings(body.timings ?? body.usage);
      this.json = "";
    }
    return this.usage;
  }
}

// ---- cache-bust detector -------------------------------------------------

const PREFIX_MESSAGES = 2;

function sha(v: unknown): string {
  return createHash("sha256").update(JSON.stringify(v) ?? "").digest("hex").slice(0, 16);
}

/** cache_control placement moves every turn; the provider caches content, not markers. */
function stripCacheControl(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripCacheControl);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) if (k !== "cache_control") out[k] = stripCacheControl(val);
    return out;
  }
  return v;
}

/** Claude Code per-request telemetry block; changes every request, the cache survives it. */
const BILLING_PREFIX = "x-anthropic-billing-header:";

function isBillingBlock(b: unknown): boolean {
  const text = typeof b === "string" ? b : b && typeof b === "object" ? (b as { text?: unknown }).text : undefined;
  return typeof text === "string" && text.startsWith(BILLING_PREFIX);
}

/** Fingerprint view of the system prompt without the billing block (the forwarded body is never touched). */
function systemForHash(system: unknown): unknown {
  return Array.isArray(system) ? system.filter((b) => !isBillingBlock(b)) : isBillingBlock(system) ? undefined : system;
}

export interface PromptFingerprint {
  system: string;
  tools: string;
  messages: string;
}

export function fingerprint(body: Record<string, unknown>): PromptFingerprint {
  const msgs = Array.isArray(body.messages) ? body.messages.slice(0, PREFIX_MESSAGES) : [];
  return {
    system: sha(stripCacheControl(systemForHash(body.system))),
    tools: sha(stripCacheControl(body.tools)),
    messages: sha(stripCacheControl(msgs)),
  };
}

export class BustDetector {
  private seen = new Map<string, PromptFingerprint>();
  busts = 0;

  constructor(private readonly maxSessions = 500) {}

  /** Changed parts vs the previous request of this session (empty when stable or first). */
  check(session: string | undefined, fp: PromptFingerprint): string[] {
    if (!session) return [];
    const prev = this.seen.get(session);
    this.seen.delete(session);
    this.seen.set(session, fp);
    if (this.seen.size > this.maxSessions) this.seen.delete(this.seen.keys().next().value as string);
    if (!prev) return [];
    const changed = (["system", "tools", "messages"] as const).filter((k) => prev[k] !== fp[k]);
    if (changed.length) this.busts++;
    return changed;
  }
}

/** Seconds since the previous request of the same session (start to start). */
export class GapTracker {
  private last = new Map<string, number>();

  constructor(private readonly maxSessions = 2000) {}

  gap(session: string | undefined, nowMs: number): number | undefined {
    if (!session) return undefined;
    const prev = this.last.get(session);
    this.last.delete(session);
    this.last.set(session, nowMs);
    if (this.last.size > this.maxSessions) this.last.delete(this.last.keys().next().value as string);
    return prev === undefined ? undefined : Math.round((nowMs - prev) / 100) / 10;
  }
}

export function headerValue(h: string | string[] | undefined, max = 120): string | undefined {
  const v = Array.isArray(h) ? h[0] : h;
  return v ? v.slice(0, max) : undefined;
}

export function sessionTag(header: string | string[] | undefined): string | undefined {
  const v = Array.isArray(header) ? header[0] : header;
  return v ? createHash("sha256").update(v).digest("hex").slice(0, 8) : undefined;
}

// ---- storage + stats -----------------------------------------------------

export function appendUsage(row: UsageRow, file: string = usageLogFile()): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(row) + "\n");
  } catch {
    /* accounting must never break routing */
  }
}

export function readUsage(file: string = usageLogFile()): UsageRow[] {
  if (!existsSync(file)) return [];
  const rows: UsageRow[] = [];
  for (const l of readFileSync(file, "utf8").split("\n")) {
    if (!l) continue;
    try {
      rows.push(JSON.parse(l) as UsageRow);
    } catch {
      /* skip torn line */
    }
  }
  return rows;
}

/** Row arrays known to hold their rows in time order (the cached log, while every appended row is not older than the one before). */
const timeOrdered = new WeakSet<UsageRow[]>();
export const isTimeOrdered = (rows: UsageRow[]): boolean => timeOrdered.has(rows);
export const markTimeOrdered = (rows: UsageRow[]): void => void timeOrdered.add(rows);

export function parseSince(s: string): number {
  const m = /^(\d+)\s*([smhd])$/.exec(s.trim());
  if (!m) throw new Error(`bad --since "${s}" (use e.g. 30m, 1h, 2d)`);
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
}

export interface StatsGroup extends Usage {
  provider: string;
  model: string;
  requests: number;
  hit: number;
  write: number;
  miss: number;
  busts: number;
  bytes: number;
  /** cache_read / (cache_read + cache_creation + input) */
  hitRatio: number;
}

export function aggregate(rows: UsageRow[], sinceMs?: number, now: number = Date.now()): StatsGroup[] {
  const groups = new Map<string, StatsGroup>();
  for (const r of rows) {
    if (sinceMs !== undefined && Date.parse(r.ts) < now - sinceMs) continue;
    const key = `${r.provider}\u0000${r.model}`;
    let g = groups.get(key);
    if (!g) {
      g = { ...emptyUsage(), provider: r.provider, model: r.model, requests: 0, hit: 0, write: 0, miss: 0, busts: 0, bytes: 0, hitRatio: 0 };
      groups.set(key, g);
    }
    g.requests++;
    g[r.cache]++;
    if (r.bust?.length) g.busts++;
    g.bytes += r.bytes ?? 0;
    for (const k of KEYS) g[k] += r[k] ?? 0;
  }
  for (const g of groups.values()) {
    const denom = g.cache_read_input_tokens + g.cache_creation_input_tokens + g.input_tokens;
    g.hitRatio = denom ? g.cache_read_input_tokens / denom : 0;
  }
  return [...groups.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
}

export interface SessionStats extends Usage {
  session: string;
  /** display name, null when PAI does not know the session */
  name: string | null;
  requests: number;
  busts: number;
  firstTs: string;
  lastTs: string;
  hitRatio: number;
}

/** Totals per session (raw session_id, else the hash tag, else "-"). */
export function aggregateBySession(
  rows: UsageRow[],
  sinceMs?: number,
  now: number = Date.now(),
  nameOf: (id: string) => string | null = () => null
): SessionStats[] {
  const groups = new Map<string, SessionStats>();
  for (const r of rows) {
    if (sinceMs !== undefined && Date.parse(r.ts) < now - sinceMs) continue;
    const key = r.session_id ?? r.session ?? "-";
    let g = groups.get(key);
    if (!g) {
      g = { ...emptyUsage(), session: key, name: r.session_id ? nameOf(r.session_id) : null, requests: 0, busts: 0, firstTs: r.ts, lastTs: r.ts, hitRatio: 0 };
      groups.set(key, g);
    }
    g.requests++;
    if (r.bust?.length) g.busts++;
    if (r.ts < g.firstTs) g.firstTs = r.ts;
    if (r.ts > g.lastTs) g.lastTs = r.ts;
    for (const k of KEYS) g[k] += r[k] ?? 0;
  }
  for (const g of groups.values()) {
    const denom = g.cache_read_input_tokens + g.cache_creation_input_tokens + g.input_tokens;
    g.hitRatio = denom ? g.cache_read_input_tokens / denom : 0;
  }
  return [...groups.values()].sort((a, b) => b.lastTs.localeCompare(a.lastTs));
}

// ---- session-kind split: continuous vs one-shot --------------------------

/** Token totals + hit ratio of one group of sessions. */
export interface SessionKindStats extends Usage {
  /** Sessions in the group. */
  sessions: number;
  requests: number;
  hitRatio: number;
}

/** Continuous (multi-request) vs one-shot (exactly one request) sessions. */
export interface SessionKindSplit {
  /** A provider-side prompt cache can serve these across requests. */
  continuous: SessionKindStats;
  /** One request, then the session is gone — every request is a cold cache. */
  oneShot: SessionKindStats;
}

const emptyKindStats = (): SessionKindStats => ({
  ...emptyUsage(),
  sessions: 0,
  requests: 0,
  hitRatio: 0,
});

/**
 * Split usage rows by how many requests each session made: a continuous
 * session carries the provider prompt cache from request to request, a
 * one-shot session (the shape of today's `pai worker run` traffic — 158 of
 * 161 glm sessions carry exactly one request) is a fresh spawn each time and
 * shows what the cache is worth. The overall hitRatio alone averages these
 * two populations into one number that predicts neither.
 */
export function splitBySessionKind(
  rows: UsageRow[],
  sinceMs?: number,
  now: number = Date.now()
): SessionKindSplit {
  interface PerSession extends Usage {
    requests: number;
  }
  const bySession = new Map<string, PerSession>();
  for (const r of rows) {
    if (sinceMs !== undefined && Date.parse(r.ts) < now - sinceMs) continue;
    const key = r.session_id ?? r.session ?? "-";
    let g = bySession.get(key);
    if (!g) {
      g = { ...emptyUsage(), requests: 0 };
      bySession.set(key, g);
    }
    g.requests++;
    for (const k of KEYS) g[k] += r[k] ?? 0;
  }
  const out: SessionKindSplit = { continuous: emptyKindStats(), oneShot: emptyKindStats() };
  const ratio = (g: SessionKindStats): void => {
    const denom = g.cache_read_input_tokens + g.cache_creation_input_tokens + g.input_tokens;
    g.hitRatio = denom ? g.cache_read_input_tokens / denom : 0;
  };
  for (const g of bySession.values()) {
    const bucket = g.requests > 1 ? out.continuous : out.oneShot;
    bucket.sessions++;
    bucket.requests += g.requests;
    for (const k of KEYS) bucket[k] += g[k];
  }
  ratio(out.continuous);
  ratio(out.oneShot);
  return out;
}

export function formatSessionStats(groups: SessionStats[]): string {
  if (!groups.length) return "no router requests recorded";
  const head = ["session", "name", "req", "in", "out", "cache_w", "cache_r", "hit%", "busts", "last"];
  const lines = groups.map((g) => [
    g.session.slice(0, 8),
    g.name ?? "-",
    String(g.requests),
    String(g.input_tokens),
    String(g.output_tokens),
    String(g.cache_creation_input_tokens),
    String(g.cache_read_input_tokens),
    (g.hitRatio * 100).toFixed(1),
    String(g.busts),
    g.lastTs,
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i]!.length)));
  const fmt = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  return [fmt(head), ...lines.map(fmt)].join("\n");
}

export function formatStats(groups: StatsGroup[]): string {
  if (!groups.length) return "no router requests recorded";
  const head = ["provider", "model", "req", "in", "out", "cache_w", "cache_r", "hit/write/miss", "hit%", "busts"];
  const lines = groups.map((g) => [
    g.provider,
    g.model,
    String(g.requests),
    String(g.input_tokens),
    String(g.output_tokens),
    String(g.cache_creation_input_tokens),
    String(g.cache_read_input_tokens),
    `${g.hit}/${g.write}/${g.miss}`,
    (g.hitRatio * 100).toFixed(1),
    String(g.busts),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i]!.length)));
  const fmt = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  return [fmt(head), ...lines.map(fmt)].join("\n");
}
