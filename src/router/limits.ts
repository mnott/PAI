/**
 * limits.ts — per-provider plan limits for the cockpit. Polled at most once a
 * minute and cached; keys and tokens stay in this process and never reach the
 * page or the JSON it is served.
 *
 *   anthropic  Max plan 5h/7d via the OAuth usage endpoint (token from the
 *              keychain), polled at most every ANTHROPIC_POLL_MS by all readers
 *              together (anthropicShared); on http 429 the poll backs off for
 *              Retry-After (else doubling, capped) and the last good reading is
 *              served with its age; advisor-mode.json only without a reading
 *   others     the provider's workers.yaml `usage` block (jq expressions)
 *   local      up/down (TCP), RSS of the listener, tokens/s from accounting
 *   rest       counted requests vs a configured limit, labelled "estimated"
 */

import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveProviderKey, type ProviderUsage, type WorkerProvider } from "../workers/config.js";
import type { UsageRow } from "./usage.js";

export interface LimitWindow {
  name: string;
  /** used, 0-100 */
  percent: number;
  /** epoch ms of the next reset */
  resetAt?: number;
  estimated?: boolean;
}

export interface ProviderLimits {
  provider: string;
  kind: "plan" | "estimated" | "local";
  windows: LimitWindow[];
  up?: boolean;
  rssMb?: number;
  /** model ids the local server lists */
  served?: string[];
  /** average output tokens per second over the last hour */
  tokensPerSec?: number;
  /** prefix-cache counters the local server reports itself (undefined = server does not report them) */
  prefixCache?: PrefixCacheStats;
  error?: string;
  /** the last poll was answered http 429: the reading shown is the last good one */
  rateLimited?: boolean;
  /** ms until the provider may be polled again, when rate limited */
  retryAfterMs?: number;
  fetchedAt: number;
}

/** A local server's own prefix-cache counters (vllm-mlx GET /v1/cache/stats), since the server started. */
export interface PrefixCacheStats {
  hits: number;
  misses: number;
  /** hits / (hits + misses), 0..1 */
  hitRate: number;
  /** prompt tokens the server did not have to recompute */
  tokensSaved: number;
  entries?: number;
  memoryMb?: number;
}

export const ESTIMATE_FILE = join(homedir(), ".claude", "pai", "router-limits.json");
export const ADVISOR_FILE = join(homedir(), ".claude", "pai", "advisor-mode.json");
/** Last good plan reading per provider, so a rate-limited poll shows an age, not "reset unknown". */
export const LASTGOOD_FILE = join(homedir(), ".claude", "pai", "logs", "router-limits-last.json");
/** A last good reading older than this is too stale to serve when the endpoint fails. */
export const PLAN_LASTGOOD_MAX_AGE = 2 * 3_600_000;
/** Upper bound for the poll delay after repeated 429s. */
export const BACKOFF_MAX = 30 * 60_000;
/** Anthropic's usage endpoint is polled at most this often, by all processes together. */
export const ANTHROPIC_POLL_MS = 5 * 60_000;
/** Shared poll state (backoff per provider), read by the router, the budget probe and the statusline. */
export const GATE_FILE = join(homedir(), ".claude", "pai", "logs", "router-poll-gate.json");

/** The windows of one provider's last successful poll. */
export interface LastGoodEntry {
  windows: LimitWindow[];
  fetchedAt: number;
}

export function readLastGood(file: string = LASTGOOD_FILE): Record<string, LastGoodEntry> {
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as Record<string, Partial<LastGoodEntry>>;
    const out: Record<string, LastGoodEntry> = {};
    for (const [k, v] of Object.entries(j)) {
      if (v && Array.isArray(v.windows) && typeof v.fetchedAt === "number") out[k] = { windows: v.windows, fetchedAt: v.fetchedAt };
    }
    return out;
  } catch {
    return {};
  }
}

function writeLastGood(file: string, entries: Record<string, LastGoodEntry>): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(entries, null, 1));
  } catch {
    /* best-effort cache */
  }
}

/** "4 min" / "1 h 5 min" for an age or delay. */
export function humanMinutes(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ""}`;
}

/** The plain-words error for a reading that is not fresh. */
export function staleText(ageMs: number, cause: string, retryInMs?: number): string {
  const retry = retryInMs && retryInMs > 0 ? `, next try in ${humanMinutes(retryInMs)}` : "";
  return cause === "http 429"
    ? `usage reading ${humanMinutes(ageMs)} old, provider asked us to slow down${retry}`
    : `usage reading ${humanMinutes(ageMs)} old (${cause})${retry}`;
}

/**
 * The reading to show when a poll failed: the last good one, with its age in
 * the error field, while it is fresh enough to trust; undefined otherwise.
 */
export function staleReading(
  provider: string,
  entry: LastGoodEntry | undefined,
  cause: string,
  now: number,
  maxAge: number = PLAN_LASTGOOD_MAX_AGE,
  retryInMs?: number
): ProviderLimits | undefined {
  if (!entry || !entry.windows.length || now - entry.fetchedAt >= maxAge) return undefined;
  return {
    provider,
    kind: "plan",
    windows: entry.windows,
    fetchedAt: entry.fetchedAt,
    error: staleText(now - entry.fetchedAt, cause, retryInMs),
    ...(cause === "http 429" ? { rateLimited: true } : {}),
    ...(retryInMs ? { retryAfterMs: retryInMs } : {}),
  };
}

/** A failed fetch; `retryAfterMs` is the server's Retry-After on a http 429. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs?: number
  ) {
    super(`http ${status}`);
  }
}

/** Retry-After as ms: delta-seconds or an HTTP date; undefined when absent or unusable. */
export function parseRetryAfter(v: string | string[] | undefined, now: number = Date.now()): number | undefined {
  const raw = Array.isArray(v) ? v[0] : v;
  if (!raw) return undefined;
  if (/^\d+(\.\d+)?$/.test(raw.trim())) return Math.round(Number(raw) * 1000);
  const t = Date.parse(raw);
  return Number.isFinite(t) ? Math.max(0, t - now) : undefined;
}

interface GateEntry {
  mult: number;
  until: number;
}

/**
 * Per-provider poll backoff after a http 429. The delay is the server's
 * Retry-After when it sent one, else the base interval doubled per strike up
 * to the ceiling; a success clears the strikes. With a `file` the state is
 * shared between processes (router, budget probe, statusline) and survives a
 * restart.
 */
export class Backoff {
  private state: Record<string, GateEntry> = {};

  constructor(
    private readonly baseMs: number,
    private readonly maxMs: number = BACKOFF_MAX,
    private readonly file?: string
  ) {}

  private load(): void {
    if (!this.file) return;
    try {
      this.state = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, GateEntry>;
    } catch {
      this.state = {};
    }
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.state));
    } catch {
      /* best-effort shared state */
    }
  }

  /** Record a 429 seen for `provider` at `now`; returns the delay before its next poll. */
  penalize(provider: string, now: number, retryAfterMs?: number): number {
    this.load();
    const m = Math.min((this.state[provider]?.mult ?? 1) * 2, Math.max(1, this.maxMs / this.baseMs));
    const delay = retryAfterMs !== undefined ? Math.min(Math.max(retryAfterMs, 1000), PLAN_LASTGOOD_MAX_AGE) : m * this.baseMs;
    this.state[provider] = { mult: m, until: now + delay };
    this.save();
    return delay;
  }

  /** ms until `provider` is due again; 0 when it may be polled now. */
  remaining(provider: string, now: number): number {
    this.load();
    return Math.max(0, (this.state[provider]?.until ?? 0) - now);
  }

  /** A poll succeeded: forget the strikes. */
  reset(provider: string): void {
    this.load();
    if (!(provider in this.state)) return;
    delete this.state[provider];
    this.save();
  }
}

function toMs(v: unknown, unit: "ms" | "s" | "iso" | undefined): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  if (unit === "iso" || (unit === undefined && typeof v === "string" && !/^\d+(\.\d+)?$/.test(v))) {
    const t = Date.parse(String(v));
    return Number.isFinite(t) ? t : undefined;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return unit === "s" ? n * 1000 : n;
}

function jq(expr: string, input: string): string | undefined {
  const r = spawnSync("jq", ["-r", expr], { input, encoding: "utf8", timeout: 3000 });
  if (r.status !== 0) return undefined;
  const out = r.stdout.trim().split("\n")[0];
  return out === undefined || out === "" || out === "null" ? undefined : out;
}

/** Windows of a provider usage response, using its configured jq expressions. */
export function windowsFromJson(body: string, cfg: ProviderUsage): LimitWindow[] {
  const out: LimitWindow[] = [];
  for (const w of cfg.windows) {
    const pct = Number(jq(w.percent, body));
    if (!Number.isFinite(pct) || jq(w.percent, body) === undefined) continue;
    const reset = w.resetAt ? toMs(jq(w.resetAt, body), w.resetUnit) : undefined;
    out.push({ name: w.name, percent: Math.round(pct * 10) / 10, ...(reset ? { resetAt: reset } : {}) });
  }
  return out;
}

/** Anthropic OAuth usage response: five_hour / seven_day {utilization, resets_at ISO}. */
export function parseAnthropicUsage(body: string): LimitWindow[] {
  let j: Record<string, { utilization?: number; resets_at?: string } | null>;
  try {
    j = JSON.parse(body);
  } catch {
    return [];
  }
  const out: LimitWindow[] = [];
  for (const [key, name] of [["five_hour", "5h"], ["seven_day", "7d"]] as const) {
    const w = j[key];
    if (!w || typeof w.utilization !== "number") continue;
    const reset = toMs(w.resets_at, "iso");
    out.push({ name, percent: w.utilization, ...(reset ? { resetAt: reset } : {}) });
  }
  return out;
}

/** Counted requests inside each window vs a configured cap: labelled estimated. */
export function estimateWindows(
  rows: UsageRow[],
  provider: string,
  caps: Record<string, number>,
  now: number
): LimitWindow[] {
  const spans: Record<string, number> = { "5h": 5 * 3_600_000, "7d": 7 * 86_400_000 };
  const out: LimitWindow[] = [];
  for (const [name, span] of Object.entries(spans)) {
    const cap = caps[name];
    if (!cap) continue;
    const inWin = rows.filter((r) => r.provider === provider && Date.parse(r.ts) >= now - span);
    const first = inWin.reduce((m, r) => Math.min(m, Date.parse(r.ts)), Infinity);
    out.push({
      name,
      percent: Math.round((inWin.length / cap) * 1000) / 10,
      ...(Number.isFinite(first) ? { resetAt: first + span } : {}),
      estimated: true,
    });
  }
  return out;
}

export function readEstimateCaps(file: string = ESTIMATE_FILE): Record<string, Record<string, number>> {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, Record<string, number>>) : {};
  } catch {
    return {};
  }
}

/** The OAuth usage endpoint the anthropic plan readings come from. */
export const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export function getJson(url: URL, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const rq = mod.get(url, { headers, timeout: 5000 }, (res) => {
      let t = "";
      res.on("data", (c) => (t += c));
      res.on("end", () =>
        res.statusCode === 200
          ? resolve(t)
          : reject(new HttpError(res.statusCode ?? 0, res.statusCode === 429 ? parseRetryAfter(res.headers["retry-after"]) : undefined))
      );
    });
    rq.on("timeout", () => rq.destroy(new Error("timeout")));
    rq.on("error", reject);
  });
}

function sh(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 4000 }, (_e, out) => resolve(String(out ?? "").trim())));
}

export async function anthropicToken(): Promise<string | undefined> {
  for (const args of [["-a", process.env.USER ?? ""], []]) {
    const raw = await sh("security", ["find-generic-password", "-s", "Claude Code-credentials", ...args, "-w"]);
    try {
      const t = (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } }).claudeAiOauth?.accessToken;
      if (t) return t;
    } catch {
      /* try next */
    }
  }
  return undefined;
}

/** What a shared anthropic poll needs; defaults are the live files, tests pass temp ones. */
export interface AnthropicPollOpts {
  gate?: Backoff;
  lastGoodFile?: string;
  /** advisor-mode.json fallback when there is no earlier reading; omitted = none */
  advisorFile?: string;
  /** replaces the keychain + https fetch (tests) */
  fetchUsage?: () => Promise<string>;
}

let liveGate: Backoff | undefined;
export function sharedGate(): Backoff {
  return (liveGate ??= new Backoff(ANTHROPIC_POLL_MS, BACKOFF_MAX, GATE_FILE));
}

async function fetchAnthropicUsage(): Promise<string> {
  const token = await anthropicToken();
  if (!token) throw new Error("no OAuth token in keychain");
  return getJson(new URL(ANTHROPIC_USAGE_URL), { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" });
}

/**
 * The one door to the anthropic usage endpoint, for every reader in every
 * process: a reading younger than ANTHROPIC_POLL_MS is read from the shared
 * last-good file, nothing is fetched while a 429 backoff (Retry-After, else
 * doubling to a ceiling; kept in the shared gate file) is running, and only
 * then does one caller poll. A rate-limited poll serves the last good reading
 * with its honest age.
 */
export async function anthropicShared(now: number, o: AnthropicPollOpts = {}): Promise<ProviderLimits> {
  const gate = o.gate ?? sharedGate();
  const file = o.lastGoodFile ?? LASTGOOD_FILE;
  const lg = readLastGood(file)["anthropic"];
  const base = { provider: "anthropic", kind: "plan" as const, fetchedAt: now };
  const wait = gate.remaining("anthropic", now);
  if (wait > 0) {
    return staleReading("anthropic", lg, "http 429", now, undefined, wait) ?? {
      ...base,
      windows: [],
      error: `provider asked us to slow down, next try in ${humanMinutes(wait)}`,
      rateLimited: true,
      retryAfterMs: wait,
    };
  }
  if (lg && lg.windows.length && now - lg.fetchedAt < ANTHROPIC_POLL_MS) return { ...base, windows: lg.windows, fetchedAt: lg.fetchedAt };
  try {
    const windows = parseAnthropicUsage(await (o.fetchUsage ?? fetchAnthropicUsage)());
    if (!windows.length) throw new Error("no usage windows in response");
    gate.reset("anthropic");
    writeLastGood(file, { ...readLastGood(file), anthropic: { windows, fetchedAt: now } });
    return { ...base, windows };
  } catch (e) {
    const err = e as Error;
    const limited = err instanceof HttpError && err.status === 429;
    const retry = limited ? gate.penalize("anthropic", now, (err as HttpError).retryAfterMs) : undefined;
    const stale = staleReading("anthropic", lg, err.message, now, undefined, retry);
    if (stale) return stale;
    if (o.advisorFile) {
      try {
        const a = JSON.parse(readFileSync(o.advisorFile, "utf8")) as { weeklyBudgetPercent?: number; asOf?: number };
        if (typeof a.weeklyBudgetPercent === "number" && a.asOf && now / 1000 - a.asOf < 6 * 3600) {
          return { ...base, windows: [{ name: "7d", percent: a.weeklyBudgetPercent }], error: `${err.message}; advisor-mode fallback`, ...(limited ? { rateLimited: true } : {}) };
        }
      } catch {
        /* no fallback */
      }
    }
    return { ...base, windows: [], error: limited ? `provider asked us to slow down, next try in ${humanMinutes(retry!)}` : err.message, ...(limited ? { rateLimited: true, retryAfterMs: retry } : {}) };
  }
}

async function providerPlanLimits(name: string, p: WorkerProvider, now: number, lastGood: LastGoodEntry | undefined): Promise<ProviderLimits> {
  const base = { provider: name, kind: "plan" as const, fetchedAt: now };
  const u = p.usage!;
  try {
    const key = resolveProviderKey(p);
    const [hn, ...pre] = (u.authHeader ?? "Authorization: Bearer").split(/:\s*/);
    const prefix = pre.join(": ");
    const headers: Record<string, string> = { [hn!.toLowerCase()]: prefix ? `${prefix} ${key}` : String(key) };
    const body = await getJson(new URL(u.url), headers);
    const windows = windowsFromJson(body, u);
    return windows.length ? { ...base, windows } : { ...base, windows, error: "no windows parsed" };
  } catch (e) {
    const msg = (e as Error).message.replace(/Bearer\s+\S+/g, "Bearer ***");
    const limited = e instanceof HttpError && e.status === 429;
    const retry = limited ? e.retryAfterMs : undefined;
    return (
      staleReading(name, lastGood, msg, now, undefined, retry) ?? {
        ...base,
        windows: [],
        error: limited ? `provider asked us to slow down${retry ? `, retry after ${humanMinutes(retry)}` : ""}` : msg,
        ...(limited ? { rateLimited: true, ...(retry ? { retryAfterMs: retry } : {}) } : {}),
      }
    );
  }
}

function probeTcp(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host, timeout: 800 });
    s.on("connect", () => (s.destroy(), resolve(true)));
    s.on("timeout", () => (s.destroy(), resolve(false)));
    s.on("error", () => resolve(false));
  });
}

export async function localLimits(name: string, p: WorkerProvider, rows: UsageRow[], now: number): Promise<ProviderLimits> {
  const u = new URL(p.baseUrl);
  const port = Number(u.port) || 80;
  const listening = await probeTcp(port, u.hostname);
  // An accepted TCP connection proves nothing: launchd (or any socket holder) accepts for a server
  // that is not running. Up means the server answers HTTP, and serves this provider's model.
  const probe = listening ? await servedModels(u) : { alive: false };
  const served = probe.ids;
  const up = probe.alive && modelServed(served, Object.values(p.models).filter((m): m is string => typeof m === "string"));
  let rssMb: number | undefined;
  let prefixCache: PrefixCacheStats | undefined;
  if (up) {
    const pid = (await sh("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"])).split("\n")[0];
    const rss = pid ? Number(await sh("ps", ["-o", "rss=", "-p", pid])) : NaN;
    if (Number.isFinite(rss) && rss > 0) rssMb = Math.round(rss / 1024);
    prefixCache = await prefixCacheStats(u, p);
  }
  return {
    provider: name,
    kind: "local",
    windows: [],
    up,
    ...(rssMb ? { rssMb } : {}),
    ...(served ? { served } : {}),
    ...(prefixCache ? { prefixCache } : {}),
    ...tokensPerSec(rows, name, now),
    fetchedAt: now,
  };
}

/** GET /v1/models: `alive` = the server answered HTTP at all (any status); `ids` = the models it lists, when it can say. */
async function servedModels(base: URL): Promise<{ alive: boolean; ids?: string[] }> {
  try {
    const body = JSON.parse(await getJson(new URL("/v1/models", base), {})) as { data?: Array<{ id?: unknown }> };
    const ids = (body.data ?? []).map((m) => m.id).filter((i): i is string => typeof i === "string");
    return ids.length ? { alive: true, ids } : { alive: true };
  } catch (e) {
    // a busy server may be slow to answer (timeout); one that resets or closes the connection is not serving
    return { alive: e instanceof HttpError || (e as Error).message === "timeout" };
  }
}

/** Number or undefined. */
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** The prefix-cache counters in a vllm-mlx GET /v1/cache/stats body; undefined when it carries none. */
export function parsePrefixCacheStats(body: string): PrefixCacheStats | undefined {
  try {
    const c = (JSON.parse(body) as { engine_cache?: Record<string, unknown> | null }).engine_cache;
    const hits = num(c?.hits);
    const misses = num(c?.misses);
    if (!c || hits === undefined || misses === undefined) return undefined;
    const entries = num(c.entry_count);
    const memoryMb = num(c.current_memory_mb);
    return {
      hits,
      misses,
      hitRate: hits + misses ? hits / (hits + misses) : 0,
      tokensSaved: num(c.tokens_saved) ?? 0,
      ...(entries !== undefined ? { entries } : {}),
      ...(memoryMb !== undefined ? { memoryMb } : {}),
    };
  } catch {
    return undefined;
  }
}

async function prefixCacheStats(base: URL, p: WorkerProvider): Promise<PrefixCacheStats | undefined> {
  let headers: Record<string, string> = {};
  try {
    headers = { authorization: `Bearer ${resolveProviderKey(p)}` };
  } catch {
    /* no key: the endpoint may not need one */
  }
  try {
    return parsePrefixCacheStats(await getJson(new URL("/v1/cache/stats", base), headers));
  } catch {
    return undefined;
  }
}

/** Several providers can share one port: the provider is up only if its model is the one served. Unknown list = port decides. */
export function modelServed(served: string[] | undefined, wanted: string[]): boolean {
  if (!served) return true;
  return wanted.some((w) => served.includes(w));
}

/** output tokens / generation seconds over the last hour (slow-path requests only). */
export function tokensPerSec(rows: UsageRow[], provider: string, now: number): { tokensPerSec?: number } {
  let out = 0;
  let ms = 0;
  for (const r of rows) {
    if (r.provider !== provider || Date.parse(r.ts) < now - 3_600_000 || r.status !== 200 || !r.output_tokens) continue;
    out += r.output_tokens;
    ms += r.ms;
  }
  return ms ? { tokensPerSec: Math.round((out / (ms / 1000)) * 10) / 10 } : {};
}

function isLocalUrl(u: string): boolean {
  try {
    const h = new URL(u).hostname;
    return h === "127.0.0.1" || h === "localhost";
  } catch {
    return false;
  }
}

export interface LimitsDeps {
  providers: () => Record<string, WorkerProvider>;
  rows: () => UsageRow[];
  advisorFile?: string;
  estimateFile?: string;
  /** Last-good store override (tests); defaults to LASTGOOD_FILE. */
  lastGoodFile?: string;
  /** Shared poll gate override (tests); defaults to GATE_FILE. */
  gate?: Backoff;
  /** Replaces the anthropic keychain + https fetch (tests). */
  fetchAnthropic?: () => Promise<string>;
}

/**
 * Polls all providers at most once per `ttlMs`; concurrent callers share one
 * poll. A provider whose poll answered http 429 is not fetched again until its
 * backoff (the interval doubled per strike, capped) has run out — its last
 * good reading is served with the current age instead.
 */
export class LimitsCache {
  private value: ProviderLimits[] = [];
  private at = 0;
  private inflight: Promise<ProviderLimits[]> | undefined;
  private backoff: Backoff;

  constructor(private readonly deps: LimitsDeps, private readonly ttlMs = 60_000) {
    this.backoff = new Backoff(ttlMs);
  }

  get(now: number = Date.now()): Promise<ProviderLimits[]> {
    if (this.value.length && now - this.at < this.ttlMs) return Promise.resolve(this.value);
    this.inflight ??= this.poll(now).then((v) => {
      this.value = v;
      this.at = now;
      this.inflight = undefined;
      return v;
    });
    return this.inflight;
  }

  /** Last polled up/down of a local provider; undefined = never polled or not a local server. Refreshes in the background. */
  isUp = (provider: string): boolean | undefined => {
    void this.get().catch(() => undefined);
    return this.value.find((l) => l.provider === provider && l.kind === "local")?.up;
  };

  private async poll(now: number): Promise<ProviderLimits[]> {
    const rows = this.deps.rows();
    let providers: Record<string, WorkerProvider> = {};
    try {
      providers = this.deps.providers();
    } catch {
      /* config unreadable: still report anthropic */
    }
    const caps = readEstimateCaps(this.deps.estimateFile);
    const lastGoodFile = this.deps.lastGoodFile ?? LASTGOOD_FILE;
    const lastGood = readLastGood(lastGoodFile);
    const jobs: Array<Promise<ProviderLimits>> = [];
    const skipped: string[] = [];
    /** Queue a plan poll unless the provider is backing off from a 429. */
    const plan = (name: string, fn: (lg: LastGoodEntry | undefined) => Promise<ProviderLimits>): void => {
      if (this.backoff.remaining(name, now) > 0) {
        skipped.push(name);
        return;
      }
      jobs.push(fn(lastGood[name]));
    };
    jobs.push(
      anthropicShared(now, {
        gate: this.deps.gate ?? sharedGate(),
        lastGoodFile,
        advisorFile: this.deps.advisorFile ?? ADVISOR_FILE,
        ...(this.deps.fetchAnthropic ? { fetchUsage: this.deps.fetchAnthropic } : {}),
      })
    );
    for (const [name, p] of Object.entries(providers)) {
      if (p.native || name === "anthropic" || p.enabled === false || !p.baseUrl) continue;
      if (isLocalUrl(p.baseUrl)) jobs.push(localLimits(name, p, rows, now));
      else if (p.usage) plan(name, (lg) => providerPlanLimits(name, p, now, lg));
      else if (caps[name]) {
        jobs.push(Promise.resolve({ provider: name, kind: "estimated", windows: estimateWindows(rows, name, caps[name]!, now), fetchedAt: now }));
      }
    }
    const results = await Promise.all(jobs);
    // anthropic keeps its own shared last-good entry and gate (anthropicShared)
    const store = readLastGood(lastGoodFile);
    let dirty = false;
    for (const r of results) {
      if (r.provider === "anthropic") continue;
      if (r.error) {
        if (r.rateLimited) this.backoff.penalize(r.provider, now, r.retryAfterMs);
      } else {
        this.backoff.reset(r.provider);
        if (r.windows.length) {
          store[r.provider] = { windows: r.windows, fetchedAt: r.fetchedAt };
          dirty = true;
        }
      }
    }
    if (dirty) writeLastGood(lastGoodFile, store);
    // Backed-off providers stay on the page: the last good reading, with its current age.
    for (const name of skipped) {
      const wait = this.backoff.remaining(name, now);
      results.push(
        staleReading(name, store[name], "http 429", now, undefined, wait) ?? {
          provider: name,
          kind: "plan",
          windows: [],
          error: `provider asked us to slow down, next try in ${humanMinutes(wait)}`,
          rateLimited: true,
          retryAfterMs: wait,
          fetchedAt: now,
        }
      );
    }
    return results;
  }
}
