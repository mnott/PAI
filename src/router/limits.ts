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
 *   local      up/down (TCP), RSS of the listener's process tree, tokens/s from accounting
 *   rest       counted requests vs a configured limit, labelled "estimated"
 */

import { execFile, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { loginUsername } from "../utils/login-username.js";
import { writeFileAtomic } from "../config/atomic-file.js";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { paiHomePath } from "../config/pai-home.js";
import { loadConfig } from "../daemon/config.js";
import { basename, dirname, join } from "node:path";
import { resolveProviderKey, type ProviderUsage, type WorkerProvider, ANTHROPIC_NATIVE } from "../workers/config.js";
import { processTreeRssMb } from "../workers/model-inventory.js";
import { vllmLogCacheStats } from "./vllm-log-cache.js";
import { serves } from "../workers/served-models.js";
import { isLocalCandidate, tierProviderNames } from "../workers/local-provider.js";
import type { UsageRow } from "./usage.js";
import { endpointSpeed, strataSpeed, type EndpointSpeed } from "./speed.js";
import { isLoopbackUrl } from "../utils/loopback.js";

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
  /** why `up` is false (local servers only) */
  downReason?: DownReason;
  rssMb?: number;
  /** weight size of the tier's model on disk, bytes (added by the cockpit payload) */
  weightsBytes?: number;
  /** model ids the local server lists */
  served?: string[];
  /** prefill and decode rate of the endpoint, measured separately (see speed.ts endpointSpeed) */
  speed?: EndpointSpeed;
  /** prefix-cache counters the local server reports itself (undefined = server does not report them) */
  prefixCache?: PrefixCacheStats;
  /** engine build of the local server's engine binary, e.g. "0.1.48-metal" (`<bin> --version`); undefined = not a Strata engine or the version could not be read */
  engineVersion?: string;
  /** directory name two levels above the engine binary (its build dir, e.g. "strata-pr"), shown beside the version */
  engineDir?: string;
  /** age of `prefixCache` when it is the last good reading kept over a failed poll; absent = fresh */
  prefixCacheAgeSec?: number;
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

export const estimateFile = (): string => paiHomePath("router-limits.json");
export const advisorModeFile = (): string => paiHomePath("advisor-mode.json");
/** Last good plan reading per provider, so a rate-limited poll shows an age, not "reset unknown". */
export const lastGoodPath = (): string => paiHomePath("logs", "router-limits-last.json");
/** A last good reading older than this is too stale to serve when the endpoint fails. */
export const PLAN_LASTGOOD_MAX_AGE = 2 * 3_600_000;
/** Upper bound for the poll delay after repeated 429s. */
export const BACKOFF_MAX = 30 * 60_000;
/** Anthropic's usage endpoint is polled at most this often, by all processes together. */
export const ANTHROPIC_POLL_MS = 5 * 60_000;
/** Shared poll state (backoff per provider), read by the router, the budget probe and the statusline. */
export const gateFile = (): string => paiHomePath("logs", "router-poll-gate.json");

/** The windows of one provider's last successful poll. */
export interface LastGoodEntry {
  windows: LimitWindow[];
  fetchedAt: number;
  /** local providers: the last good prefix-cache reading, taken at `fetchedAt` */
  prefixCache?: PrefixCacheStats;
}

export function readLastGood(file: string = lastGoodPath()): Record<string, LastGoodEntry> {
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as Record<string, Partial<LastGoodEntry>>;
    const out: Record<string, LastGoodEntry> = {};
    for (const [k, v] of Object.entries(j)) {
      if (v && Array.isArray(v.windows) && typeof v.fetchedAt === "number") out[k] = { windows: v.windows, fetchedAt: v.fetchedAt, ...(v.prefixCache ? { prefixCache: v.prefixCache } : {}) };
    }
    return out;
  } catch {
    return {};
  }
}

function writeLastGood(file: string, entries: Record<string, LastGoodEntry>): void {
  try {
    writeFileAtomic(file, JSON.stringify(entries, null, 1));
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
  const why = cause.trim();
  return cause === "http 429"
    ? `usage reading ${humanMinutes(ageMs)} old, provider asked us to slow down${retry}`
    : `usage reading ${humanMinutes(ageMs)} old${why ? ` (${why})` : ""}${retry}`;
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
      writeFileAtomic(this.file, JSON.stringify(this.state));
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

export function readEstimateCaps(file: string = estimateFile()): Record<string, Record<string, number>> {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, Record<string, number>>) : {};
  } catch {
    return {};
  }
}

/** The OAuth usage endpoint the anthropic plan readings come from (on router.claudeUpstream). */
export function anthropicUsageUrl(): URL {
  return new URL("/api/oauth/usage", loadConfig().router.claudeUpstream);
}

export function getJson(url: URL, headers: Record<string, string>, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const rq = mod.get(url, { headers, timeout: timeoutMs }, (res) => {
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

/** Keychain read failures by reason since router start, exposed in /cockpit/limits. */
const tokenFailures: Record<string, number> = {};
export function tokenFailureCounts(): Record<string, number> {
  return { ...tokenFailures };
}
export function resetTokenFailures(): void {
  for (const k of Object.keys(tokenFailures)) delete tokenFailures[k];
}

/**
 * The args that select the real "Claude Code-credentials" keychain item: always
 * with an explicit `-a <login user>`. Several items can carry the service name
 * (a stub under account "unknown" was seen), and without `-a` the first match
 * wins. The router runs under launchd with no USER in its environment, so the
 * account comes from loginUsername(), never from env.
 */
export function keychainCredentialArgs(username: string = loginUsername()): string[] {
  return ["find-generic-password", "-s", "Claude Code-credentials", "-a", username, "-w"];
}

function failToken(reason: string, detail: string): undefined {
  tokenFailures[reason] = (tokenFailures[reason] ?? 0) + 1;
  console.error(`[limits] anthropic token read failed: ${reason}${detail ? ` ${detail}` : ""}`);
  return undefined;
}

export async function anthropicToken(): Promise<string | undefined> {
  const args = keychainCredentialArgs();
  const r = await new Promise<{ err: (Error & { code?: unknown; killed?: boolean }) | null; out: string; stderr: string }>((resolve) =>
    execFile("security", args, { timeout: 4000 }, (err, out, stderr) => resolve({ err, out: String(out ?? "").trim(), stderr: String(stderr ?? "").trim() }))
  );
  if (r.err) {
    const reason = r.err.killed ? "timeout" : `exit ${String(r.err.code ?? "?")}`;
    return failToken(reason, `(account ${args[4] || "<empty>"}) stderr: ${r.stderr.slice(0, 200)}`);
  }
  try {
    const t = (JSON.parse(r.out) as { claudeAiOauth?: { accessToken?: string } }).claudeAiOauth?.accessToken;
    if (t) return t;
    return failToken("no accessToken", "");
  } catch {
    return failToken("unparsable item", "");
  }
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
  return (liveGate ??= new Backoff(ANTHROPIC_POLL_MS, BACKOFF_MAX, gateFile()));
}

/** The OAuth token goes only to Anthropic's own hosts, never to a custom router.claudeUpstream. */
export function isAnthropicHost(url: URL): boolean {
  return url.hostname === "anthropic.com" || url.hostname.endsWith(".anthropic.com");
}

export async function fetchAnthropicUsage(url: URL = anthropicUsageUrl(), token: () => Promise<string | undefined> = anthropicToken): Promise<string> {
  if (!isAnthropicHost(url)) throw new Error("usage unavailable for custom upstream");
  const t = await token();
  if (!t) throw new Error("no OAuth token in keychain");
  return getJson(url, { authorization: `Bearer ${t}`, "anthropic-beta": "oauth-2025-04-20" });
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
  const file = o.lastGoodFile ?? lastGoodPath();
  const lg = readLastGood(file)[ANTHROPIC_NATIVE];
  const base = { provider: ANTHROPIC_NATIVE, kind: "plan" as const, fetchedAt: now };
  const wait = gate.remaining(ANTHROPIC_NATIVE, now);
  if (wait > 0) {
    return staleReading(ANTHROPIC_NATIVE, lg, "http 429", now, undefined, wait) ?? {
      ...base,
      windows: [],
      error: `provider asked us to slow down, next try in ${humanMinutes(wait)}`,
      rateLimited: true,
      retryAfterMs: wait,
    };
  }
  if (lg && lg.windows.length && now - lg.fetchedAt < ANTHROPIC_POLL_MS) return { ...base, windows: lg.windows, fetchedAt: lg.fetchedAt };
  try {
    const windows = parseAnthropicUsage(await (o.fetchUsage ?? (() => fetchAnthropicUsage()))());
    if (!windows.length) throw new Error("no usage windows in response");
    gate.reset(ANTHROPIC_NATIVE);
    writeLastGood(file, { ...readLastGood(file), anthropic: { windows, fetchedAt: now } });
    return { ...base, windows };
  } catch (e) {
    const err = e as Error;
    const limited = err instanceof HttpError && err.status === 429;
    const retry = limited ? gate.penalize(ANTHROPIC_NATIVE, now, (err as HttpError).retryAfterMs) : undefined;
    const stale = staleReading(ANTHROPIC_NATIVE, lg, err.message, now, undefined, retry);
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

/** TCP connect: accepted, refused/reset, or no answer within the timeout (a server too busy to accept is slow, not gone). */
export type TcpProbe = "open" | "refused" | "timeout";

/** TCP connect timeout of the cockpit's local probe; the accept queue of a server at full load is slow.
 *  Shipped fallback only — the live value is `router.cockpit.probe.tcpTimeoutMs`. */
export const TCP_TIMEOUT_MS = 3000;
/** Consecutive probe timeouts after which a local server is shown down; fewer keep the last known state.
 *  Shipped fallback only — the live value is `router.cockpit.probe.timeoutStrikes`. */
export const PROBE_TIMEOUT_STRIKES = 3;

function probeTcp(port: number, host: string, timeoutMs: number = TCP_TIMEOUT_MS): Promise<TcpProbe> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host, timeout: timeoutMs });
    s.on("connect", () => (s.destroy(), resolve("open")));
    s.on("timeout", () => (s.destroy(), resolve("timeout")));
    s.on("error", () => resolve("refused"));
  });
}

/** Why a local server is shown down. */
export type DownReason = "not listening" | "no HTTP answer" | "model not served" | "probe timeout";

/** The probes localLimits runs; replaced in tests. */
export interface LocalProbes {
  tcp: (port: number, host: string) => Promise<TcpProbe>;
  served: (base: URL) => Promise<ServedAnswer>;
}

/** GET /v1/models: `alive` = answered HTTP (any status); `timeout` = connected but no answer in time; `ids` = the models it lists. */
export interface ServedAnswer {
  alive: boolean;
  timeout?: boolean;
  ids?: string[];
}

/** Per provider+endpoint: whether the last settled poll said up, and the run of consecutive timeouts since. */
const probeState = new Map<string, { up: boolean; strikes: number }>();

/** Strata's own prefill/decode reading from GET /metrics; null for any other server or a failed/slow probe (the router's rows are used then). */
async function strataSpeedOf(base: URL, key: string): Promise<EndpointSpeed | null> {
  try {
    return strataSpeed(key, await getJson(new URL("/metrics", base), {}, 2000));
  } catch {
    return null;
  }
}

/** A server busy prefilling answers /v1/cache/stats slowly (7.6 s seen). */
export const PREFIX_STATS_TIMEOUT_MS = 15_000;

/**
 * With `background` the cache-stats request runs in the background and is handed over as a promise, so the
 * up/down result and gauges do not wait for a slow server; without it the reading is awaited.
 */
export async function localLimits(
  name: string,
  p: WorkerProvider,
  rows: UsageRow[],
  now: number,
  background?: (stats: Promise<PrefixCacheStats | undefined>) => void,
  opts: { probes?: LocalProbes; timeoutStrikes?: number; tcpTimeoutMs?: number; listenerRssMb?: (port: number) => Promise<number | undefined>; engineInfo?: (port: number) => Promise<{ engineVersion?: string; engineDir?: string }>; strataSpeed?: (base: URL, key: string) => Promise<EndpointSpeed | null> } = {}
): Promise<ProviderLimits> {
  const u = new URL(p.baseUrl);
  const port = Number(u.port) || 80;
  const probes = opts.probes ?? { tcp: (port, host) => probeTcp(port, host, opts.tcpTimeoutMs ?? TCP_TIMEOUT_MS), served: servedModels };
  const strikesToDown = opts.timeoutStrikes ?? PROBE_TIMEOUT_STRIKES;
  const endpoint = `${u.hostname}:${port}`;
  const stateKey = `${name}@${endpoint}`;
  const prev = probeState.get(stateKey) ?? { up: true, strikes: 0 };
  const tcp = await probes.tcp(port, u.hostname);
  // An accepted TCP connection proves nothing: launchd (or any socket holder) accepts for a server
  // that is not running. Up means the server answers HTTP, and serves this provider's model.
  const probe: ServedAnswer = tcp === "open" ? await probes.served(u) : tcp === "timeout" ? { alive: false, timeout: true } : { alive: false };
  // A busy server may time out without a list: keep the last list it gave, so providers sharing the endpoint do not both turn up
  if (probe.ids) lastServed.set(endpoint, probe.ids);
  else if (!probe.alive && !probe.timeout) lastServed.delete(endpoint);
  const served = probe.ids ?? (probe.alive || probe.timeout ? lastServed.get(endpoint) : undefined);
  let up: boolean;
  let downReason: DownReason | undefined;
  if (probe.timeout) {
    // connected (or slow to accept) but no answer: busy, not down (also with no known state: a fresh router), until it has stayed silent strikesToDown polls in a row
    const strikes = prev.strikes + 1;
    up = prev.up && strikes < strikesToDown;
    if (!up) downReason = "probe timeout";
    probeState.set(stateKey, { up, strikes });
  } else {
    up = probe.alive && serves(served, Object.values(p.models).filter((m): m is string => typeof m === "string"));
    if (!up) downReason = tcp === "refused" ? "not listening" : !probe.alive ? "no HTTP answer" : "model not served";
    probeState.set(stateKey, { up, strikes: 0 });
  }
  let rssMb: number | undefined;
  let prefixCache: PrefixCacheStats | undefined;
  let strata: EndpointSpeed | null = null;
  let engine: { engineVersion?: string; engineDir?: string } = {};
  if (up) {
    rssMb = await (opts.listenerRssMb ?? listenerRssMb)(port);
    engine = await (opts.engineInfo ?? engineInfoOf)(port);
    strata = await (opts.strataSpeed ?? strataSpeedOf)(u, stateKey);
    if (background) background(prefixCacheStats(u, p, name));
    else prefixCache = await prefixCacheStats(u, p, name);
  }
  const speed = strata ?? endpointSpeed(rows, name, now);
  return {
    provider: name,
    kind: "local",
    windows: [],
    up,
    ...(downReason ? { downReason } : {}),
    ...(rssMb ? { rssMb } : {}),
    ...(served ? { served } : {}),
    ...(prefixCache ? { prefixCache } : {}),
    ...engine,
    ...(speed ? { speed } : {}),
    fetchedAt: now,
  };
}

/** `"<name> <version>"` (e.g. "strata 0.1.48-metal"); a bare version line is taken as is. */
export function parseEngineVersion(out: string): string | undefined {
  const line = out.trim().split("\n")[0]?.trim();
  if (!line) return undefined;
  const m = /\s(\S+)$/.exec(line);
  return m ? m[1] : line;
}

/** The engine binary of the process listening on `port`: the first descendant whose command line is "<path> --serve ..." (a Strata engine child); undefined for vllm-mlx / ollama, which run none. */
async function engineBinOf(port: number): Promise<string | undefined> {
  const pid = (await sh("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"])).split("\n")[0];
  if (!pid) return undefined;
  const out = await sh("ps", ["-axo", "pid=,ppid=,command="]);
  if (!out) return undefined;
  const kids = new Map<string, string[]>();
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    kids.set(m[2], [...(kids.get(m[2]) ?? []), `${m[1]} ${m[3]}`]);
  }
  const seen = new Set<string>([pid]);
  const stack = [pid];
  while (stack.length) {
    for (const k of kids.get(stack.pop()!) ?? []) {
      const [cp, cmd] = [k.slice(0, k.indexOf(" ")), k.slice(k.indexOf(" ") + 1)];
      if (seen.has(cp)) continue; // a reparented cycle must not loop forever
      seen.add(cp);
      const exe = /^(\S+) --serve\b/.exec(cmd)?.[1];
      if (exe) return exe;
      stack.push(cp);
    }
  }
  return undefined;
}

/** `<bin> --version` once per binary path+mtime (a rebuild changes the mtime); 3 s, failures read as no version. */
const engineVersionCache = new Map<string, { mtimeMs: number; version?: string }>();

async function engineVersionOf(bin: string): Promise<string | undefined> {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(bin).mtimeMs;
  } catch {
    return undefined;
  }
  const hit = engineVersionCache.get(bin);
  if (hit && hit.mtimeMs === mtimeMs) return hit.version;
  const version = parseEngineVersion(await shTimeout(bin, ["--version"], 3000));
  engineVersionCache.set(bin, { mtimeMs, version });
  return version;
}

/** execFile with a timeout; any failure (missing binary, timeout) is "". */
function shTimeout(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => execFile(cmd, args, { timeout: timeoutMs }, (_e, out) => resolve(String(out ?? "").trim())));
}

/** The engine build line of the server on `port`: version and build dir, empty when it runs no engine binary. */
async function engineInfoOf(port: number): Promise<{ engineVersion?: string; engineDir?: string }> {
  const bin = await engineBinOf(port);
  if (!bin) return {};
  const version = await engineVersionOf(bin);
  const dir = basename(dirname(dirname(bin)));
  return { ...(version ? { engineVersion: version } : {}), ...(dir ? { engineDir: dir } : {}) };
}

/** RSS of the process tree behind the listener on `port`, in MB; undefined when it cannot be read. */
async function listenerRssMb(port: number): Promise<number | undefined> {
  const pid = (await sh("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"])).split("\n")[0];
  // the listener's own RSS is a thin front (Strata's python server ~30 MB);
  // the engine child holds the model (~50 GB) — sum the whole tree
  if (!pid) return undefined;
  const tree = await processTreeRssMb(pid, (c, a) => sh(c, a).then((s) => s || null));
  return tree > 0 ? tree : undefined;
}

/** The last model list each endpoint (host:port) gave, for polls where it answers without one. */
const lastServed = new Map<string, string[]>();

/** GET /v1/models: `alive` = the server answered HTTP at all (any status); `ids` = the models it lists, when it can say. */
async function servedModels(base: URL): Promise<ServedAnswer> {
  try {
    const body = JSON.parse(await getJson(new URL("/v1/models", base), {})) as { data?: Array<{ id?: unknown }> };
    const ids = (body.data ?? []).map((m) => m.id).filter((i): i is string => typeof i === "string");
    return ids.length ? { alive: true, ids } : { alive: true };
  } catch (e) {
    // a busy server may be slow to answer (timeout); one that resets or closes the connection is not serving
    // getJson's timeout rejects with an empty message: treat a message-less error as a timeout too
    if ((e as Error).message === "timeout" || !(e as Error).message) return { alive: false, timeout: true };
    return { alive: e instanceof HttpError };
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

/** The conversation-cache counters in a Strata GET /metrics body (it has no /v1/cache/stats): a request that reused parked tokens is a hit. */
export function parseStrataCacheStats(body: string): PrefixCacheStats | undefined {
  try {
    const c = (JSON.parse(body) as { conversation_cache?: Record<string, unknown> | null }).conversation_cache;
    const requests = num(c?.requests);
    const hits = num(c?.requests_reused);
    if (!c || requests === undefined || hits === undefined) return undefined;
    const slots = num(c.parked);
    const bytes = num(c.bytes);
    return {
      hits,
      misses: Math.max(0, requests - hits),
      hitRate: requests ? hits / requests : 0,
      tokensSaved: num(c.reused_tokens) ?? 0,
      ...(slots !== undefined ? { entries: slots } : {}),
      ...(bytes !== undefined ? { memoryMb: Math.round(bytes / 1048576) } : {}),
    };
  } catch {
    return undefined;
  }
}

async function prefixCacheStats(base: URL, p: WorkerProvider, name: string): Promise<PrefixCacheStats | undefined> {
  let headers: Record<string, string> = {};
  try {
    headers = { authorization: `Bearer ${resolveProviderKey(p)}` };
  } catch {
    /* no key: the endpoint may not need one */
  }
  try {
    const vllm = parsePrefixCacheStats(await getJson(new URL("/v1/cache/stats", base), headers, PREFIX_STATS_TIMEOUT_MS));
    if (vllm) return vllm;
  } catch {
    /* not a vllm-mlx server: try Strata's metrics */
  }
  try {
    const strata = parseStrataCacheStats(await getJson(new URL("/metrics", base), headers, PREFIX_STATS_TIMEOUT_MS));
    if (strata) return strata;
  } catch {
    /* no metrics either */
  }
  // vllm-mlx exposes no counters over HTTP: read the reuse from the server log PAI owns
  return vllmLogCacheStats(name, Number(base.port) || 80);
}

/** Several providers share one port: up only when its model is served. Re-exported from the shared probe (workers/served-models.ts). */
export { serves as modelServed } from "../workers/served-models.js";

/** output tokens / request wall seconds over the last hour, else the last 24 h (successful requests). */
function isLocalUrl(u: string): boolean {
  return isLoopbackUrl(u);
}

/** A kept prefix-cache reading older than this is treated as unknown. */
export const PREFIX_STALE_MS = 10 * 60_000;

export interface LimitsDeps {
  providers: () => Record<string, WorkerProvider>;
  rows: () => UsageRow[];
  advisorFile?: string;
  estimateFile?: string;
  /** Providers a `local:` tier launches (default: workers.yaml); they are local candidates while `enabled: false`. */
  tierProviders?: () => string[];
  /** Last-good store override (tests); defaults to lastGoodPath(). */
  lastGoodFile?: string;
  /** Shared poll gate override (tests); defaults to gateFile(). */
  gate?: Backoff;
  /** Replaces the anthropic keychain + https fetch (tests). */
  fetchAnthropic?: () => Promise<string>;
  /** Local probe policy (router.cockpit.probe); defaults to the shipped values. */
  probe?: { timeoutStrikes?: number; tcpTimeoutMs?: number; listenerRssMb?: (port: number) => Promise<number | undefined>; engineInfo?: (port: number) => Promise<{ engineVersion?: string; engineDir?: string }> };
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
  /** last good prefix-cache reading per local provider: a server busy prefilling answers /v1/cache/stats too late */
  private prefixLastGood = new Map<string, { stats: PrefixCacheStats; at: number }>();

  /** background cache-stats requests still running */
  private pendingPrefix = new Set<Promise<void>>();

  constructor(private readonly deps: LimitsDeps, private readonly ttlMs = 60_000) {
    this.backoff = new Backoff(ttlMs);
    // a restart must not lose the last good reading: it is served with its age until the staleness limit
    for (const [k, v] of Object.entries(readLastGood(this.deps.lastGoodFile ?? lastGoodPath()))) {
      if (v.prefixCache) this.prefixLastGood.set(k, { stats: v.prefixCache, at: v.fetchedAt });
    }
  }

  /** Resolves when the background cache-stats requests of the last poll have finished (tests). */
  prefixSettled = async (): Promise<void> => {
    while (this.pendingPrefix.size) await Promise.all([...this.pendingPrefix]);
  };

  /** A background stats answer: remember it (memory + file) and patch the reading already being served. */
  private prefixArrived(provider: string, stats: PrefixCacheStats | undefined, at: number): void {
    if (!stats) return;
    this.prefixLastGood.set(provider, { stats, at });
    const cur = this.value.find((l) => l.provider === provider && l.kind === "local");
    if (cur?.up) {
      cur.prefixCache = stats;
      delete cur.prefixCacheAgeSec;
    }
    const file = this.deps.lastGoodFile ?? lastGoodPath();
    const store = readLastGood(file);
    store[provider] = { windows: [], fetchedAt: at, prefixCache: stats };
    writeLastGood(file, store);
  }

  private gen = 0;

  /** Drops the cached reading: the next get() polls afresh (a local server was started or stopped). A poll already
   *  in flight started before the change, so its answer is served to its callers but never kept. */
  invalidate(): void {
    this.gen++;
    this.at = -Infinity;
    this.inflight = undefined;
  }

  get(now: number = Date.now()): Promise<ProviderLimits[]> {
    if (this.value.length && now - this.at < this.ttlMs) return Promise.resolve(this.value);
    const gen = this.gen;
    this.inflight ??= this.poll(now).then((v) => {
      if (gen === this.gen) {
        this.value = v;
        this.at = now;
        this.inflight = undefined;
      }
      return v;
    });
    return this.inflight;
  }

  /** Last polled up/down of a local provider; undefined = never polled or not a local server. Refreshes in the background. */
  isUp = (provider: string): boolean | undefined => {
    void this.get().catch(() => undefined);
    return this.value.find((l) => l.provider === provider && l.kind === "local")?.up;
  };

  private keepPrefixCache(r: ProviderLimits, now: number): void {
    if (r.kind !== "local") return;
    if (r.prefixCache) {
      this.prefixLastGood.set(r.provider, { stats: r.prefixCache, at: now });
      return;
    }
    const last = this.prefixLastGood.get(r.provider);
    if (!last || !r.up || now - last.at > PREFIX_STALE_MS) {
      if (last && now - last.at > PREFIX_STALE_MS) this.prefixLastGood.delete(r.provider);
      return;
    }
    r.prefixCache = last.stats;
    r.prefixCacheAgeSec = Math.round((now - last.at) / 1000);
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
    const lastGoodFile = this.deps.lastGoodFile ?? lastGoodPath();
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
        advisorFile: this.deps.advisorFile ?? advisorModeFile(),
        ...(this.deps.fetchAnthropic ? { fetchUsage: this.deps.fetchAnthropic } : {}),
      })
    );
    const tiers = this.deps.tierProviders?.() ?? tierProviderNames();
    for (const [name, p] of Object.entries(providers)) {
      if (p.native || name === ANTHROPIC_NATIVE || !p.baseUrl) continue;
      if (isLocalUrl(p.baseUrl)) {
        if (!isLocalCandidate(p, name, tiers)) continue;
        jobs.push(
          localLimits(name, p, rows, now, (pending) => {
            const done = pending.then((stats) => this.prefixArrived(name, stats, now));
            this.pendingPrefix.add(done);
            void done.finally(() => this.pendingPrefix.delete(done));
          }, this.deps.probe ?? {})
        );
      }
      else if (p.enabled === false) continue;
      else if (p.usage) plan(name, (lg) => providerPlanLimits(name, p, now, lg));
      else if (caps[name]) {
        jobs.push(Promise.resolve({ provider: name, kind: "estimated", windows: estimateWindows(rows, name, caps[name]!, now), fetchedAt: now }));
      }
    }
    const results = await Promise.all(jobs);
    for (const r of results) this.keepPrefixCache(r, now);
    // anthropic keeps its own shared last-good entry and gate (anthropicShared)
    const store = readLastGood(lastGoodFile);
    let dirty = false;
    for (const r of results) {
      if (r.provider === ANTHROPIC_NATIVE) continue;
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
