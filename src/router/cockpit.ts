/**
 * cockpit.ts — aggregation behind the router's /cockpit page. Pure functions
 * over usage rows; the HTTP handler at the bottom only serves them. The page
 * gets numbers and display names, never keys, bodies or prompt content.
 */

import { statSync } from "node:fs";
import { basename, join } from "node:path";
import type http from "node:http";
import type { LimitsCache, ProviderLimits } from "./limits.js";
import { COCKPIT_HTML } from "./cockpit-page.js";
import { readUsage, splitBySessionKind, usageLogFile, type SessionKindSplit, type UsageRow } from "./usage.js";
import { loadSessionMap, loadWorkerWindows, withWorkerAttribution, type SessionInfo, type WorkerWindow } from "./sessions.js";
import { poolCarry, poolMetricsPath, readPoolMetrics, type PoolCarry } from "../workers/pool.js";
import { readWorkersSection, type WorkersConfig } from "../workers/config.js";
import { workersLogDir } from "../workers/paths.js";import { sharedPoolPanel } from "./pool-panel.js";
import { currentInventory } from "../workers/model-inventory.js";
import { providerCap, queueRows, reorderQueue, reorderQueueTo } from "../workers/capacity.js";
import { ownerSessionName } from "../workers/scope.js";
import { getProfile } from "../workers/session-profile-store.js";
import { isLive, loadStatus, loadStatuses, ownsPid, type WorkerStatus } from "../workers/status.js";
import { buildSpeed, percentile } from "./speed.js";
import type { SystemMonitor } from "./system.js";

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
  const live = (name: string) => name === "anthropic" || providers[name]?.enabled !== false && name in providers;
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

function configuredProviders(): Record<string, { enabled?: boolean; models?: Record<string, unknown> }> {
  try {
    return readWorkersSection().workers.providers;
  } catch {
    return {};
  }
}

export function buildCockpitData(
  allRows: UsageRow[],
  win: CockpitWindow,
  now: number = Date.now(),
  sessions: Map<string, SessionInfo> = new Map(),
  pool: PoolCarry | null = null,
  providers: Record<string, { enabled?: boolean; models?: Record<string, unknown> }> = {}
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
    speed: buildSpeed(allRows, now, canonicalModel),
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

/** Reread the usage log only when its size or mtime changed. */
export function cachedRows(file: string = usageLogFile()): () => UsageRow[] {
  let key = "";
  let rows: UsageRow[] = [];
  return () => {
    try {
      const st = statSync(file);
      const k = `${st.size}:${st.mtimeMs}`;
      if (k !== key) {
        rows = readUsage(file);
        key = k;
      }
    } catch {
      rows = [];
    }
    return rows;
  };
}

/** Session map reloaded at most every 30 s (status files are many). */
export function cachedSessionMap(ttlMs = 30_000): () => Map<string, SessionInfo> {
  let at = 0;
  let map = new Map<string, SessionInfo>();
  return () => {
    if (Date.now() - at > ttlMs) {
      map = loadSessionMap();
      at = Date.now();
    }
    return map;
  };
}

/** Worker run windows reloaded at most every 60 s (same status files, one pass). */
export function cachedWorkerWindows(ttlMs = 60_000): () => WorkerWindow[] {
  let at = 0;
  let windows: WorkerWindow[] = [];
  return () => {
    if (Date.now() - at > ttlMs) {
      windows = loadWorkerWindows();
      at = Date.now();
    }
    return windows;
  };
}

/**
 * Session names for the cockpit: the exact map plus one-shot ids attributed
 * to their worker run window. The exact map is cached; attribution itself is
 * cheap (unknown ids in the window only) and runs per request against the
 * rows being rendered.
 */
function namedSessionMap(rows: UsageRow[], sessionMap: () => Map<string, SessionInfo>, workerWindows: () => WorkerWindow[]): Map<string, SessionInfo> {
  return withWorkerAttribution(sessionMap(), rows, workerWindows());
}

export function parseWindow(q: string | null): CockpitWindow {
  return q === "24h" || q === "7d" ? q : "1h";
}

/** Anything with a cached provider poll; LimitsCache in production, stubs in tests. */
export type LimitsSource = Pick<LimitsCache, "get">;

/** Local model servers as the SYSTEM panel shows them (from the limits poll). */
export function systemServers(limits: ProviderLimits[]): Array<Pick<ProviderLimits, "provider" | "up" | "rssMb" | "tokensPerSec" | "decodeTokPerSec" | "served" | "prefixCache" | "prefixCacheAgeSec">> {
  return limits
    .filter((l) => l.kind === "local")
    .map(({ provider, up, rssMb, tokensPerSec, decodeTokPerSec, served, prefixCache, prefixCacheAgeSec }) => ({
      provider,
      up,
      rssMb,
      tokensPerSec,
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
  running: Array<{ id: string; label: string; ageSec: number; now?: string; session: string; model: string }>;
  waiting: Array<{ id: string; label: string; waitedSec: number; position: number; session: string; model: string }>;
}

/** Session blocks with a `max_parallel` profile key: group name -> limit. */
export type SessionLimits = Record<string, number>;

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
export function cockpitQueue(
  logDir: string,
  workers: WorkersConfig,
  now = Date.now(),
  owns: (s: { pid: number; started: string; id?: string }) => boolean = ownsPid
): { now: number; providers: QueueProvider[]; sessionMax: SessionLimits } {
  const caps: Record<string, number | undefined> = {};
  for (const name of Object.keys(workers.providers)) caps[name] = providerCap(workers, name);
  const byProvider = new Map<string, QueueProvider>();
  const row = (provider: string): QueueProvider => {
    let p = byProvider.get(provider);
    if (!p) {
      p = { provider, cap: caps[provider], running: [], waiting: [] };
      byProvider.set(provider, p);
    }
    return p;
  };
  const waited = (s: WorkerStatus): number => {
    const t = Date.parse((s.started ?? "").replace(" ", "T"));
    return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 1000)) : 0;
  };
  const sessionMax: SessionLimits = {};
  const statuses = loadStatuses(logDir);
  for (const s of statuses) {
    const max = s.sessionKey ? getProfile(s.sessionKey)?.max_parallel : undefined;
    if (max && (s.state === "queued" || (s.state === "running" && isLive(s, owns)))) sessionMax[sessionGroup(s)] = max;
  }
  for (const s of statuses) {
    if (s.state === "running" && isLive(s, owns)) row(s.provider).running.push({ id: s.id, label: s.label, ageSec: waited(s), now: s.last ? s.last.slice(0, 80) : undefined, session: sessionGroup(s), model: s.model });
  }
  for (const r of queueRows(logDir, caps)) {
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
  return { now, providers: [...byProvider.values()], sessionMax };
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
  if (req.method !== "GET") return send(405, "text/plain", "GET only"), true;
  if (url.pathname === "/cockpit") send(200, "text/html; charset=utf-8", COCKPIT_HTML);
  else if (url.pathname === "/cockpit/data") {
    try {
      const rows = readRows();
      send(200, "application/json", JSON.stringify(buildCockpitData(rows, parseWindow(url.searchParams.get("window")), Date.now(), namedSessionMap(rows, sessionMap, workerWindows), readPool(), configuredProviders())));
    } catch (e) {
      send(500, "application/json", JSON.stringify({ error: (e as Error).message }));
    }
  } else if (url.pathname === "/cockpit/system") {
    if (!system) return send(503, "application/json", '{"error":"system metrics not configured"}'), true;
    Promise.all([
      system.snapshot(parseWindow(url.searchParams.get("window"))),
      limits.get().catch((): ProviderLimits[] => []),
    ]).then(
      ([snap, ls]) => send(200, "application/json", JSON.stringify({ ...snap, servers: systemServers(ls) })),
      (e: Error) => send(500, "application/json", JSON.stringify({ error: e.message }))
    );
  } else if (url.pathname === "/cockpit/models") {
    currentInventory().then(
      (inv) => send(200, "application/json", JSON.stringify(inv)),
      (e: Error) => send(500, "application/json", JSON.stringify({ error: e.message }))
    );
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
    limits.get().then(
      (l) => send(200, "application/json", JSON.stringify({ now: Date.now(), limits: l })),
      (e: Error) => send(500, "application/json", JSON.stringify({ error: e.message }))
    );
  } else send(404, "text/plain", "not found");
  return true;
}
