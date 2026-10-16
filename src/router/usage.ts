/**
 * usage.ts — per-request token and cache accounting for the router.
 *
 * Usage is parsed from the response as it streams (SSE message_start /
 * message_delta) or from the JSON body; only numbers and hashes are stored,
 * never bodies, keys or content.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const USAGE_LOG_FILE = join(homedir(), ".claude", "pai", "logs", "router-usage.jsonl");

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
  status: number;
  ms: number;
  bytes: number;
  cache: CacheVerdict;
  /** short hash of x-claude-code-session-id, when sent */
  session?: string;
  /** which prompt part changed inside a session: system, tools, messages */
  bust?: string[];
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
    // cheap prefilter: only usage-bearing events are parsed
    if (!data.includes('"usage"')) return;
    try {
      const ev = JSON.parse(data) as { type?: string; usage?: unknown; message?: { usage?: unknown } };
      if (ev.type === "message_start") mergeUsage(this.usage, ev.message?.usage);
      else if (ev.type === "message_delta") mergeUsage(this.usage, ev.usage);
    } catch {
      /* malformed event: ignore */
    }
  }

  finish(): Usage {
    if (this.mode === "sse") {
      if (this.line && !this.skipLine) this.handleLine(this.line);
      this.line = "";
    } else if (!this.jsonOverflow && this.json) {
      mergeUsage(this.usage, (() => {
        try {
          return (JSON.parse(this.json) as { usage?: unknown }).usage;
        } catch {
          return undefined;
        }
      })());
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

export interface PromptFingerprint {
  system: string;
  tools: string;
  messages: string;
}

export function fingerprint(body: Record<string, unknown>): PromptFingerprint {
  const msgs = Array.isArray(body.messages) ? body.messages.slice(0, PREFIX_MESSAGES) : [];
  return {
    system: sha(stripCacheControl(body.system)),
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

export function sessionTag(header: string | string[] | undefined): string | undefined {
  const v = Array.isArray(header) ? header[0] : header;
  return v ? createHash("sha256").update(v).digest("hex").slice(0, 8) : undefined;
}

// ---- storage + stats -----------------------------------------------------

export function appendUsage(row: UsageRow, file: string = USAGE_LOG_FILE): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(row) + "\n");
  } catch {
    /* accounting must never break routing */
  }
}

export function readUsage(file: string = USAGE_LOG_FILE): UsageRow[] {
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
