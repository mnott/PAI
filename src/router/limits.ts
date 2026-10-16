/**
 * limits.ts — per-provider plan limits for the cockpit. Polled at most once a
 * minute and cached; keys and tokens stay in this process and never reach the
 * page or the JSON it is served.
 *
 *   anthropic  Max plan 5h/7d via the OAuth usage endpoint (token from the
 *              keychain, as the statusline does); advisor-mode.json as fallback
 *   others     the provider's workers.yaml `usage` block (jq expressions)
 *   local      up/down (TCP), RSS of the listener, tokens/s from accounting
 *   rest       counted requests vs a configured limit, labelled "estimated"
 */

import { execFile, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
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
  /** average output tokens per second over the last hour */
  tokensPerSec?: number;
  error?: string;
  fetchedAt: number;
}

export const ESTIMATE_FILE = join(homedir(), ".claude", "pai", "router-limits.json");
export const ADVISOR_FILE = join(homedir(), ".claude", "pai", "advisor-mode.json");

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

async function anthropicLimits(now: number, advisorFile: string): Promise<ProviderLimits> {
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

async function providerPlanLimits(name: string, p: WorkerProvider, now: number): Promise<ProviderLimits> {
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
    return { ...base, windows: [], error: (e as Error).message.replace(/Bearer\s+\S+/g, "Bearer ***") };
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
  return { provider: name, kind: "local", windows: [], up, ...(rssMb ? { rssMb } : {}), ...tokensPerSec(rows, name, now), fetchedAt: now };
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
}

/** Polls all providers at most once per `ttlMs`; concurrent callers share one poll. */
export class LimitsCache {
  private value: ProviderLimits[] = [];
  private at = 0;
  private inflight: Promise<ProviderLimits[]> | undefined;

  constructor(private readonly deps: LimitsDeps, private readonly ttlMs = 60_000) {}

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
    const jobs: Array<Promise<ProviderLimits>> = [anthropicLimits(now, this.deps.advisorFile ?? ADVISOR_FILE)];
    for (const [name, p] of Object.entries(providers)) {
      if (p.native || name === "anthropic" || p.enabled === false || !p.baseUrl) continue;
      if (isLocalUrl(p.baseUrl)) jobs.push(localLimits(name, p, rows, now));
      else if (p.usage) jobs.push(providerPlanLimits(name, p, now));
      else if (caps[name]) {
        jobs.push(Promise.resolve({ provider: name, kind: "estimated", windows: estimateWindows(rows, name, caps[name]!, now), fetchedAt: now }));
      }
    }
    return Promise.all(jobs);
  }
}
