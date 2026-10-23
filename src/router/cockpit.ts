/**
 * cockpit.ts — aggregation behind the router's /cockpit page. Pure functions
 * over usage rows; the HTTP handler at the bottom only serves them. The page
 * gets numbers and display names, never keys, bodies or prompt content.
 */

import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type http from "node:http";
import type { LimitsCache, ProviderLimits } from "./limits.js";
import { createHash } from "node:crypto";
import { cockpitHtml } from "./cockpit-page.js";
import { resolveFromModule } from "../module-paths.js";
import { expandHome, loadConfig, paiConfigFilePath, readMainConfigRaw } from "../daemon/config.js";
import { deepMergeConfig, shippedMainDefaults } from "../config/shipped-defaults.js";
import { isTimeOrdered, markTimeOrdered, splitBySessionKind, usageLogFile, type SessionKindSplit, type UsageRow } from "./usage.js";
import { defaultSources, drain, jobSessionName, loadSessionMap, loadSessionMapSteps, loadWorkerWindows, loadWorkerWindowsSteps, runSliced, withJobNames, withWorkerAttributionSteps, type SessionInfo, type WorkerWindow } from "./sessions.js";
import { paiHomePath } from "../config/pai-home.js";
import { poolCarry, poolMetricsPath, readPoolMetrics, type PoolCarry } from "../workers/pool.js";
import { weightsBytes } from "./cockpit-weights.js";
import { setProviderCap } from "../workers/providers.js";
import { cockpitLayout } from "./cockpit-layout.js";
import { readWorkersSection, type WorkersConfig, ANTHROPIC_NATIVE, isLocalProvider } from "../workers/config.js";
import { buildsDir, listBuildsSync, ticketKind, waitReason } from "../builds/queue.js";
import { buildSlots, testSlots } from "../builds/config.js";
import { WORKER_ID_RE, ledgerPath, workersLogDir } from "../workers/paths.js";
import { sharedPoolPanel } from "./pool-panel.js";
import { currentInventory, readInventory, readInventoryInput } from "../workers/model-inventory.js";
import { readRuntimeCommands, embeddingRuntimeName } from "../workers/model-runtimes.js";
import { localStartView, readLocalStarts, type LocalStartView } from "../workers/local-start.js";
import { registryModels, type RegistryModel } from "./cockpit-registry-models.js";
import { readLocalConfig, tierButtons, type LocalTier } from "../workers/local-tiers.js";
import { loopbackRefusal, isTailnetOrLocalName } from "../utils/loopback-guard.js";
import { instanceEngineKey, readLiveInstances } from "../workers/local-instances.js";
import { createEndpointHealth, type EndpointHealth } from "../workers/endpoint-health.js";
import { endpointRows, selectorChoices, type EndpointRow } from "./cockpit-endpoints.js";
import { workersYamlPath } from "../workers/workers-config.js";
import { parse as parseYaml } from "yaml";
import { processTreeRssMb } from "../workers/model-inventory.js";
import { readLocalStatus } from "../workers/local-status.js";
import { localTierOrder, pickLocal } from "../workers/local-provider.js";
import { providerCap, queueRows, reorderQueue, reorderQueueTo } from "../workers/capacity.js";
import { ownerSessionName } from "../workers/scope.js";
import { formatWorktreesStats, worktreesStatsCached } from "../workers/worktree.js";
import { getProfile } from "../workers/session-profile-store.js";
import { loadPaneRunStatuses, paneRunRows } from "../workers/pane-run.js";
import { loadPlanStatuses, planRows } from "../workers/plan-status.js";
import { readAudit } from "../workers/pane-audit.js";
import { localIdleLine, readLocalIdle } from "../workers/local-idle.js";
import { readSchedFile, schedPlain, sharedScheduler } from "./scheduler.js";
import { isLive, loadStatus, loadStatusesCached, ownsPidCached, type WorkerStatus } from "../workers/status.js";
import { isLoopbackUrl } from "../utils/loopback.js";
import { buildSpeed, percentile } from "./speed.js";
import { createRuntimeSampler, routerSamplerDeps, type RuntimeSampler } from "./runtime-samples.js";
import { readProfiles } from "../workers/session-profile-store.js";
import { flowText, routeRows, type RouteRow } from "../workers/route-table.js";
import type { BudgetMap } from "../workers/budget.js";
import { paiHomeDir } from "../config/pai-home.js";
import { bodyErrorStatus, readJsonObject } from "./cockpit-body.js";
import { defaultDeps, readCockpitJob, readLabels, runCockpitAction, runningRuntimeJobs, runtimeJobProgress, type ActionDeps, type ActionHooks } from "./cockpit-actions.js";
import type { SystemMonitor } from "./system.js";
import { defaultRegistryCtx, handleRegistryRoute, type RegistryCtx } from "./cockpit-registry.js";
import { SESSION_ID_RE, sessionDetail } from "./session-detail.js";
import { defaultSavedAt, readDefaultLayout, saveDefaultLayout } from "./cockpit-layout-default.js";
import { cockpitMemoryPayload, memoryJobProgress, liveMemoryDeps, type MemoryDeps } from "./cockpit-memory.js";

export type CockpitWindow = "1h" | "24h" | "7d";

export const WINDOWS: Record<CockpitWindow, { span: number; bucket: number }> = {
  "1h": { span: 3_600_000, bucket: 300_000 },
  "24h": { span: 86_400_000, bucket: 3_600_000 },
  "7d": { span: 7 * 86_400_000, bucket: 86_400_000 },
};

const DAY = 86_400_000;
const RETRY_WITHIN_MS = 120_000;

export const PAUSE_BUCKETS = ["<1m", "1-5m", "5-60m", ">60m", "first"] as const;

export function pauseBucket(gapS: number | undefined): (typeof PAUSE_BUCKETS)[number] {
  if (gapS === undefined) return "first";
  if (gapS < 60) return "<1m";
  if (gapS < 300) return "1-5m";
  if (gapS < 3600) return "5-60m";
  return ">60m";
}

export interface Tok {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** Price ratios relative to fresh input (Anthropic); applied to every provider. */
export const TOKEN_WEIGHTS = { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 } as const;

export function weightedTokens(t: Tok): number {
  return t.input * TOKEN_WEIGHTS.input + t.cacheWrite * TOKEN_WEIGHTS.cacheWrite + t.cacheRead * TOKEN_WEIGHTS.cacheRead + t.output * TOKEN_WEIGHTS.output;
}

/** Status strip groups: local = provider served from this machine (kind "local"), everything else is cloud. */
export function groupLimits<T extends { kind: string }>(limits: T[]): { cloud: T[]; local: T[] } {
  return { cloud: limits.filter((l) => l.kind !== "local"), local: limits.filter((l) => l.kind === "local") };
}

/**
 * One key per model however the client spelled it: Claude Code sends
 * "claude-opus-5-5[1m]" for the 1M-context variant, snapshots carry a
 * -YYYYMMDD suffix, gateways a provider prefix. Only claude ids are folded;
 * other providers' ids are theirs and stay as served.
 */
const canonicalMemo = new Map<string, string>();
export function canonicalModel(id: string): string {
  const hit = canonicalMemo.get(id);
  if (hit !== undefined) return hit;
  const m = id.trim().toLowerCase().replace(/^anthropic\//, "");
  const out = !m.startsWith("claude-") ? id : m.replace(/\[[^\]]*\]$/, "").replace(/-(?:latest|\d{8})$/, "");
  // model ids are few; a runaway set of odd ones is not kept
  if (canonicalMemo.size < 5000) canonicalMemo.set(id, out);
  return out;
}

/**
 * Display owner of each model id: the ENABLED provider that serves it, from
 * workers.yaml (`models.*` values, canonical ids). Rows logged before local
 * workers went through the router carry the model id under a resolved
 * duplicate provider (a disabled one), not the provider name the operator
 * knows; this is how they fold into it.
 */
export function modelOwners(providers: Record<string, { enabled?: boolean; models?: Record<string, unknown> }>): Map<string, string> {
  const owners = new Map<string, string>();
  for (const [name, p] of Object.entries(providers)) {
    if (p.enabled === false) continue;
    for (const m of Object.values(p.models ?? {})) {
      if (typeof m === "string" && !owners.has(canonicalModel(m))) owners.set(canonicalModel(m), name);
    }
  }
  return owners;
}

/**
 * One provider key per row, the provider name: a row whose provider is not an
 * enabled one (a disabled duplicate such as the old model-resolved `coder8`)
 * is attributed to the enabled provider that serves its model. Rows of live
 * providers, and models nobody serves, stay as logged.
 */
export function foldProviders(rows: UsageRow[], providers: Record<string, { enabled?: boolean }>, owners: Map<string, string>): UsageRow[] {
  if (!owners.size) return rows;
  const live = (name: string) => name === ANTHROPIC_NATIVE || providers[name]?.enabled !== false && name in providers;
  return rows.map((r) => {
    if (live(r.provider)) return r;
    const owner = owners.get(canonicalModel(r.model));
    return owner && owner !== r.provider ? { ...r, provider: owner } : r;
  });
}

/**
 * The ecosystem a provider belongs to: "local" for a provider served from this machine (every local tier),
 * otherwise the provider name itself (anthropic, glm, kimi, ...). The provider is the grouping, no config key.
 */
export function providerEcosystem(provider: string, providers: Record<string, { baseUrl?: string }>): string {
  return isLocalProvider(providers[provider]?.baseUrl ?? "") ? "local" : provider;
}

const tok = (): Tok => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
const addTok = (t: Tok, r: UsageRow) => {
  t.input += r.input_tokens ?? 0;
  t.output += r.output_tokens ?? 0;
  t.cacheWrite += r.cache_creation_input_tokens ?? 0;
  t.cacheRead += r.cache_read_input_tokens ?? 0;
};
const hitRatio = (t: Tok) => {
  const d = t.cacheRead + t.cacheWrite + t.input;
  return d ? t.cacheRead / d : 0;
};

export function bucketStart(ts: number, bucket: number): number {
  return Math.floor(ts / bucket) * bucket;
}

/** Row indexes (in the given list) that are retries: same session, within 2 min of a failed request. */
export function retryRows(rows: UsageRow[]): Set<UsageRow> {
  const out = new Set<UsageRow>();
  const lastFail = new Map<string, number>();
  const sorted = [...rows].sort((a, b) => a.ts.localeCompare(b.ts));
  for (const r of sorted) {
    const key = r.session_id ?? r.session;
    if (!key) continue;
    const t = Date.parse(r.ts);
    const f = lastFail.get(key);
    if (f !== undefined && t - f <= RETRY_WITHIN_MS) out.add(r);
    if (r.status >= 400) lastFail.set(key, t);
    else lastFail.delete(key);
  }
  return out;
}

/** Local-server readings of a provider that is disabled and not launched by a tier (or no longer configured) are dropped, like the models inventory does. */
export function enabledLocalLimits(ls: ProviderLimits[], providers: Record<string, { enabled?: boolean }>, tierProviders: string[] = tierProviderList()): ProviderLimits[] {
  if (!Object.keys(providers).length) return ls;
  return ls.filter((l) => l.kind !== "local" || (l.provider in providers && (providers[l.provider]!.enabled !== false || tierProviders.includes(l.provider))));
}

function configuredProviders(): Record<string, { enabled?: boolean; baseUrl?: string; models?: Record<string, unknown> }> {
  try {
    return readWorkersSection().workers.providers;
  } catch {
    return {};
  }
}

/** workers.yaml `local:` — the preferred (active) local provider; only that one is "down" when its port is silent. */
function configuredLocal(): string | null {
  try {
    const doc = parseYaml(readFileSync(workersYamlPath(), "utf8")) as { local?: unknown } | null;
    return typeof doc?.local === "string" && doc.local ? doc.local : null;
  } catch {
    return null;
  }
}

/** Every local tier provider whose server answers: the set of running models, in limits order. */
export function runningLocalProviders(l: ProviderLimits[], tierProviders: string[] = tierProviderList()): string[] {
  return l.filter((x) => x.kind === "local" && x.up === true && tierProviders.includes(x.provider)).map((x) => x.provider);
}

/** The first running local provider (what the page's single "active" reads); when none answers, the configured `local:` one, which is then the one that is down. */
export function activeLocalProvider(l: ProviderLimits[], tierProviders: string[] = tierProviderList()): string | null {
  return runningLocalProviders(l, tierProviders)[0] ?? configuredLocal();
}

function tierProviderList(): string[] {
  try {
    return Object.values(readLocalConfig(workersYamlPath()).tiers).map((t) => t.provider);
  } catch {
    return [];
  }
}

type WholeLog = { days: number[]; daily: Record<string, number[]>; promptByProvider: Record<string, number>; promptSince: Record<string, string>; speed: ReturnType<typeof buildSpeed> };
const WHOLE_LOG_TTL_MS = 30_000;
const wholeLogMemo = new WeakMap<UsageRow[], { n: number; at: number; sig: string; out: WholeLog }>();

/** Whole-log figures, folded row by row as the log is read so the rows themselves can be dropped once they are older than any window. */
class LogAgg {
  /** per provider+model: requests, prompt tokens, first ts (a fold by model owner is applied on top at read time) */
  readonly pairs = new Map<string, { provider: string; model: string; n: number; prompt: number; since: string }>();
  /** tokens per UTC day per model, with the sequence number of the model's first row that day (keeps the model order of a row scan) */
  readonly daily = new Map<number, Map<string, { sum: number; seq: number }>>();
  private seq = 0;

  add(r: UsageRow): void {
    const model = typeof r.model === "string" ? canonicalModel(r.model) : "";
    const k = `${r.provider}\u0000${model}`;
    const p = this.pairs.get(k) ?? { provider: r.provider, model, n: 0, prompt: 0, since: r.ts };
    p.n++;
    p.prompt += (r.input_tokens ?? 0) + (r.cache_read_input_tokens ?? 0) + (r.cache_creation_input_tokens ?? 0);
    if (r.ts < p.since) p.since = r.ts;
    this.pairs.set(k, p);
    const day = bucketStart(Date.parse(r.ts), DAY);
    const d = this.daily.get(day) ?? new Map<string, { sum: number; seq: number }>();
    const e = d.get(model) ?? { sum: 0, seq: this.seq };
    e.sum += (r.input_tokens ?? 0) + (r.output_tokens ?? 0) + (r.cache_creation_input_tokens ?? 0) + (r.cache_read_input_tokens ?? 0);
    d.set(model, e);
    this.daily.set(day, d);
    this.seq++;
  }

  /** Forget the day buckets before `cut`: no window looks back further than the 14 days the daily chart shows. */
  pruneDaily(cut: number): void {
    for (const day of this.daily.keys()) if (day < cut) this.daily.delete(day);
  }

  /** The pairs as the fold of the providers would have rewritten their rows. */
  folded(providers: Record<string, { enabled?: boolean }>): Array<{ provider: string; model: string; n: number; prompt: number; since: string }> {
    const owners = modelOwners(providers as Parameters<typeof modelOwners>[0]);
    const all = [...this.pairs.values()];
    return owners.size ? (foldProviders(all as unknown as UsageRow[], providers, owners) as unknown as typeof all) : all;
  }
}

const aggs = new WeakMap<UsageRow[], LogAgg>();

/** The aggregates a cached log carries; a plain array (tests, callers that bring their own rows) is scanned. */
function aggOf(rows: UsageRow[]): LogAgg {
  const have = aggs.get(rows);
  if (have) return have;
  const a = new LogAgg();
  for (const r of rows) a.add(r);
  return a;
}

/** The parts of the cockpit payload that read the whole log whatever the window is. Costly on a big log, so they are kept per log array until it grows or 30 s pass (the speed table moves with the clock). */
function wholeLog(allRows: UsageRow[], agg: LogAgg, now: number, providers: Record<string, { enabled?: boolean; baseUrl?: string }>): WholeLog {
  const sig = JSON.stringify(Object.entries(providers).map(([k, v]) => [k, v.baseUrl]));
  const m = wholeLogMemo.get(allRows);
  if (m && m.n === allRows.length && m.sig === sig && Math.abs(now - m.at) < WHOLE_LOG_TTL_MS) return m.out;
  // tokens per day per model: always the last 14 days, whatever the window
  const dayFrom = bucketStart(now, DAY) - 13 * DAY;
  const days: number[] = [];
  for (let t = dayFrom; t <= now; t += DAY) days.push(t);
  const daily = dict<number[]>();
  const inRange: Array<{ day: number; model: string; sum: number; seq: number }> = [];
  for (const [day, ms] of agg.daily) {
    if (day < dayFrom) continue;
    for (const [model, e] of ms) inRange.push({ day, model, ...e });
  }
  inRange.sort((a, b) => a.seq - b.seq);
  for (const e of inRange) {
    const arr = (daily[e.model] ??= days.map(() => 0));
    arr[Math.floor((e.day - dayFrom) / DAY)]! += e.sum;
  }

  // prompt tokens per provider over the whole log: denominator for the local
  // servers' tokensSaved counter, which the stats endpoint gives no total for
  const promptByProvider = dict<number>();
  // first row per provider: the log (router restart) is younger than a server's own counters
  const promptSince = dict<string>();
  for (const p of agg.folded(providers)) {
    if (!promptSince[p.provider] || p.since < promptSince[p.provider]!) promptSince[p.provider] = p.since;
    promptByProvider[p.provider] = (promptByProvider[p.provider] ?? 0) + p.prompt;
  }

  const out = { days, daily, promptByProvider, promptSince, speed: buildSpeed(allRows, now, canonicalModel, (p) => isLoopbackUrl(providers[p]?.baseUrl ?? "")) };
  wholeLogMemo.set(allRows, { n: allRows.length, at: now, sig, out });
  return out;
}

/** Folded rows per source array: the fold of the rows seen so far, extended by the ones appended since. */
const foldMemo = new WeakMap<UsageRow[], { sig: string; n: number; out: UsageRow[] }>();

function foldedRows(allRows: UsageRow[], providers: Record<string, { enabled?: boolean }>): UsageRow[] {
  const owners = modelOwners(providers as Parameters<typeof modelOwners>[0]);
  if (!owners.size) return allRows;
  const sig = JSON.stringify([Object.entries(providers).map(([k, v]) => [k, v.enabled]), [...owners]]);
  const m = foldMemo.get(allRows);
  if (m && m.sig === sig && m.n <= allRows.length) {
    if (m.n < allRows.length) {
      for (const r of foldProviders(allRows.slice(m.n), providers, owners)) m.out.push(r);
      m.n = allRows.length;
    }
    return m.out;
  }
  const out = foldProviders(allRows, providers, owners);
  foldMemo.set(allRows, { sig, n: allRows.length, out });
  if (isTimeOrdered(allRows)) markTimeOrdered(out);
  return out;
}

/** The rows at or after `from`. A log known to be in time order is scanned from the tail, stopping at the first older row. */
function windowRows(allRows: UsageRow[], from: number): UsageRow[] {
  if (!isTimeOrdered(allRows)) return allRows.filter((r) => Date.parse(r.ts) >= from);
  let i = allRows.length;
  while (i > 0 && Date.parse(allRows[i - 1]!.ts) >= from) i--;
  return allRows.slice(i);
}

export function buildCockpitData(
  allRows: UsageRow[],
  win: CockpitWindow,
  now: number = Date.now(),
  sessions: Map<string, SessionInfo> = new Map(),
  pool: PoolCarry | null = null,
  providers: Record<string, { enabled?: boolean; baseUrl?: string; models?: Record<string, unknown> }> = {}
) {
  const { span, bucket } = WINDOWS[win];
  const from = bucketStart(now - span, bucket);
  const agg = aggOf(allRows);
  allRows = foldedRows(allRows, providers);
  const rows = windowRows(allRows, from);
  const retries = retryRows(rows);

  // ecosystem per model: that of the provider serving most of its requests over the whole log
  const ecoCount = new Map<string, Map<string, number>>();
  for (const r of agg.folded(providers)) {
    const c = ecoCount.get(r.model) ?? new Map<string, number>();
    const e = providerEcosystem(r.provider, providers);
    c.set(e, (c.get(e) ?? 0) + r.n);
    ecoCount.set(r.model, c);
  }
  const ecosystems = dict<string>();
  for (const [m, c] of ecoCount) ecosystems[m] = [...c.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];

  // series: one entry per bucket, per model token parts
  const series: Array<{ t: number; models: Record<string, Tok & { requests: number }> }> = [];
  for (let t = from; t <= now; t += bucket) series.push({ t, models: dict() });
  const total = tok();
  let errors = 0;
  const byModel = new Map<string, Tok & { model: string; provider: string; requests: number; errors: number }>();
  const byProvider = new Map<string, Tok & { provider: string; requests: number; errors: number; retries: number; ms: number }>();
  const ttftByProvider = new Map<string, number[]>();
  /** per copy of a local model: provider\0instance -> counts (tooltip of the provider aggregate) */
  const byInstance = new Map<string, Tok & { provider: string; instance: string; requests: number; errors: number; ms: number }>();
  const bySession = new Map<string, Tok & { session: string; name: string | null; requests: number; errors: number; busts: number; lastTs: string; models: Set<string> }>();
  const pause = new Map<string, Map<string, { n: number; hit: number; write: number; miss: number; readTok: number; writeTok: number }>>();
  const bustParts = dict<number>();

  for (const r of rows) {
    const model = canonicalModel(r.model);
    const t = Date.parse(r.ts);
    addTok(total, r);
    const isErr = r.status >= 400;
    if (isErr) errors++;

    const b = series[Math.floor((bucketStart(t, bucket) - from) / bucket)];
    if (b) {
      const m = (b.models[model] ??= { ...tok(), requests: 0 });
      addTok(m, r);
      m.requests++;
    }

    const mk = `${r.provider}\u0000${model}`;
    const m = byModel.get(mk) ?? { ...tok(), model, provider: r.provider, requests: 0, errors: 0 };
    addTok(m, r);
    m.requests++;
    if (isErr) m.errors++;
    byModel.set(mk, m);

    const p = byProvider.get(r.provider) ?? { ...tok(), provider: r.provider, requests: 0, errors: 0, retries: 0, ms: 0 };
    addTok(p, r);
    p.requests++;
    p.ms += r.ms ?? 0;
    if (isErr) p.errors++;
    if (retries.has(r)) p.retries++;
    byProvider.set(r.provider, p);
    if (r.instance) {
      const ik = `${r.provider}\u0000${r.instance}`;
      const i = byInstance.get(ik) ?? { ...tok(), provider: r.provider, instance: r.instance, requests: 0, errors: 0, ms: 0 };
      addTok(i, r);
      i.requests++;
      i.ms += r.ms ?? 0;
      if (isErr) i.errors++;
      byInstance.set(ik, i);
    }
    if (!isErr && r.ttftMs !== undefined) {
      const ts = ttftByProvider.get(r.provider) ?? [];
      ts.push(r.ttftMs);
      ttftByProvider.set(r.provider, ts);
    }

    const sid = r.session_id ?? r.session ?? "-";
    const s = bySession.get(sid) ?? {
      ...tok(), session: sid, name: r.session_id ? (sessions.get(r.session_id)?.name ?? null) : null,
      requests: 0, errors: 0, busts: 0, lastTs: r.ts, models: new Set<string>(),
    };
    addTok(s, r);
    s.requests++;
    if (isErr) s.errors++;
    if (r.bust?.length) {
      s.busts++;
      for (const part of r.bust) bustParts[part] = (bustParts[part] ?? 0) + 1;
    }
    if (r.ts > s.lastTs) s.lastTs = r.ts;
    s.models.add(model);
    bySession.set(sid, s);

    if (r.status < 400) {
      const pm = pause.get(model) ?? new Map();
      const pb = pauseBucket(r.gap_s);
      const c = pm.get(pb) ?? { n: 0, hit: 0, write: 0, miss: 0, readTok: 0, writeTok: 0 };
      c.n++;
      c[r.cache]++;
      c.readTok += r.cache_read_input_tokens ?? 0;
      c.writeTok += r.cache_creation_input_tokens ?? 0;
      pm.set(pb, c);
      pause.set(model, pm);
    }
  }

  const sessionRows = [...bySession.values()]
    .map((s) => {
      const info = sessions.get(s.session);
      return {
        ...s,
        models: [...s.models],
        hitRatio: hitRatio(s),
        worker: info?.worker ?? null,
        verdict: info?.verdict ?? null,
        workerProvider: info?.provider ?? null,
        workerParent: info?.parent ?? (info?.spawner ? (sessions.get(info.spawner)?.name ?? info.spawner.slice(0, 8)) : null),
        workerStart: info?.startMs ?? null,
        workerEnd: info?.endMs ?? null,
        workerFindings: info?.findings ?? null,
      };
    })
    .sort((a, b) => b.input + b.output + b.cacheWrite + b.cacheRead - (a.input + a.output + a.cacheWrite + a.cacheRead));

  const { daily, days, promptByProvider, promptSince, speed } = wholeLog(allRows, agg, now, providers);

  const withRatio = <T extends Tok>(x: T) => ({ ...x, hitRatio: hitRatio(x) });
  const sessionSplit: SessionKindSplit = splitBySessionKind(rows);
  return {
    window: win,
    bucketMs: bucket,
    weights: TOKEN_WEIGHTS,
    from,
    now,
    totals: { ...withRatio(total), requests: rows.length, errors },
    series,
    ecosystems,
    byModel: [...byModel.values()].map(withRatio).sort((a, b) => b.requests - a.requests),
    byProvider: [...byProvider.values()].map((p) => ({ ...withRatio(p), avgMs: p.requests ? Math.round(p.ms / p.requests) : 0, ttftP50: percentile(ttftByProvider.get(p.provider) ?? [], 0.5), instances: [...byInstance.values()].filter((i) => i.provider === p.provider).sort((a, b) => a.instance.localeCompare(b.instance, undefined, { numeric: true })).map((i) => ({ ...withRatio(i), avgMs: i.requests ? Math.round(i.ms / i.requests) : 0 })) })),
    bySession: sessionRows,
    cachePause: [...pause.entries()].map(([model, pm]) => ({
      model,
      buckets: PAUSE_BUCKETS.map((label) => ({ label, ...(pm.get(label) ?? { n: 0, hit: 0, write: 0, miss: 0, readTok: 0, writeTok: 0 }) })),
    })),
    bustParts,
    speed,
    promptByProvider,
    promptSince,
    workers: sessionRows.filter((s) => s.worker),
    daily: { days, models: daily },
    // continuous vs one-shot sessions: the overall ratio alone averages a
    // cache-carrying population and a cold-spawn population into one number
    // that predicts neither
    sessionSplit,
    // the worker session pool's carry-over: tasks served pooled and the
    // cache_read tokens their first requests were spared (null = no pool)
    pool: pool && pool.tasks > 0 ? pool : null,
  };
}

const USAGE_HEAD_BYTES = 4096;

/** A map keyed by logged names (model, provider): no prototype, so a key such as "__proto__" is an ordinary entry. */
const dict = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

/**
 * The usage log as rows, kept in memory: a log that only grew is read from where the last read
 * stopped (the router appends a row per request, so a full reread of tens of MB on every append
 * would block the event loop); one that shrank or was replaced is read again from the start.
 * The whole-log figures (prompt tokens and first ts per provider, requests per provider+model,
 * tokens per day) are folded into running aggregates as rows are read; the rows themselves are
 * kept for ROWS_KEPT_MS only (the 7 d window reaches back 8 d at most, one day of slack on top)
 * and dropped once a day, so memory follows the window, not the log.
 */
const ROWS_KEPT_MS = 9 * DAY;
const DAILY_KEPT_MS = 15 * DAY;

export function cachedRows(file: string = usageLogFile(), clock: () => number = Date.now): () => UsageRow[] {
  let rows: UsageRow[] = [];
  let agg = new LogAgg();
  let lastTrim = 0;
  let ordered = true;
  let offset = 0;
  let mtimeMs = 0;
  let ino = -1;
  let head = "";
  let lastMs = 0;
  const fresh = (kept: UsageRow[]) => {
    rows = kept;
    if (ordered) markTimeOrdered(rows);
    aggs.set(rows, agg);
  };
  const reset = () => {
    ordered = true;
    agg = new LogAgg();
    lastTrim = clock();
    fresh([]);
    offset = 0;
    ino = -1;
    head = "";
    lastMs = 0;
    mtimeMs = 0;
  };
  reset();
  return () => {
    try {
      const fd = openSync(file, "r");
      try {
        const st = fstatSync(fd);
        const headLen = Math.min(USAGE_HEAD_BYTES, st.size);
        const headBuf = Buffer.alloc(headLen);
        readSync(fd, headBuf, 0, headLen, 0);
        const nowHead = headBuf.toString("latin1");
        // replaced or rotated: another inode, a shorter file, or a head that is not a prefix of the cached one
        if (offset > 0 && (st.ino !== ino || st.size < offset || !nowHead.startsWith(head))) reset();
        if (st.size === offset && st.mtimeMs === mtimeMs) return rows;
        const buf = Buffer.alloc(st.size - offset);
        const n = readSync(fd, buf, 0, buf.length, offset);
        let chunk = buf.subarray(0, n);
        const nl = chunk.lastIndexOf(10); // a torn last line waits for its newline
        chunk = nl < 0 ? chunk.subarray(0, 0) : chunk.subarray(0, nl + 1);
        const from = rows.length;
        // appended in place, so the memos keyed by the array keep their identity
        for (const l of chunk.toString("utf8").split("\n")) {
          if (!l) continue;
          try {
            const r = JSON.parse(l) as UsageRow;
            agg.add(r);
            rows.push(r);
          } catch {
            /* skip torn line */
          }
        }
        for (let i = from; i < rows.length; i++) {
          const t = Date.parse(rows[i]!.ts);
          if (t < lastMs) ordered = false;
          else if (t >= 0) lastMs = t;
        }
        if (!ordered) fresh([...rows]); // a new, unmarked array: the order-dependent scans fall back to a filter
        const at = clock();
        if (at - lastTrim >= DAY) {
          // a new array: the memos keyed by the old one rebuild once a day
          lastTrim = at;
          agg.pruneDaily(bucketStart(at, DAY) - DAILY_KEPT_MS);
          fresh(rows.filter((r) => !(Date.parse(r.ts) < at - ROWS_KEPT_MS)));
        }
        offset += chunk.length;
        ino = st.ino;
        if (head.length < USAGE_HEAD_BYTES) head = nowHead.slice(0, Math.min(offset, USAGE_HEAD_BYTES));
        mtimeMs = st.mtimeMs;
      } finally {
        closeSync(fd);
      }
    } catch {
      reset();
    }
    return rows;
  };
}

/**
 * A value rebuilt at most every `ttlMs`. The first call builds it in place; after that an expired
 * value is returned as it is while the rebuild runs in slices between other requests, so a refresh
 * that walks thousands of status files never holds the event loop (the router proxies model traffic).
 */
function refreshedInSlices<T>(ttlMs: number, steps: () => Generator<void, T>): () => T {
  let at = 0;
  let value: { v: T } | undefined;
  let building = false;
  return () => {
    if (!value) {
      value = { v: drain(steps()) };
      at = Date.now();
    } else if (Date.now() - at > ttlMs && !building) {
      building = true;
      runSliced(steps())
        .then((v) => {
          value = { v };
          at = Date.now();
        })
        .catch(() => {
          /* the old value stands until the next try */
        })
        .finally(() => {
          building = false;
        });
    }
    return value.v;
  };
}

/** Session map reloaded at most every 30 s (status files are many). */
export function cachedSessionMap(ttlMs = 30_000): () => Map<string, SessionInfo> {
  return refreshedInSlices(ttlMs, () => loadSessionMapSteps());
}

/** Worker run windows reloaded at most every 60 s (same status files, one pass). */
export function cachedWorkerWindows(ttlMs = 60_000): () => WorkerWindow[] {
  return refreshedInSlices(ttlMs, () => loadWorkerWindowsSteps());
}

/**
 * Session names for the cockpit: the exact map plus one-shot ids attributed
 * to their worker run window. The exact map is cached; attribution itself is
 * cheap (unknown ids in the window only) and runs per request against the
 * rows being rendered.
 */
const NAMED_TTL_MS = 30_000;
const namedMemo = new WeakMap<object, { at: number; map: Map<string, SessionInfo>; building: boolean }>();

/**
 * Attributing every usage row to a worker window walks all rows against all windows (hundreds
 * of ms on a big log), so the result is reused for as long as the session map it builds on lives;
 * once it is old, the previous result is served while the next one is built in slices.
 */
function namedSessionMap(rows: UsageRow[], sessionMap: () => Map<string, SessionInfo>, workerWindows: () => WorkerWindow[]): Map<string, SessionInfo> {
  const hit = namedMemo.get(sessionMap);
  const steps = function* (): Generator<void, Map<string, SessionInfo>> {
    const attributed = yield* withWorkerAttributionSteps(sessionMap(), rows, workerWindows());
    return withJobNames(attributed, rows.map((r) => r.session_id));
  };
  if (!hit) {
    const map = drain(steps());
    namedMemo.set(sessionMap, { at: Date.now(), map, building: false });
    return map;
  }
  if (Date.now() - hit.at >= NAMED_TTL_MS && !hit.building) {
    hit.building = true;
    runSliced(steps())
      .then((map) => {
        hit.map = map;
        hit.at = Date.now();
      })
      .catch(() => {
        /* the old names stand until the next try */
      })
      .finally(() => {
        hit.building = false;
      });
  }
  return hit.map;
}

/** Builds the caches the first /cockpit/data would build, so a router warms them before it takes traffic. */
export function warmCockpit(readRows: () => UsageRow[], sessionMap: () => Map<string, SessionInfo>, workerWindows: () => WorkerWindow[]): void {
  try {
    namedSessionMap(readRows(), sessionMap, workerWindows);
  } catch {
    /* a failed warm-up: the first request builds them */
  }
}

export function parseWindow(q: string | null): CockpitWindow {
  return q === "24h" || q === "7d" ? q : "1h";
}

/** Anything with a cached provider poll; LimitsCache in production, stubs in tests. */
export type LimitsSource = Pick<LimitsCache, "get">;

/** The action deps + local-job runner the router command installs; tests install their own. */
let actionHooks: ActionHooks = {};
let actionDepsOverride: Partial<ActionDeps> | null = null;
/** Registry editor paths (tests install a temp-dir ctx); default the live workers.yaml. */
let registryCtxOverride: RegistryCtx | null = null;
export function setRegistryCtxForTest(ctx: RegistryCtx | null): void {
  registryCtxOverride = ctx;
}
function registryCtx(): RegistryCtx {
  if (registryCtxOverride) return registryCtxOverride;
  const yamlPath = workersYamlPath();
  const logDir = registryLogDir(yamlPath);
  return defaultRegistryCtx(yamlPath, ledgerPath(logDir), logDir);
}
/** The log dir comes from the merged config (~30 ms to read): remembered until one of the files it is read from changes. */
let registryLogDirMemo: { key: string; dir: string } | null = null;
function registryLogDir(yamlPath: string): string {
  const mt = (p: string): number => {
    try {
      return statSync(p).mtimeMs;
    } catch {
      return 0;
    }
  };
  const cfg = paiConfigFilePath();
  const key = `${cfg}:${mt(cfg)}:${yamlPath}:${mt(yamlPath)}`;
  if (registryLogDirMemo?.key !== key) registryLogDirMemo = { key, dir: workersLogDir(readWorkersSection().workers) };
  return registryLogDirMemo.dir;
}

export function setActionHooks(hooks: ActionHooks, deps?: Partial<ActionDeps>): void {
  actionHooks = hooks;
  actionDepsOverride = deps ?? null;
}

/**
 * Same-origin check for the write actions: a browser sends `Origin` on every
 * cross-origin POST and `Sec-Fetch-Site: cross-site` in modern browsers; a
 * same-origin POST carries Origin equal to the Host (or none, e.g. curl).
 * A mismatch is refused — the cockpit is reachable over Tailscale.
 */
export function sameOriginAction(req: http.IncomingMessage): boolean {
  return loopbackRefusal(req, { allowHost: isTailnetOrLocalName }) === null;
}

/** Memory section sources (daemon status, run marker); tests install fakes. */
let memoryDepsOverride: Partial<MemoryDeps> | null = null;

export function setMemoryDeps(deps: Partial<MemoryDeps> | null): void {
  memoryDepsOverride = deps;
}

/** The process-wide runtime sampler the router command installs; tests install their own. */
let runtimeSampler: RuntimeSampler | null = null;

export function setRuntimeSampler(s: RuntimeSampler | null): void {
  runtimeSampler = s;
}

/**
 * The /cockpit/models payload: the inventory plus each running runtime's live
 * view and ring history (runtime-samples.ts). Without an installed sampler the
 * payload is the bare inventory — the page then shows "–" everywhere live.
 */
export async function cockpitModelsPayload(): Promise<unknown> {
  const inv = await currentInventory();
  const labels = actionLabels();
  const withLabels = {
    ...inv,
    runtimes: inv.runtimes.map((r) => ({ ...r, ...(r.tier || tierAtPort(r.port) === undefined ? {} : { tier: tierAtPort(r.port) }), label: labels?.[r.name] ?? "", modelLabels: labels?.[`${r.name}.`] ?? {} })),
    tiers: localTierNames(),
    instances: localInstanceRows(),
    registryModels: registryModelsNow(),
    running: (await localRunningInfo())[0] ?? null,
    runningModels: await localRunningInfo(),
    localDefaultTier: await localDefaultTier(),
    starting: currentStart(),
    // the configured start/stop commands per runtime (models.runtimes) and what PAI itself uses
    runtimeCommands: runtimeCommandsFor(),
    consumers: consumersFor(),
    // running start/stop jobs per runtime: a reloaded page shows the card busy and resumes watching
    runtimeJobs: runtimeJobsFor(),
  };
  if (!runtimeSampler) return withLabels;
  const live = await runtimeSampler.payload();
  // a sampler that is installed but does not answer: the live readings are missing for now
  if (!live) return { ...withLabels, transient: "live sampler not answering" };
  return { ...withLabels, live };
}

/** Every registry model with its live instances, stopped ones included (the model cards). */
function registryModelsNow(): RegistryModel[] {
  try {
    const providers = readWorkersSection().workers.providers;
    const { concurrencyMin, concurrencyMax } = cockpitLayout();
    const cfg = readLocalConfig(workersYamlPath());
    return registryModels(cfg, localInstanceRows(), weightsBytes, (t) => providers[t.provider]?.maxConcurrent).map((m) => {
      const provider = cfg.tiers[m.tier]?.provider;
      const p = provider ? providers[provider] : undefined;
      if (m.maxConcurrent === undefined || !provider || !p) return m;
      return { ...m, provider, ...(p.conversationSlots !== undefined ? { slots: p.conversationSlots } : {}), capMin: concurrencyMin, capMax: concurrencyMax };
    });
  } catch {
    return [];
  }
}

function runtimeJobsFor(): ReturnType<typeof runningRuntimeJobs> {
  const home = actionDepsOverride?.home ?? paiHomeDir();
  return home ? runningRuntimeJobs(home) : {};
}

/** The configured runtime commands (models.runtimes); {} when nothing is configured. */
function runtimeCommandsFor(): Record<string, { start?: string; stop?: string; note?: string }> {
  try {
    return readRuntimeCommands();
  } catch {
    return {};
  }
}

/** Title of PAI's own embedding consumer: models.embeddingLabel, user config over the shipped default. */
function embeddingLabel(): string | undefined {
  try {
    const m = deepMergeConfig(shippedMainDefaults(), readMainConfigRaw()).models as { embeddingLabel?: unknown } | undefined;
    return typeof m?.embeddingLabel === "string" && m.embeddingLabel ? m.embeddingLabel : undefined;
  } catch {
    return undefined;
  }
}

/** What PAI itself uses: the embedding consumer (name, runtime, what it needs it for). */
function consumersFor(): Array<{ name: string; runtime: string; purpose: string; label?: string; model?: string }> {
  const out: Array<{ name: string; runtime: string; purpose: string; label?: string; model?: string }> = [];
  try {
    const input = readInventoryInput();
    // PAI's own embedding consumer: purpose as the card label
    const emb = input.embedding;
    out.push({
      name: "pai-embedding",
      runtime: embeddingRuntimeName(),
      purpose: emb.backend === "ollama-f16" ? "memory search embeds new content here" : "memory search embeds in-process",
      label: embeddingLabel(),
      model: emb.backend === "ollama-f16" ? emb.model : emb.inProcessModel,
    });
    // the consumers declared in config.yaml (models.consumers), label included
    for (const c of input.consumers) {
      out.push({ name: c.name, runtime: c.runtime, purpose: c.label ?? c.name, label: c.label, model: c.model });
    }
  } catch {
    /* no config: the page shows only the inventory's users */
  }
  return out;
}

/** The local starts in flight (loading) or failed, one view per instance, from the records startInstance keeps; empty when none. */
function currentStarts(): LocalStartView[] {
  try {
    return Object.values(readLocalStarts(workersLogDir(readWorkersSection().workers)))
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((s) => localStartView(s)!);
  } catch {
    return [];
  }
}

/** The single-slot view of the starts (the most recent), for payload fields the page reads as one. */
function currentStart(): LocalStartView | null {
  const all = currentStarts();
  return all[all.length - 1] ?? null;
}

/**
 * A local limit carries the start of its own provider: a down one the first start (loading / failed),
 * an up one only a further instance (#2..) still loading, so scaling up shows on a running model.
 */
export function withStarting(ls: ProviderLimits[], views: LocalStartView | LocalStartView[] | null = currentStarts()): Array<ProviderLimits & { starting?: LocalStartView }> {
  const list = views === null ? [] : Array.isArray(views) ? views : [views];
  if (!list.length) return ls;
  return ls.map((l) => {
    if (l.kind !== "local") return l;
    const own = list.filter((v) => v.provider === l.provider);
    const v = l.up === false ? own[0] : own.find((x) => x.id && !x.id.endsWith("#1"));
    return v ? { ...l, starting: v } : l;
  });
}

/** Local entries carry the weight size on disk of their tier's model (`weightsBytes`), so a card can set the resident memory against it. */
export function withWeights<T extends ProviderLimits>(ls: T[], sizeOf: (t: LocalTier) => number | undefined = weightsBytes): T[] {
  let tiers: LocalTier[];
  try {
    tiers = Object.values(readLocalConfig(workersYamlPath()).tiers);
  } catch {
    return ls;
  }
  return ls.map((l) => {
    if (l.kind !== "local") return l;
    const t = tiers.find((x) => x.provider === l.provider);
    const bytes = t ? sizeOf(t) : undefined;
    return bytes !== undefined ? { ...l, weightsBytes: bytes } : l;
  });
}

/** One managed instance on a local limits entry: its own port, pid, resident memory and in-flight count. */
export interface LimitInstance { id: string; port: number; pid?: number; state: string; inflight: number; rssMb?: number }

/** Local entries carry their managed instances (`instances`), each with the resident memory of its own pid tree, so a card lists and stops them one by one. */
export async function withInstances<T extends ProviderLimits>(
  ls: T[],
  rows: Array<{ id: string; model: string; port: number; pid?: number; state: string; inflight: number }> = localInstanceRows(),
  rssOf: (pid: number) => Promise<number | undefined> = async (pid) => ((await processTreeRssMb(String(pid))) || undefined),
  providerOf: (model: string) => string | undefined = (m) => {
    try {
      return readLocalConfig(workersYamlPath()).tiers[m]?.provider;
    } catch {
      return undefined;
    }
  }
): Promise<Array<T & { instances?: LimitInstance[] }>> {
  return Promise.all(
    ls.map(async (l) => {
      if (l.kind !== "local") return l;
      const mine = rows.filter((r) => (providerOf(r.model) ?? r.model) === l.provider && r.state !== "failed");
      if (!mine.length) return l;
      const instances = await Promise.all(
        mine.map(async (r): Promise<LimitInstance> => {
          const rssMb = r.pid !== undefined ? await rssOf(r.pid).catch(() => undefined) : undefined;
          return { id: r.id, port: r.port, ...(r.pid !== undefined ? { pid: r.pid } : {}), state: r.state, inflight: r.inflight, ...(rssMb ? { rssMb } : {}) };
        })
      );
      return { ...l, instances };
    })
  );
}

/** The catalogue tier whose base port is this port (a cached inventory without tier info still gets its per-model controls). */
function tierAtPort(port: number | undefined): string | undefined {
  if (port === undefined) return undefined;
  try {
    return Object.values(readLocalConfig(workersYamlPath()).tiers).find((t) => t.port === port)?.tier;
  } catch {
    return undefined;
  }
}

/** The tiers (name, label, memory need, instance cap), for the cards' Start/Stop row. */
function localTierNames(): { tier: string; label: string; memoryGb?: number; maxInstances?: number }[] {
  try {
    const cfg = readLocalConfig(workersYamlPath());
    return tierButtons(cfg).map((b) => ({ ...b, maxInstances: cfg.tiers[b.tier]?.maxInstances }));
  } catch {
    return [];
  }
}

/** The managed instances (id, model, port, pid, state) with the requests running or queued on each, for the model cards' per-instance rows. */
function localInstanceRows(): Array<{ id: string; model: string; port: number; pid?: number; state: string; error?: string; inflight: number }> {
  try {
    const logDir = workersLogDir(readWorkersSection().workers);
    const engines = sharedScheduler().snapshot().engines;
    return readLiveInstances(logDir).map((i) => {
      const e = engines[instanceEngineKey(i)];
      return { id: i.id, model: i.model, port: i.port, ...(i.pid !== undefined ? { pid: i.pid } : {}), state: i.state, ...(i.error ? { error: i.error } : {}), inflight: e ? (e.inflight ? 1 : 0) + Object.values(e.queued).reduce((a, n) => a + n, 0) : 0 };
    });
  } catch {
    return [];
  }
}

/** The tier of the running model local work goes to: the owner's pick (local-provider.ts pickLocal), null when none runs. */
async function localDefaultTier(): Promise<string | null> {
  try {
    const { workers } = readWorkersSection();
    const logDir = workersLogDir(workers);
    const st = readLocalStatus(logDir);
    if (!st?.running.length) return null;
    const pick = pickLocal(st.running.map((r) => r.provider), logDir, workersYamlPath(), localTierOrder(workers));
    return Object.values(readLocalConfig(workersYamlPath()).tiers).find((t) => t.provider === pick.name)?.tier ?? null;
  } catch {
    return null;
  }
}

/** The running local models, one per tier provider that answers; `tier` is the tier of that provider. */
async function localRunningInfo(): Promise<Array<{ tier: string; label: string; model: string; memGb: string; provider: string }>> {
  try {
    const logDir = workersLogDir(readWorkersSection().workers);
    const st = readLocalStatus(logDir);
    if (!st?.running.length) return [];
    const tiers = Object.values(readLocalConfig(workersYamlPath()).tiers);
    const inv = readInventory(logDir);
    return st.running.map((run) => {
      const tier = tiers.find((t) => t.provider === run.provider);
      const rts = inv?.runtimes.filter((r) => r.status === "running" && r.users.some((u) => u.startsWith(`worker:${run.provider}`))) ?? [];
      const mb = rts.reduce((a, r) => a + r.models.reduce((x, m) => x + (m.memoryMb ?? 0), 0), 0);
      return { tier: tier?.tier ?? "", label: tier?.label ?? "", model: run.model, provider: run.provider, memGb: mb ? String(Math.max(1, Math.round(mb / 1024))) : "?" };
    });
  } catch {
    return [];
  }
}

/** Probe cache for registered endpoints: one per router process, shared with the router (setEndpointHealth) so an endpoint is probed once per interval. */
let cockpitEndpointHealth = createEndpointHealth();
export function setEndpointHealth(h: EndpointHealth): void {
  cockpitEndpointHealth = h;
}

/** The routing table with the selectors a row can take and the endpoint registry (per tier the ordered models with their live state, read from the same limits the gauges show) and the flow line of what each tier resolves to now. */
async function routingPayload(ls: ProviderLimits[]): Promise<{ rows: RouteRow[]; flow: string; choices: { entry: string; label: string }[]; endpoints: EndpointRow[] }> {
  try {
    const { workers } = readWorkersSection();
    const budgets: BudgetMap = {};
    for (const l of ls) {
      if (l.kind === "local" || !l.windows.length) continue;
      const windows = l.windows.map((w) => ({ name: w.name, percent: w.percent }));
      budgets[l.provider] = { percent: Math.max(...windows.map((w) => w.percent)), resetAt: null, fetchedAt: l.fetchedAt, windows };
    }
    const running = async (name: string) => ls.some((l) => l.kind === "local" && l.provider === name && l.up === true);
    const rows = await routeRows(workers, { logDir: workersLogDir(workers), budgets, running, profiles: readProfiles() });
    const managed = readLiveInstances(workersLogDir(workers)).filter((i) => i.state === "ready");
    const registered = Object.entries(workers.providers).filter(([, p]) => p.characteristics && p.enabled !== false).map(([name, p]) => ({ id: name, model: name, provider: name, url: p.baseUrl, origin: "registered" as const, port: 0, state: "ready" as const, startedAt: 0, log: "", characteristics: p.characteristics }));
    await cockpitEndpointHealth.refresh(registered);
    await cockpitEndpointHealth.refreshManaged(managed);
    const endpoints = endpointRows(workers, managed, (i) => cockpitEndpointHealth.isHealthy(i));
    return { rows, flow: flowText(rows), choices: selectorChoices(workers, endpoints), endpoints };
  } catch {
    return { rows: [], flow: "", choices: [], endpoints: [] };
  }
}

/** The models.labels config block flattened for the payload: runtime → label
 *  and "<runtime>." → {model → label}. null when nothing is set. */
function actionLabels(): Record<string, unknown> | null {
  try {
    const block = readLabels();
    const out: Record<string, unknown> = {};
    let any = false;
    for (const [rt, v] of Object.entries(block)) {
      if (typeof v === "string") {
        out[rt] = v;
        any = true;
      } else if (v && typeof v === "object" && !Array.isArray(v)) {
        out[`${rt}.`] = v;
        any = true;
      }
    }
    return any ? out : null;
  } catch {
    return null;
  }
}

/** Local model servers as the SYSTEM panel shows them (from the limits poll). */
export function systemServers(limits: ProviderLimits[]): Array<Pick<ProviderLimits, "provider" | "up" | "downReason" | "rssMb" | "tokensPerSec" | "tokensPerSecWindow" | "decodeTokPerSec" | "served" | "prefixCache" | "prefixCacheAgeSec">> {
  return limits
    .filter((l) => l.kind === "local")
    .map(({ provider, up, downReason, rssMb, tokensPerSec, tokensPerSecWindow, decodeTokPerSec, served, prefixCache, prefixCacheAgeSec }) => ({
      provider,
      up,
      ...(up === false && downReason ? { downReason } : {}),
      rssMb,
      tokensPerSec,
      tokensPerSecWindow,
      decodeTokPerSec,
      ...(served ? { served } : {}),
      ...(prefixCache ? { prefixCache } : {}),
      ...(prefixCache && prefixCacheAgeSec ? { prefixCacheAgeSec } : {}),
    }));
}

/**
 * Pool carry-over as /cockpit/data shows it, refreshed at most every 30 s:
 * reads the pool metrics file from the configured workers logDir; a pool
 * that never ran leaves the payload field null.
 */
export function cachedPoolCarry(): () => PoolCarry | null {
  let at = 0;
  let carry: PoolCarry | null = null;
  return () => {
    if (Date.now() - at > 30_000) {
      at = Date.now();
      carry = null;
      try {
        const { workers } = readWorkersSection();
        carry = poolCarry(readPoolMetrics(poolMetricsPath(join(workersLogDir(workers)))));
      } catch {
        carry = null;
      }
    }
    return carry;
  };
}

/** The whole request body as text. */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer | string) => {
      const b = typeof c === "string" ? Buffer.from(c) : c;
      chunks.push(b);
      size += b.length;
      if (size > 64_000) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * One provider's Queue panel row: the workers holding a slot on it and the
 * ones waiting, in grant order. Reads the status files and the capacity queue
 * (the same reader `pai worker ps`' QUEUED section uses).
 */
export interface QueueProvider {
  provider: string;
  cap?: number;
  /** Engine conversation-cache slots, when configured (slots used = running.length). */
  conversationSlots?: number;
  running: Array<{ id: string; label: string; ageSec: number; now?: string; session: string; model: string }>;
  waiting: Array<{ id: string; label: string; waitedSec: number; position: number; session: string; model: string }>;
}

/** Session blocks with a `max_parallel` profile key: group name -> limit. */
export type SessionLimits = Record<string, number>;

/** Session id → display name for the scheduler line: the agent-sessions registry
 *  (uuid → name) plus each worker's own session name. A name the registry does not
 *  know falls back to the first 8 chars inside schedLine — never a raw uuid. */
function schedNames(logDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const f = join(expandHome("~"), ".aibroker", "session-names.json");
    if (existsSync(f)) {
      const j = JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>;
      for (const [id, name] of Object.entries(j)) if (typeof name === "string" && name) out[id] = name;
    }
  } catch {
    /* a broken registry: the 8-char fallback stands */
  }
  try {
    for (const s of loadStatusesCached(logDir)) if (s.session?.id && s.session.name) out[s.session.id] = s.session.name;
  } catch {
    /* no statuses: the 8-char fallback stands */
  }
  return out;
}

/**
 * The block a worker belongs to: the session that started it (AIBroker name),
 * else its project (cwd) name when a terminal is known, else "other" (a bare shell).
 */
function sessionGroup(s: WorkerStatus): string {
  if (!s.session?.name && !s.session?.id && !s.term) return "other";
  const name = ownerSessionName(s);
  return name.startsWith("tab ") || name === "?" ? basename(s.cwd || "") || "other" : name;
}

/** The /cockpit/queue payload: every provider with a live or waiting worker. */
export interface CockpitBuilds {
  slots: number;
  testSlots: number;
  running: Array<{ kind: string; id: string; label: string; key?: string; session: string; mode: string; ageSec: number; stalledSec?: number }>;
  waiting: Array<{ kind: string; id: string; label: string; key?: string; why?: string; session: string; mode: string; waitedSec: number; position: number }>;
}

/** The machine-wide build queue, for its own block in the worker panel. */
export function cockpitBuilds(now = Date.now()): CockpitBuilds {
  let tickets: ReturnType<typeof listBuildsSync> = [];
  try {
    tickets = listBuildsSync(buildsDir());
  } catch {
    /* no build dir yet */
  }
  const sec = (t: number): number => Math.max(0, Math.floor((now - t) / 1000));
  const pos: Record<string, number> = {};
  return {
    slots: buildSlots(),
    testSlots: testSlots(),
    running: tickets.filter((t) => t.state === "running").map((t) => ({ kind: ticketKind(t), id: t.id, label: t.label, key: t.key, session: t.session, mode: t.mode, ageSec: sec(t.startedAt ?? t.enqueuedAt), ...(t.stalledAt ? { stalledSec: sec(t.stalledAt) } : {}) })),
    waiting: tickets.filter((t) => t.state === "waiting").map((t) => ({ kind: ticketKind(t), id: t.id, label: t.label, key: t.key, why: waitReason(t, tickets) ?? undefined, session: t.session, mode: t.mode, waitedSec: sec(t.enqueuedAt), position: (pos[ticketKind(t)] = (pos[ticketKind(t)] ?? 0) + 1) })),
  };
}

export function cockpitQueue(
  logDir: string,
  workers: WorkersConfig,
  now = Date.now(),
  owns: (s: { pid: number; started: string; id?: string }) => boolean = ownsPidCached
): { now: number; plans: ReturnType<typeof planRows>; panes: ReturnType<typeof paneRunRows>; paneViolations: Array<{ id: string; mark: string; why?: string }>; providers: QueueProvider[]; sessionMax: SessionLimits; builds: CockpitBuilds; worktrees: string; localModel: string; localModelTitle: string } {
  const caps: Record<string, number | undefined> = {};
  for (const name of Object.keys(workers.providers)) caps[name] = providerCap(workers, name);
  const byProvider = new Map<string, QueueProvider>();
  const row = (provider: string): QueueProvider => {
    let p = byProvider.get(provider);
    if (!p) {
      p = { provider, cap: caps[provider], ...(workers.providers[provider]?.conversationSlots !== undefined ? { conversationSlots: workers.providers[provider].conversationSlots } : {}), running: [], waiting: [] };
      byProvider.set(provider, p);
    }
    return p;
  };
  const waited = (s: WorkerStatus): number => {
    const t = Date.parse((s.started ?? "").replace(" ", "T"));
    return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 1000)) : 0;
  };
  const sessionMax: SessionLimits = {};
  const statuses = loadStatusesCached(logDir);
  for (const s of statuses) {
    // only a queued or live run needs its profile read: thousands of finished statuses would each reread the file
    if (!s.sessionKey || !(s.state === "queued" || (s.state === "running" && isLive(s, owns)))) continue;
    const max = getProfile(s.sessionKey)?.max_parallel;
    if (max) sessionMax[sessionGroup(s)] = max;
  }
  for (const s of statuses) {
    if (s.state === "running" && isLive(s, owns)) row(s.provider).running.push({ id: s.id, label: s.label, ageSec: waited(s), now: s.last ? s.last.slice(0, 80) : undefined, session: sessionGroup(s), model: s.model });
  }
  for (const r of queueRows(logDir, caps, undefined, statuses)) {
    const s = r.status;
    // a run held by its session's max_parallel waits in the session queue; it sits in its own provider's rows
    row(s && r.provider.startsWith("session~") ? s.provider : r.provider).waiting.push({
      id: r.id,
      label: s?.label ?? "",
      waitedSec: r.since !== undefined ? Math.max(0, Math.floor((now - r.since) / 1000)) : s ? waited(s) : 0,
      position: r.position,
      session: s ? sessionGroup(s) : "other",
      model: s?.model ?? "",
    });
  }
  const snap = readSchedFile(logDir, now);
  // the scheduler line resolves through the display-name order: the agent-sessions
  // registry gives every session a project slug, and a session's own background-job
  // name beats that slug; a worker's own session name tops both
  const names = loadSessionMap({ workerDirs: [], agentSessionsFile: paiHomePath("agent-sessions.json"), jobsDir: defaultSources().jobsDir });
  for (const e of Object.values(snap?.engines ?? {})) {
    for (const sid of [e.inflight?.session, ...Object.keys(e.queued), ...Object.keys(e.counters)]) {
      if (!sid || names.get(sid)?.aibroker) continue;
      const job = jobSessionName(sid, defaultSources().jobsDir);
      if (job) names.set(sid, { ...(names.get(sid) ?? {}), name: job });
    }
  }
  for (const [id, name] of Object.entries(schedNames(logDir))) names.set(id, { ...(names.get(id) ?? {}), name });
  const sched = schedPlain(snap, Object.fromEntries([...names].map(([id, info]) => [id, info.name])));
  return { now, plans: planRows(loadPlanStatuses(logDir), now), panes: paneRunRows(loadPaneRunStatuses(logDir), now), paneViolations: readAudit(logDir).filter((a) => a.mark !== "ok").map((a) => ({ id: a.id, mark: a.mark, why: a.why })), providers: [...byProvider.values()], sessionMax, builds: cockpitBuilds(now), worktrees: formatWorktreesStats(worktreesStatsCached(logDir, now)), localModel: [localIdleLine(readLocalIdle(logDir), now), sched.text].filter(Boolean).join(" · "), localModelTitle: sched.title };
}

const BUILD_PLACEHOLDER = /__COCKPIT_BUILD__/g;
const VERSION_PLACEHOLDER = /__COCKPIT_VERSION__/g;
const VERSION_SHORT_PLACEHOLDER = /__COCKPIT_VERSION_SHORT__/g;
const VERSION_PATCH_PLACEHOLDER = /__COCKPIT_VERSION_PATCH__/g;
const HOMEPAGE_PLACEHOLDER = /__COCKPIT_HOMEPAGE__/g;
/** The header title markup, spelled once: the link's inner content and the no-homepage fallback. */
const TITLE_MARKUP = 'PAI<span class="hc"> Cockpit</span>';
let pkgVersion: string | null = null;
/** The version this router runs: package.json, read once at startup (the one owner of the header's "v<version>"). */
function cockpitVersion(): string {
  if (pkgVersion) return pkgVersion;
  try {
    pkgVersion = (JSON.parse(readFileSync(resolveFromModule(import.meta.url, "package.json"), "utf8")) as { version?: string }).version ?? "?";
  } catch {
    pkgVersion = "?";
  }
  return pkgVersion;
}
/** The project homepage from package.json, read once at startup; null when absent (the header title then stays plain text).
 *  The placeholder stands in for the whole h1 content, so no URL literal is in the page source. */
let pkgHomepage: string | null | undefined;
function cockpitHomepage(): string | null {
  if (pkgHomepage === undefined) {
    try {
      pkgHomepage = (JSON.parse(readFileSync(resolveFromModule(import.meta.url, "package.json"), "utf8")) as { homepage?: string }).homepage ?? null;
    } catch {
      pkgHomepage = null;
    }
  }
  return pkgHomepage;
}
/** Where the page gets the default layout this install serves (null = compose its own). */
const SAVED_AT_PLACEHOLDER = "0/*__COCKPIT_LAYOUT_SAVED_AT__*/";
const LAYOUT_PLACEHOLDER = "null/*__COCKPIT_LAYOUT__*/";
let buildId: string | null = null;
/** Test seam: pin the build id the page is stamped with and the poll reports (null = derive again). */
export function setCockpitBuildId(id: string | null): void {
  buildId = id;
}
/** This router's page build: a hash of the page source it serves, fixed for the life of the process. */
function cockpitBuildId(): string {
  return (buildId ??= createHash("sha1").update(cockpitHtml()).digest("hex").slice(0, 12));
}

/**
 * Serve /cockpit, /cockpit/data, /cockpit/system, /cockpit/pool,
 * /cockpit/queue and the queue write actions. Returns false when the path is
 * not a cockpit path. GET except the three POST queue endpoints
 * (/cockpit/queue/front, /cockpit/queue/up, /cockpit/queue/move); the router binds 127.0.0.1
 * unless router.bind opens a second listener (then every cockpit route,
 * writes included, is token-gated — see src/router/cockpit-auth.ts).
 */
export function handleCockpit(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  limits: LimitsSource,
  readRows: () => UsageRow[] = cachedRows(),
  sessionMap: () => Map<string, SessionInfo> = loadSessionMap,
  system?: SystemMonitor,
  workerWindows: () => WorkerWindow[] = loadWorkerWindows,
  readPool: () => PoolCarry | null = cachedPoolCarry(),
  readPoolPanel: typeof sharedPoolPanel = sharedPoolPanel,
  queueLogDir: (workers: WorkersConfig) => string = workersLogDir): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  const detail = url.pathname.match(/^\/api\/session\/([^/]*)\/detail$/);
  if (!detail && url.pathname !== "/cockpit" && !url.pathname.startsWith("/cockpit/")) return false;
  const send = (status: number, type: string, body: string) => {
    res.writeHead(status, { "content-type": type, "cache-control": "no-store", "content-length": Buffer.byteLength(body) });
    res.end(body);
  };
  if (detail) {
    if (req.method !== "GET") return send(405, "text/plain", "GET only"), true;
    if (!SESSION_ID_RE.test(detail[1]!)) return send(400, "application/json", '{"error":"invalid session id"}'), true;
    sessionDetail(detail[1]!).then(
      (d) => (d ? send(200, "application/json", JSON.stringify(d)) : send(404, "application/json", '{"error":"no such session"}')),
      (e: Error) => send(500, "application/json", JSON.stringify({ error: e.message }))
    );
    return true;
  }
  if (req.method === "POST" && (url.pathname === "/cockpit/queue/next" || url.pathname === "/cockpit/queue/front" || url.pathname === "/cockpit/queue/up" || url.pathname === "/cockpit/queue/move")) {
    if (!sameOriginAction(req)) return send(403, "application/json", JSON.stringify({ ok: false, message: "cross-origin action refused" })), true;
    readJsonObject(readBody, req).then((b) => {
      const { id, position } = b as { id?: unknown; position?: unknown };
      if (!id || typeof id !== "string") return send(400, "application/json", JSON.stringify({ ok: false, message: "id required", error: "id required" }));
      if (!WORKER_ID_RE.test(id)) return send(400, "application/json", JSON.stringify({ ok: false, message: "invalid id", error: "invalid id" }));
      const move = url.pathname.endsWith("/move");
      if (move && !(typeof position === "number" && Number.isFinite(position) && position >= 1)) return send(400, "application/json", JSON.stringify({ ok: false, message: "position (>= 1) required", error: "position (>= 1) required" }));
      try {
        const { workers } = readWorkersSection();
        const logDir = queueLogDir(workers);
        const status = loadStatus(logDir, id);
        if (!status) return send(404, "application/json", JSON.stringify({ ok: false, message: `no worker named "${id}"`, error: `no worker named "${id}"` }));
        const order = move
          ? reorderQueueTo(logDir, status.provider, id, position as number)
          : reorderQueue(logDir, status.provider, id, url.pathname.endsWith("/front") || url.pathname.endsWith("/next") ? "front" : "up");
        send(200, "application/json", JSON.stringify({ ok: true, id, provider: status.provider, order }));
      } catch (e) {
        send(409, "application/json", JSON.stringify({ ok: false, message: (e as Error).message, error: (e as Error).message }));
      }
    }).catch((e: unknown) => send(bodyErrorStatus(e), "application/json", JSON.stringify({ ok: false, message: (e as Error).message, error: (e as Error).message })));
    return true;
  }
  const concurrency = req.method === "POST" ? /^\/cockpit\/providers\/([^/]+)\/concurrency$/.exec(url.pathname) : null;
  if (concurrency) {
    if (!sameOriginAction(req)) return send(403, "application/json", JSON.stringify({ ok: false, message: "cross-origin action refused" })), true;
    let name: string;
    try {
      name = decodeURIComponent(concurrency[1]!);
    } catch {
      return send(400, "application/json", JSON.stringify({ ok: false, message: "malformed provider name" })), true;
    }
    readJsonObject(readBody, req).then((b) => {
      const { delta } = b as { delta?: unknown };
      if (delta !== 1 && delta !== -1) return send(400, "application/json", JSON.stringify({ ok: false, message: "delta must be +1 or -1" }));
      try {
        const cur = readWorkersSection().workers.providers[name]?.maxConcurrent;
        if (cur === undefined) return send(404, "application/json", JSON.stringify({ ok: false, message: `provider "${name}" has no concurrency cap` }));
        const { concurrencyMin, concurrencyMax } = cockpitLayout();
        const next = Math.min(concurrencyMax, Math.max(concurrencyMin, cur + delta));
        if (next !== cur) setProviderCap(name, next);
        send(200, "application/json", JSON.stringify({ ok: true, provider: name, maxConcurrent: next, min: concurrencyMin, max: concurrencyMax, clamped: next !== cur + delta }));
      } catch (e) {
        send(409, "application/json", JSON.stringify({ ok: false, message: (e as Error).message }));
      }
    }).catch((e: unknown) => send(bodyErrorStatus(e), "application/json", JSON.stringify({ ok: false, message: (e as Error).message })));
    return true;
  }
  if (req.method === "POST" && url.pathname === "/cockpit/action") {
    if (!sameOriginAction(req)) return send(403, "application/json", JSON.stringify({ ok: false, message: "cross-origin action refused" })), true;
    readJsonObject(readBody, req)
      .then(async (body) => {
        try {
          const r = await runCockpitAction(body, { ...defaultDeps(), onLocalChange: () => (limits as Partial<LimitsCache>).invalidate?.(), ...(actionDepsOverride ?? {}) }, actionHooks);
          send(200, "application/json", JSON.stringify(r));
        } catch (e) {
          send(500, "application/json", JSON.stringify({ ok: false, message: (e as Error).message }));
        }
      })
      .catch((e: unknown) => send(bodyErrorStatus(e), "application/json", JSON.stringify({ ok: false, message: (e as Error).message })));
    return true;
  }
  if (url.pathname === "/cockpit/layout-default" && req.method === "POST") {
    if (!sameOriginAction(req)) return send(403, "application/json", JSON.stringify({ ok: false, message: "cross-origin action refused" })), true;
    readBody(req).then(
      (raw) => (saveDefaultLayout(raw) ? send(200, "application/json", '{"ok":true}') : send(400, "application/json", '{"ok":false,"message":"not a layout"}')),
      (e: Error) => send(400, "application/json", JSON.stringify({ ok: false, message: e.message }))
    );
    return true;
  }
  if (handleRegistryRoute(req, res, url.pathname, registryCtx, { sameOrigin: sameOriginAction, readBody })) return true;
  if (req.method === "GET" && url.pathname === "/cockpit/job") {
    const home = actionDepsOverride?.home ?? paiHomeDir();
    const j = home ? readCockpitJob(home, url.searchParams.get("id") ?? "") : null;
    send(j ? 200 : 404, "application/json", j ? JSON.stringify({ ...j, ...(runtimeJobProgress(home, j) ?? memoryJobProgress(home, j) ?? {}) }) : JSON.stringify({ error: "no such job" }));
    return true;
  }
  if (req.method !== "GET") return send(405, "text/plain", "GET only"), true;
  if (url.pathname === "/cockpit") {
    // never a 200 with an empty body: a poll that swaps it in blanks the page (and moves the view); 503 keeps the old one
    let html = "";
    try {
      html = cockpitHtml().replace(BUILD_PLACEHOLDER, cockpitBuildId()).replace(VERSION_SHORT_PLACEHOLDER, cockpitVersion().split(".").slice(0, 2).join(".")).replace(VERSION_PATCH_PLACEHOLDER, cockpitVersion().split(".").slice(2).map((p) => "." + p).join("")).replace(VERSION_PLACEHOLDER, cockpitVersion()).replace(HOMEPAGE_PLACEHOLDER, () => {
        const home = cockpitHomepage();
        if (!home) return TITLE_MARKUP;
        const href = home.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        return `<a class="home" href="${href}" target="_blank" rel="noopener">${TITLE_MARKUP}</a>`;
      }).replace(LAYOUT_PLACEHOLDER, () => JSON.stringify(readDefaultLayout()).replace(/</g, "\\u003c")).replace(SAVED_AT_PLACEHOLDER, String(defaultSavedAt()));
    } catch {
      /* falls through to the 503 */
    }
    if (html) send(200, "text/html; charset=utf-8", html);
    else {
      res.setHeader("retry-after", "1");
      send(503, "text/plain", "cockpit page not ready");
    }
  }
  else if (url.pathname === "/cockpit/data") {
    try {
      const rows = readRows();
      send(200, "application/json", JSON.stringify({ ...buildCockpitData(rows, parseWindow(url.searchParams.get("window")), Date.now(), namedSessionMap(rows, sessionMap, workerWindows), readPool(), configuredProviders()), build: cockpitBuildId(), layoutSavedAt: defaultSavedAt() }));
    } catch (e) {
      send(500, "application/json", JSON.stringify({ error: (e as Error).message }));
    }
  } else if (url.pathname === "/cockpit/system") {
    if (!system) return send(503, "application/json", '{"error":"system metrics not configured"}'), true;
    let limitsFailed = false;
    Promise.all([
      system.snapshot(parseWindow(url.searchParams.get("window"))),
      limits.get().catch((): ProviderLimits[] => ((limitsFailed = true), [])),
    ]).then(
      ([snap, ls]) => send(200, "application/json", JSON.stringify({ ...snap, servers: systemServers(ls), ...(limitsFailed ? { transient: "limits unavailable" } : {}) })),
      (e: Error) => send(500, "application/json", JSON.stringify({ error: e.message }))
    );
  } else if (url.pathname === "/cockpit/models") {
    cockpitModelsPayload().then(
      (inv) => send(200, "application/json", JSON.stringify(inv)),
      (e: Error) => send(500, "application/json", JSON.stringify({ error: e.message }))
    );
  } else if (url.pathname === "/cockpit/memory") {
    cockpitMemoryPayload({ ...liveMemoryDeps(), ...(memoryDepsOverride ?? {}) }).then(
      (m) => send(200, "application/json", JSON.stringify(m)),
      (e: Error) => send(500, "application/json", JSON.stringify({ error: e.message }))
    );
  } else if (url.pathname === "/cockpit/scheduler") {
    send(200, "application/json", JSON.stringify(sharedScheduler().snapshot()));
  } else if (url.pathname === "/cockpit/pool") {
    readPoolPanel().then(
      (p) => send(200, "application/json", JSON.stringify(p)),
      (e: Error) => send(500, "application/json", JSON.stringify({ error: e.message }))
    );
  } else if (url.pathname === "/cockpit/queue") {
    try {
      const { workers } = readWorkersSection();
      send(200, "application/json", JSON.stringify(cockpitQueue(queueLogDir(workers), workers)));
    } catch (e) {
      send(500, "application/json", JSON.stringify({ error: (e as Error).message }));
    }
  } else if (url.pathname === "/cockpit/limits") {
    limits.get().then((l0) => enabledLocalLimits(l0, configuredProviders())).then((l) => routingPayload(l).then((routing) => [l, routing] as const)).then(
      async ([l, routing]) => {
        // a provider whose poll failed keeps its last good reading (limits.ts staleReading) and carries the cause
        const failed = l.find((x) => x.error);
        send(200, "application/json", JSON.stringify({ now: Date.now(), limits: await withInstances(withWeights(withStarting(l))), routing, runningLocal: runningLocalProviders(l), activeLocal: activeLocalProvider(l), ...(failed ? { transient: `${failed.provider}: ${failed.error}` } : {}) }));
      },
      (e: Error) => send(500, "application/json", JSON.stringify({ error: e.message }))
    );
  } else send(404, "text/plain", "not found");
  return true;
}
