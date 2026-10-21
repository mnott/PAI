/**
 * cockpit.ts — aggregation behind the router's /cockpit page. Pure functions
 * over usage rows; the HTTP handler at the bottom only serves them. The page
 * gets numbers and display names, never keys, bodies or prompt content.
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type http from "node:http";
import type { LimitsCache, ProviderLimits } from "./limits.js";
import { cockpitHtml } from "./cockpit-page.js";
import { expandHome, loadConfig, readMainConfigRaw } from "../daemon/config.js";
import { deepMergeConfig, shippedMainDefaults } from "../config/shipped-defaults.js";
import { readUsage, splitBySessionKind, usageLogFile, type SessionKindSplit, type UsageRow } from "./usage.js";
import { defaultSources, drain, jobSessionName, loadSessionMap, loadSessionMapSteps, loadWorkerWindows, loadWorkerWindowsSteps, runSliced, withJobNames, withWorkerAttributionSteps, type SessionInfo, type WorkerWindow } from "./sessions.js";
import { paiHomePath } from "../config/pai-home.js";
import { poolCarry, poolMetricsPath, readPoolMetrics, type PoolCarry } from "../workers/pool.js";
import { readWorkersSection, type WorkersConfig, ANTHROPIC_NATIVE } from "../workers/config.js";
import { buildsDir, listBuildsSync, ticketKind, waitReason } from "../builds/queue.js";
import { buildSlots, testSlots } from "../builds/config.js";
import { workersLogDir } from "../workers/paths.js";import { sharedPoolPanel } from "./pool-panel.js";
import { currentInventory, readInventory, readInventoryInput } from "../workers/model-inventory.js";
import { readRuntimeCommands, embeddingRuntimeName } from "../workers/model-runtimes.js";
import { activeTier, fetchServedModels, readLocalConfig, tierButtons } from "../workers/local-tiers.js";
import { workersYamlPath } from "../workers/workers-config.js";
import { parse as parseYaml } from "yaml";
import { readLocalStatus } from "../workers/local-status.js";
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
import { defaultDeps, readCockpitJob, readLabels, runCockpitAction, runningRuntimeJobs, runtimeJobProgress, type ActionDeps, type ActionHooks } from "./cockpit-actions.js";
import type { SystemMonitor } from "./system.js";
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
export function canonicalModel(id: string): string {
  const m = id.trim().toLowerCase().replace(/^anthropic\//, "");
  if (!m.startsWith("claude-")) return id;
  return m.replace(/\[[^\]]*\]$/, "").replace(/-(?:latest|\d{8})$/, "");
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

/** Local-server readings of a provider that is disabled (or no longer configured) are dropped, like the models inventory does. */
export function enabledLocalLimits(ls: ProviderLimits[], providers: Record<string, { enabled?: boolean }>): ProviderLimits[] {
  if (!Object.keys(providers).length) return ls;
  return ls.filter((l) => l.kind !== "local" || (l.provider in providers && providers[l.provider]!.enabled !== false));
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

export function buildCockpitData(
  allRows: UsageRow[],
  win: CockpitWindow,
  now: number = Date.now(),
  sessions: Map<string, SessionInfo> = new Map(),
  pool: PoolCarry | null = null,
  providers: Record<string, { enabled?: boolean; baseUrl?: string; models?: Record<string, unknown> }> = {}
) {
  allRows = foldProviders(allRows, providers, modelOwners(providers));
  const { span, bucket } = WINDOWS[win];
  const from = bucketStart(now - span, bucket);
  const rows = allRows.filter((r) => Date.parse(r.ts) >= from);
  const retries = retryRows(rows);

  // series: one entry per bucket, per model token parts
  const series: Array<{ t: number; models: Record<string, Tok & { requests: number }> }> = [];
  for (let t = from; t <= now; t += bucket) series.push({ t, models: {} });
  const total = tok();
  let errors = 0;
  const byModel = new Map<string, Tok & { model: string; provider: string; requests: number; errors: number }>();
  const byProvider = new Map<string, Tok & { provider: string; requests: number; errors: number; retries: number; ms: number }>();
  const ttftByProvider = new Map<string, number[]>();
  const bySession = new Map<string, Tok & { session: string; name: string | null; requests: number; errors: number; busts: number; lastTs: string; models: Set<string> }>();
  const pause = new Map<string, Map<string, { n: number; hit: number; write: number; miss: number; readTok: number; writeTok: number }>>();
  const bustParts: Record<string, number> = {};

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
      };
    })
    .sort((a, b) => b.input + b.output + b.cacheWrite + b.cacheRead - (a.input + a.output + a.cacheWrite + a.cacheRead));

  // tokens per day per model: always the last 14 days, whatever the window
  const dayFrom = bucketStart(now, DAY) - 13 * DAY;
  const days: number[] = [];
  for (let t = dayFrom; t <= now; t += DAY) days.push(t);
  const daily: Record<string, number[]> = {};
  for (const r of allRows) {
    const t = Date.parse(r.ts);
    if (t < dayFrom) continue;
    const arr = (daily[canonicalModel(r.model)] ??= days.map(() => 0));
    arr[Math.floor((bucketStart(t, DAY) - dayFrom) / DAY)]! += (r.input_tokens ?? 0) + (r.output_tokens ?? 0) + (r.cache_creation_input_tokens ?? 0) + (r.cache_read_input_tokens ?? 0);
  }

  // prompt tokens per provider over the whole log: denominator for the local
  // servers' tokensSaved counter, which the stats endpoint gives no total for
  const promptByProvider: Record<string, number> = {};
  // first row per provider: the log (router restart) is younger than a server's own counters
  const promptSince: Record<string, string> = {};
  for (const r of allRows) {
    if (!promptSince[r.provider] || r.ts < promptSince[r.provider]!) promptSince[r.provider] = r.ts;
    promptByProvider[r.provider] = (promptByProvider[r.provider] ?? 0) + (r.input_tokens ?? 0) + (r.cache_read_input_tokens ?? 0) + (r.cache_creation_input_tokens ?? 0);
  }

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
    byModel: [...byModel.values()].map(withRatio).sort((a, b) => b.requests - a.requests),
    byProvider: [...byProvider.values()].map((p) => ({ ...withRatio(p), avgMs: p.requests ? Math.round(p.ms / p.requests) : 0, ttftP50: percentile(ttftByProvider.get(p.provider) ?? [], 0.5) })),
    bySession: sessionRows,
    cachePause: [...pause.entries()].map(([model, pm]) => ({
      model,
      buckets: PAUSE_BUCKETS.map((label) => ({ label, ...(pm.get(label) ?? { n: 0, hit: 0, write: 0, miss: 0, readTok: 0, writeTok: 0 }) })),
    })),
    bustParts,
    speed: buildSpeed(allRows, now, canonicalModel, (p) => isLoopbackUrl(providers[p]?.baseUrl ?? "")),
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

/**
 * The usage log as rows, kept in memory: a log that only grew is read from where the last read
 * stopped (the router appends a row per request, so a full reread of tens of MB on every append
 * would block the event loop); one that shrank or was replaced is read again from the start.
 */
export function cachedRows(file: string = usageLogFile()): () => UsageRow[] {
  let rows: UsageRow[] = [];
  let offset = 0;
  let mtimeMs = 0;
  return () => {
    try {
      const st = statSync(file);
      if (st.size === offset && st.mtimeMs === mtimeMs) return rows;
      if (st.size < offset) {
        rows = [];
        offset = 0;
      }
      const fd = openSync(file, "r");
      try {
        const buf = Buffer.alloc(st.size - offset);
        const n = readSync(fd, buf, 0, buf.length, offset);
        const text = buf.subarray(0, n).toString("utf8");
        const end = text.lastIndexOf("\n") + 1; // a torn last line waits for its newline
        const added: UsageRow[] = [];
        for (const l of text.slice(0, end).split("\n")) {
          if (!l) continue;
          try {
            added.push(JSON.parse(l) as UsageRow);
          } catch {
            /* skip torn line */
          }
        }
        if (added.length) rows = rows.concat(added);
        offset += Buffer.byteLength(text.slice(0, end), "utf8");
      } finally {
        closeSync(fd);
      }
      mtimeMs = st.mtimeMs;
    } catch {
      rows = [];
      offset = 0;
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
  const sfs = req.headers["sec-fetch-site"];
  if (typeof sfs === "string" && sfs !== "same-origin" && sfs !== "none") return false;
  const origin = req.headers.origin;
  if (typeof origin !== "string" || !origin) return true;
  try {
    return new URL(origin).host === (req.headers.host ?? "");
  } catch {
    return false;
  }
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
    runtimes: inv.runtimes.map((r) => ({ ...r, label: labels?.[r.name] ?? "", modelLabels: labels?.[`${r.name}.`] ?? {} })),
    tiers: localTierNames(),
    running: await localRunningInfo(),
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

/** The tiers (name, label, memory need), for the cards' Start/Stop row. */
function localTierNames(): { tier: string; label: string; memoryGb?: number }[] {
  try {
    return tierButtons(readLocalConfig(workersYamlPath()));
  } catch {
    return [];
  }
}

/** The running local model; `tier` is the active tier (its port answers with its model name). */
async function localRunningInfo(): Promise<{ tier: string; label: string; model: string; memGb: string } | null> {
  try {
    const st = readLocalStatus(workersLogDir(readWorkersSection().workers));
    if (!st?.running) return null;
    const cfg = readLocalConfig(workersYamlPath());
    const tiers = cfg.tiers;
    const active = (await activeTier(cfg, fetchServedModels)) ?? Object.values(tiers).find((t) => t.provider === st.running!.provider);
    const inv = readInventory(workersLogDir(readWorkersSection().workers));
    const rt = inv?.runtimes.find((r) => r.status === "running" && r.users.some((u) => u.startsWith(`worker:${st.running!.provider}`)));
    const mb = rt?.models.reduce((a, m) => a + (m.memoryMb ?? 0), 0) ?? 0;
    return { tier: active?.tier ?? "", label: active?.label ?? "", model: st.running.model, memGb: mb ? String(Math.max(1, Math.round(mb / 1024))) : "?" };
  } catch {
    return null;
  }
}

/** The routing table, read-only (per tier the ordered models with their live state, read from the same limits the gauges show) and the flow line of what each tier resolves to now. */
async function routingPayload(ls: ProviderLimits[]): Promise<{ rows: RouteRow[]; flow: string }> {
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
    return { rows, flow: flowText(rows) };
  } catch {
    return { rows: [], flow: "" };
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
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 64_000) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
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

/**
 * Serve /cockpit, /cockpit/data, /cockpit/system, /cockpit/pool,
 * /cockpit/queue and the queue write actions. Returns false when the path is
 * not a cockpit path. GET except the three POST queue endpoints
 * (/cockpit/queue/front, /cockpit/queue/up, /cockpit/queue/move); the router binds 127.0.0.1
 * unless router.bind opens a second listener (then every cockpit route,
 * writes included, is token-gated — see src/router/cockpit-auth.ts).
 */
/** Sections to show: ?sections=a,b overrides router.cockpit.sections, which is re-read on every page load. Empty = all. */
function cockpitSections(url: URL): string[] {
  const q = url.searchParams.get("sections");
  if (q !== null) return q.split(",").map((x) => x.trim()).filter(Boolean);
  try {
    const l = loadConfig().router.cockpit?.sections;
    return Array.isArray(l) ? l.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function handleCockpit(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  limits: LimitsSource,
  readRows: () => UsageRow[] = readUsage,
  sessionMap: () => Map<string, SessionInfo> = loadSessionMap,
  system?: SystemMonitor,
  workerWindows: () => WorkerWindow[] = loadWorkerWindows,
  readPool: () => PoolCarry | null = cachedPoolCarry(),
  readPoolPanel: typeof sharedPoolPanel = sharedPoolPanel,
  queueLogDir: (workers: WorkersConfig) => string = workersLogDir): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/cockpit" && !url.pathname.startsWith("/cockpit/")) return false;
  const send = (status: number, type: string, body: string) => {
    res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
  };
  if (req.method === "POST" && (url.pathname === "/cockpit/queue/next" || url.pathname === "/cockpit/queue/front" || url.pathname === "/cockpit/queue/up" || url.pathname === "/cockpit/queue/move")) {
    const body = readBody(req)
      .then((raw) => JSON.parse(raw || "{}") as { id?: string; position?: number })
      .catch(() => ({} as { id?: string; position?: number }));
    body.then(({ id, position }) => {
      if (!id || typeof id !== "string") return send(400, "application/json", JSON.stringify({ error: "id required" }));
      const move = url.pathname.endsWith("/move");
      if (move && !(typeof position === "number" && Number.isFinite(position) && position >= 1)) return send(400, "application/json", JSON.stringify({ error: "position (>= 1) required" }));
      try {
        const { workers } = readWorkersSection();
        const logDir = queueLogDir(workers);
        const status = loadStatus(logDir, id);
        if (!status) return send(404, "application/json", JSON.stringify({ error: `no worker named "${id}"` }));
        const order = move
          ? reorderQueueTo(logDir, status.provider, id, position as number)
          : reorderQueue(logDir, status.provider, id, url.pathname.endsWith("/front") || url.pathname.endsWith("/next") ? "front" : "up");
        send(200, "application/json", JSON.stringify({ id, provider: status.provider, order }));
      } catch (e) {
        send(409, "application/json", JSON.stringify({ error: (e as Error).message }));
      }
    });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/cockpit/action") {
    if (!sameOriginAction(req)) return send(403, "application/json", JSON.stringify({ ok: false, message: "cross-origin action refused" })), true;
    readBody(req)
      .then((raw) => JSON.parse(raw || "{}") as { action?: unknown; target?: unknown; value?: unknown; class?: unknown; models?: unknown })
      .catch(() => ({}))
      .then(async (body) => {
        try {
          const r = await runCockpitAction(body, { ...defaultDeps(), ...(actionDepsOverride ?? {}) }, actionHooks);
          send(200, "application/json", JSON.stringify(r));
        } catch (e) {
          send(500, "application/json", JSON.stringify({ ok: false, message: (e as Error).message }));
        }
      });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/cockpit/job") {
    const home = actionDepsOverride?.home ?? paiHomeDir();
    const j = home ? readCockpitJob(home, url.searchParams.get("id") ?? "") : null;
    send(j ? 200 : 404, "application/json", j ? JSON.stringify({ ...j, ...(runtimeJobProgress(home, j) ?? memoryJobProgress(home, j) ?? {}) }) : JSON.stringify({ error: "no such job" }));
    return true;
  }
  if (req.method !== "GET") return send(405, "text/plain", "GET only"), true;
  if (url.pathname === "/cockpit") send(200, "text/html; charset=utf-8", cockpitHtml(cockpitSections(url)));
  else if (url.pathname === "/cockpit/data") {
    try {
      const rows = readRows();
      send(200, "application/json", JSON.stringify(buildCockpitData(rows, parseWindow(url.searchParams.get("window")), Date.now(), namedSessionMap(rows, sessionMap, workerWindows), readPool(), configuredProviders())));
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
    readPoolPanel().then((p) => send(200, "application/json", JSON.stringify(p)));
  } else if (url.pathname === "/cockpit/queue") {
    try {
      const { workers } = readWorkersSection();
      send(200, "application/json", JSON.stringify(cockpitQueue(queueLogDir(workers), workers)));
    } catch (e) {
      send(500, "application/json", JSON.stringify({ error: (e as Error).message }));
    }
  } else if (url.pathname === "/cockpit/limits") {
    limits.get().then((l0) => enabledLocalLimits(l0, configuredProviders())).then((l) => routingPayload(l).then((routing) => [l, routing] as const)).then(
      ([l, routing]) => {
        // a provider whose poll failed keeps its last good reading (limits.ts staleReading) and carries the cause
        const failed = l.find((x) => x.error);
        send(200, "application/json", JSON.stringify({ now: Date.now(), limits: l, routing, activeLocal: configuredLocal(), ...(failed ? { transient: `${failed.provider}: ${failed.error}` } : {}) }));
      },
      (e: Error) => send(500, "application/json", JSON.stringify({ error: e.message }))
    );
  } else send(404, "text/plain", "not found");
  return true;
}
