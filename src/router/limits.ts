/**
 * limits.ts — per-provider plan limits for the cockpit. Polled at most once a
 * minute and cached; keys and tokens stay in this process and never reach the
 * page or the JSON it is served.
 *
 *   anthropic  Max plan 5h/7d via the OAuth usage endpoint (token from the
 *              keychain, as the statusline does); on a failed poll (http 429)
 *              the last good reading is served with its age and the poll backs
 *              off, advisor-mode.json only when no last good reading exists
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
  error?: string;
  fetchedAt: number;
}

export const ESTIMATE_FILE = join(homedir(), ".claude", "pai", "router-limits.json");
export const ADVISOR_FILE = join(homedir(), ".claude", "pai", "advisor-mode.json");
/** Last good plan reading per provider, so a rate-limited poll shows an age, not "reset unknown". */
export const LASTGOOD_FILE = join(homedir(), ".claude", "pai", "logs", "router-limits-last.json");
/** A last good reading older than this is too stale to serve when the endpoint fails. */
export const PLAN_LASTGOOD_MAX_AGE = 2 * 3_600_000;
/** Upper bound for the poll delay after repeated 429s. */
export const BACKOFF_MAX = 30 * 60_000;

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

/**
 * The reading to show when a poll failed: the last good one, with its age in
 * the error field, while it is fresh enough to trust; undefined otherwise.
 */
export function staleReading(
  provider: string,
  entry: LastGoodEntry | undefined,
  cause: string,
  now: number,
  maxAge: number = PLAN_LASTGOOD_MAX_AGE
): ProviderLimits | undefined {
  if (!entry || !entry.windows.length || now - entry.fetchedAt >= maxAge) return undefined;
  const min = Math.round((now - entry.fetchedAt) / 60_000);
  return { provider, kind: "plan", windows: entry.windows, fetchedAt: entry.fetchedAt, error: `stale ${min}min (${cause})` };
}

/** Per-provider poll backoff after a http 429: the interval doubles per strike, resets on success. */
export class Backoff {
  private mult = new Map<string, number>();
  private until = new Map<string, number>();

  constructor(
    private readonly baseMs: number,
    private readonly maxMs: number = BACKOFF_MAX
  ) {}

  /** Record a 429 seen for `provider` at `now`; returns the delay before its next poll. */
  penalize(provider: string, now: number): number {
    const m = Math.min((this.mult.get(provider) ?? 1) * 2, this.maxMs / this.baseMs);
    this.mult.set(provider, m);
    this.until.set(provider, now + m * this.baseMs);
    return m * this.baseMs;
  }

  /** ms until `provider` is due again; 0 when it may be polled now. */
  remaining(provider: string, now: number): number {
    return Math.max(0, (this.until.get(provider) ?? 0) - now);
  }

  /** A poll succeeded: forget the strikes. */
  reset(provider: string): void {
    this.mult.delete(provider);
    this.until.delete(provider);
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

function getJson(url: URL, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const rq = mod.get(url, { headers, timeout: 5000 }, (res) => {
      let t = "";
      res.on("data", (c) => (t += c));
      res.on("end", () => (res.statusCode === 200 ? resolve(t) : reject(new Error(`http ${res.statusCode}`))));
    });
    rq.on("timeout", () => rq.destroy(new Error("timeout")));
    rq.on("error", reject);
  });
}

function sh(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 4000 }, (_e, out) => resolve(String(out ?? "").trim())));
}

async function anthropicToken(): Promise<string | undefined> {
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

async function anthropicLimits(now: number, advisorFile: string, lastGood: LastGoodEntry | undefined): Promise<ProviderLimits> {
  const base = { provider: "anthropic", kind: "plan" as const, fetchedAt: now };
  try {
    const token = await anthropicToken();
    if (!token) throw new Error("no OAuth token in keychain");
    const body = await getJson(new URL("https://api.anthropic.com/api/oauth/usage"), {
      authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
    });
    const windows = parseAnthropicUsage(body);
    if (windows.length) return { ...base, windows };
    throw new Error("no usage windows in response");
  } catch (e) {
    const stale = staleReading("anthropic", lastGood, (e as Error).message, now);
    if (stale) return stale;
    try {
      const a = JSON.parse(readFileSync(advisorFile, "utf8")) as { weeklyBudgetPercent?: number; asOf?: number };
      if (typeof a.weeklyBudgetPercent === "number" && a.asOf && now / 1000 - a.asOf < 6 * 3600) {
        return { ...base, windows: [{ name: "7d", percent: a.weeklyBudgetPercent }], error: `${(e as Error).message}; advisor-mode fallback` };
      }
    } catch {
      /* no fallback */
    }
    return { ...base, windows: [], error: (e as Error).message };
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
    return staleReading(name, lastGood, msg, now) ?? { ...base, windows: [], error: msg };
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

async function localLimits(name: string, p: WorkerProvider, rows: UsageRow[], now: number): Promise<ProviderLimits> {
  const u = new URL(p.baseUrl);
  const port = Number(u.port) || 80;
  const listening = await probeTcp(port, u.hostname);
  const served = listening ? await servedModels(u) : undefined;
  const up = listening && modelServed(served, Object.values(p.models).filter((m): m is string => typeof m === "string"));
  let rssMb: number | undefined;
  if (up) {
    const pid = (await sh("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"])).split("\n")[0];
    const rss = pid ? Number(await sh("ps", ["-o", "rss=", "-p", pid])) : NaN;
    if (Number.isFinite(rss) && rss > 0) rssMb = Math.round(rss / 1024);
  }
  return { provider: name, kind: "local", windows: [], up, ...(rssMb ? { rssMb } : {}), ...(served ? { served } : {}), ...tokensPerSec(rows, name, now), fetchedAt: now };
}

/** Model ids the server at this base URL lists on GET /v1/models; undefined when it cannot say. */
async function servedModels(base: URL): Promise<string[] | undefined> {
  try {
    const body = JSON.parse(await getJson(new URL("/v1/models", base), {})) as { data?: Array<{ id?: unknown }> };
    const ids = (body.data ?? []).map((m) => m.id).filter((i): i is string => typeof i === "string");
    return ids.length ? ids : undefined;
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
    const previous = new Map(this.value.map((v) => [v.provider, v]));
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
    plan("anthropic", (lg) => anthropicLimits(now, this.deps.advisorFile ?? ADVISOR_FILE, lg));
    for (const [name, p] of Object.entries(providers)) {
      if (p.native || name === "anthropic" || p.enabled === false || !p.baseUrl) continue;
      if (isLocalUrl(p.baseUrl)) jobs.push(localLimits(name, p, rows, now));
      else if (p.usage) plan(name, (lg) => providerPlanLimits(name, p, now, lg));
      else if (caps[name]) {
        jobs.push(Promise.resolve({ provider: name, kind: "estimated", windows: estimateWindows(rows, name, caps[name]!, now), fetchedAt: now }));
      }
    }
    const results = await Promise.all(jobs);
    const store = { ...lastGood };
    let dirty = false;
    for (const r of results) {
      if (r.error) {
        if (r.error.includes("http 429")) this.backoff.penalize(r.provider, now);
      } else {
        this.backoff.reset(r.provider);
        if (r.windows.length) {
          store[r.provider] = { windows: r.windows, fetchedAt: r.fetchedAt };
          dirty = true;
        }
      }
    }
    if (dirty) writeLastGood(lastGoodFile, store);
    // Backed-off providers stay on the page: the previous reading, with a current age.
    for (const name of skipped) {
      const prev = previous.get(name);
      const cause = prev?.error?.includes("http 429") ? "http 429" : (prev?.error ?? "http 429");
      results.push(
        prev
          ? { ...prev, error: `stale ${Math.max(0, Math.round((now - prev.fetchedAt) / 60_000))}min (${cause})` }
          : { provider: name, kind: "plan", windows: [], error: cause, fetchedAt: now }
      );
    }
    return results;
  }
}
