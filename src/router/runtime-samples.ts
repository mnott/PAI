/**
 * runtime-samples.ts — the cockpit's live view of each running model runtime.
 *
 * The inventory (model-inventory.ts) answers every 30 s what runtimes exist
 * and who uses them; it cannot answer how fast an engine decodes or how many
 * workers sit on it right now. This sampler fills that gap for the cockpit's
 * Models cards:
 *   - every 5 s it reads the router's own live sources (the request scheduler,
 *     the worker status files, the pool state) — no network, no subprocesses,
 *     so a tick cannot block a request;
 *   - for engines that speak their own status dialect (Strata's `metrics`) it
 *     probes with a 1 s timeout; a failure leaves a gap (null) instead of a
 *     wrong number;
 *   - each running runtime keeps a ring of the last 60 samples, which
 *     /cockpit/models returns as `history` for the page's sparklines.
 *
 * The sampler runs inside the router process (the scheduler lives there);
 * `startRuntimeSampler()` is called by the router command, and tests drive
 * `sampleRuntimes()` directly.
 */

import { providerCap, LOCAL_DEFAULT_CAP } from "../workers/capacity.js";
import { providerHostPort } from "../workers/local-provider.js";
import { isLoopbackProvider } from "../workers/run-env.js";
import { loadStatusesCached, isLive, type WorkerStatus } from "../workers/status.js";
import { ownerSessionName } from "../workers/scope.js";
import { poolSettings, readPoolState, type PoolSettings, type PoolState } from "../workers/pool.js";
import type { WorkersConfig } from "../workers/config.js";
import type { ModelInventory } from "../workers/model-inventory.js";
import type { SchedSnapshot } from "./scheduler.js";

/** Sampling cadence of the ring (the page polls /cockpit/models every 5 s too). */
export const RUNTIME_SAMPLE_MS = 5_000;
/** Samples kept per runtime: 60 × 5 s = the last 5 minutes. */
export const RUNTIME_HISTORY_LEN = 60;
/** An engine's own status endpoint must answer within this; a slow engine is simply not reported. */
export const ENGINE_STATUS_TIMEOUT_MS = 1_000;

export interface RuntimeSample {
  /** epoch ms of the sample */
  t: number;
  /** decode tokens/s (engine-reported; null = gap) */
  decode: number | null;
  /** prefill tokens/s */
  prefill: number | null;
  /** resident footprint MB (the inventory's, refreshed every 30 s) */
  memoryMb: number | null;
  /** requests waiting on this engine in the router */
  queued: number | null;
  /** workers holding a slot on this engine right now */
  running: number | null;
  /** conversation-cache slots the engine holds (parked conversations) */
  parked: number | null;
  /** conversation-cache slots the engine has */
  slots: number | null;
  /** % of prompt tokens served from the conversation cache since engine start */
  reusedPct: number | null;
  /** engine phase, e.g. "idle" / "generating" */
  phase: string | null;
  /** machine memory pressure % used (system monitor) */
  pressurePct: number | null;
}

/** The ring's last N samples, oldest first; nulls are gaps (failed probes). */
export type RuntimeHistory = Record<"decode" | "prefill" | "memoryMb" | "queued" | "pressurePct", Array<number | null>>;

export interface RuntimeLive {
  /** workers with a live slot on this engine, by the session that started them */
  workers: Array<{ id: string; label: string; session: string; state: "running" | "queued" }>;
  /** requests waiting in the router's scheduler for this engine */
  queued: number;
  /** admission cap (capacity.ts, the same rule the gate applies); null = unlimited */
  cap: number | null;
  /** conversation-cache slots configured for the engine */
  conversationSlots: number | null;
  /** spares ready for this engine's provider (pool state) */
  sparesReady: number;
  /** spares configured per (repo, provider) key */
  sparesConfig: number;
  /** the engine's own live reading, when it reports one */
  engine: {
    decode: number | null;
    prefill: number | null;
    phase: string | null;
    parked: number | null;
    slots: number | null;
    reusedPct: number | null;
  } | null;
}

export interface RuntimeSamplerInput {
  inventory: ModelInventory;
  sched: SchedSnapshot | null;
  /** live worker status files (loadStatusesCached) */
  statuses: WorkerStatus[];
  poolState: PoolState | null;
  pool: PoolSettings;
  workers: WorkersConfig;
  /** engine name → live reading from the engine's own status endpoint (null = failed probe) */
  engine: Record<string, RuntimeLive["engine"]>;
  /** the machine's memory pressure % (0-100) from the system monitor, for the Memory tile */
  pressurePct?: number | null;
  now: number;
}

/** The scheduler engine name of a runtime: the enabled loopback provider on its port, else the runtime name. */
export function engineNameOf(rt: { name: string; port?: number; kind: string }, providers: WorkersConfig["providers"]): string {
  if (rt.port != null && rt.kind !== "ollama" && rt.kind !== "docker-model-runner") {
    for (const [name, p] of Object.entries(providers)) {
      if (!p.enabled || !isLoopbackProvider(p)) continue;
      const hp = providerHostPort(p);
      if (hp && hp.port === rt.port) return name;
    }
  }
  return rt.name;
}

/** The runtime a live worker runs on: the provider's loopback port, else the provider name. */
function runtimeKeyOf(s: WorkerStatus, workers: WorkersConfig): string {
  const p = workers.providers[s.provider];
  if (p && isLoopbackProvider(p)) {
    const hp = providerHostPort(p);
    if (hp) return `port:${hp.port}`;
  }
  return `name:${s.provider}`;
}

const keyOf = (rt: { name: string; port?: number }): string => (rt.port != null ? `port:${rt.port}` : `name:${rt.name}`);

/** Does a `/metrics` body speak Strata's dialect (a `live` or `conversation_cache` section)? */
export function isStrataMetrics(body: unknown): boolean {
  const m = body as { live?: unknown; conversation_cache?: unknown } | null;
  return !!m && typeof m === "object" && (typeof m.live === "object" || typeof m.conversation_cache === "object");
}

/** Strata's `metrics` payload → the engine's live reading; null for anything else or a failed probe. */
export function strataEngineMetrics(body: unknown): RuntimeLive["engine"] {
  if (!isStrataMetrics(body)) return null;
  const m = body as {
    live?: { state?: string; phase?: string; tok_s?: number; prefill_tok_s_mean?: number; queued?: number };
    conversation_cache?: { parked?: number; slots?: number; prompt_tokens?: number; reused_tokens?: number };
  } | null;
  if (!m || typeof m !== "object") return null;
  const live = m.live ?? {};
  const cc = m.conversation_cache ?? {};
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const prompt = num(cc.prompt_tokens), reused = num(cc.reused_tokens);
  return {
    decode: num(live.tok_s),
    prefill: num(live.prefill_tok_s_mean),
    phase: typeof live.state === "string" ? live.state : null,
    parked: num(cc.parked),
    slots: num(cc.slots),
    reusedPct: prompt && prompt > 0 && reused != null ? (reused / prompt) * 100 : null,
  };
}

/** One runtime's live view from the input; pure, so tests drive it directly. */
export function runtimeLive(rt: RuntimeSamplerInput["inventory"]["runtimes"][number], input: RuntimeSamplerInput): RuntimeLive {
  const { workers, sched, statuses, poolState, pool } = input;
  const engine = engineNameOf(rt, workers.providers);
  const live: RuntimeLive = {
    workers: [],
    queued: 0,
    cap: providerCap(workers, engine) ?? (rt.port != null ? LOCAL_DEFAULT_CAP : null),
    conversationSlots: workers.providers[engine]?.conversationSlots ?? null,
    sparesReady: 0,
    sparesConfig: pool.spares,
    engine: input.engine[engine] ?? null,
  };
  const key = keyOf(rt);
  for (const s of statuses) {
    if (s.provider !== engine && runtimeKeyOf(s, workers) !== key) continue;
    if (!isLive(s)) continue;
    live.workers.push({ id: s.id, label: s.label, session: ownerSessionName(s), state: s.state === "queued" ? "queued" : "running" });
  }
  const e = sched?.engines[engine];
  // router scheduler's waiting requests + workers waiting on the admission gate
  live.queued = (e ? Object.values(e.queued).reduce((a, n) => a + n, 0) : 0) + live.workers.filter((w) => w.state === "queued").length;
  if (poolState?.spares) live.sparesReady = poolState.spares.filter((sp) => sp.provider === engine && sp.state === "ready").length;
  return live;
}

/** The whole payload: live per runtime + the ring's history, oldest sample first. */
export function buildRuntimePayload(input: RuntimeSamplerInput, history: Record<string, RuntimeSample[]>) {
  const runtimes = input.inventory.runtimes.map((rt) => {
    const live = runtimeLive(rt, input);
    const ring = (history[keyOf(rt)] ?? []).slice(-RUNTIME_HISTORY_LEN);
    const col = (k: keyof RuntimeSample) => ring.map((s) => s[k] ?? null);
    return {
      name: rt.name,
      status: rt.status,
      live,
      history: { decode: col("decode"), prefill: col("prefill"), memoryMb: col("memoryMb"), queued: col("queued"), pressurePct: col("pressurePct") },
    };
  });
  return { at: input.now, runtimes };
}

/** One tick: a sample per running runtime (engine gaps stay null). */
export function sampleRuntimes(input: RuntimeSamplerInput, history: Record<string, RuntimeSample[]>, now: number): void {
  for (const rt of input.inventory.runtimes) {
    if (rt.status === "stopped") continue;
    const live = runtimeLive(rt, input);
    const memory = rt.models.reduce((a, m) => a + (m.memoryMb ?? 0), 0);
    const s: RuntimeSample = {
      t: now,
      decode: live.engine?.decode ?? null,
      prefill: live.engine?.prefill ?? null,
      memoryMb: memory > 0 ? memory : null,
      queued: live.queued,
      running: live.workers.filter((w) => w.state === "running").length,
      parked: live.engine?.parked ?? null,
      slots: live.engine?.slots ?? null,
      reusedPct: live.engine?.reusedPct ?? null,
      phase: live.engine?.phase ?? null,
      pressurePct: input.pressurePct ?? null,
    };
    const ring = (history[keyOf(rt)] ??= []);
    ring.push(s);
    if (ring.length > RUNTIME_HISTORY_LEN) ring.splice(0, ring.length - RUNTIME_HISTORY_LEN);
  }
}

/** Per-port result of the dialect detection: true = answers Strata's metrics, false = answers something else. A failed probe is never cached. */
export type EngineDialects = Map<number, boolean>;

/**
 * The engine status probes the tick needs, 1 s timeout each. An engine is
 * identified by what it answers, not by the inventory kind (Strata sits behind
 * "openai-server" providers): every running port is asked for `/metrics` once;
 * a Strata answer is probed on every tick from then on, any other answer is
 * remembered per port and not asked again.
 */
export async function probeEngines(
  input: { inventory: ModelInventory; workers: WorkersConfig },
  getJson: (url: string) => Promise<unknown | null>,
  dialects: EngineDialects = new Map()
): Promise<Record<string, RuntimeLive["engine"]>> {
  const out: Record<string, RuntimeLive["engine"]> = {};
  await Promise.all(
    input.inventory.runtimes
      .filter((rt) => rt.status === "running" && rt.port != null && rt.kind !== "ollama" && rt.kind !== "docker-model-runner" && dialects.get(rt.port) !== false)
      .map(async (rt) => {
        const engine = engineNameOf(rt, input.workers.providers);
        const p = input.workers.providers[engine];
        const host = p && isLoopbackProvider(p) ? providerHostPort(p)?.host : undefined;
        const body = await getJson(`http://${host && host.includes(":") ? `[${host}]` : host || "127.0.0.1"}:${rt.port}/metrics`);
        if (body != null && rt.kind !== "strata") dialects.set(rt.port!, isStrataMetrics(body));
        if (body != null && !isStrataMetrics(body)) return;
        out[engine] = strataEngineMetrics(body);
      })
  );
  return out;
}

/** Everything a tick reads from disk/network; tests inject fakes. */
export interface SamplerDeps {
  /** the cached daemon inventory, else a fresh read-only probe */
  inventory: () => Promise<ModelInventory | null>;
  /** the router's scheduler snapshot (null outside the router process) */
  sched: () => SchedSnapshot | null;
  statuses: (logDir: string) => WorkerStatus[];
  poolState: (logDir: string) => PoolState | null;
  getJson: (url: string) => Promise<unknown | null>;
  now: () => number;
}

/**
 * Deps for a router process: the scheduler snapshot comes from the caller's
 * getter (the router passes its own `sharedScheduler()`), never from the
 * module-level singleton — a test importing this module must not touch the
 * router's scheduler.
 */
export function routerSamplerDeps(sched: () => SchedSnapshot | null): SamplerDeps {
  return {
    inventory: async () => {
      const { currentInventory } = await import("../workers/model-inventory.js");
      return currentInventory();
    },
    sched,
    statuses: (logDir) => loadStatusesCached(logDir),
    poolState: (logDir) => readPoolState(logDir),
    async getJson(url) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(ENGINE_STATUS_TIMEOUT_MS) });
        return r.ok ? await r.json() : null;
      } catch {
        return null;
      }
    },
    now: () => Date.now(),
  };
}

/**
 * The router-side sampler: a 5 s tick that never blocks requests (disk reads
 * are cached, engine probes are 1 s and fire-and-forget). Returns the stop
 * function; the payload builder reads the ring it fills.
 */
export interface RuntimeSampler {
  tick: () => Promise<void>;
  payload: () => Promise<{ at: number; runtimes: unknown[] } | null>;
  start: (ms?: number) => () => void;
}

export function createRuntimeSampler(
  deps: SamplerDeps,
  readConfig: () => WorkersConfig,
  logDir: () => string,
  /** machine memory pressure % used (system monitor); null/undefined = not reported */
  pressure: () => number | null = () => null
): RuntimeSampler {
  const history: Record<string, RuntimeSample[]> = {};
  let last: { inventory: ModelInventory; engine: Record<string, RuntimeLive["engine"]>; at: number } | null = null;
  const dialects: EngineDialects = new Map();
  let ticking: Promise<void> | null = null;

  const tick = async (): Promise<void> => {
    if (ticking) return ticking;
    ticking = (async () => {
      try {
        const inventory = await deps.inventory();
        if (!inventory) return;
        const workers = readConfig();
        const engine = await probeEngines({ inventory, workers }, deps.getJson, dialects);
        last = { inventory, engine, at: deps.now() };
        sampleRuntimes(
          { inventory, sched: deps.sched(), statuses: deps.statuses(logDir()), poolState: deps.poolState(logDir()), pool: poolSettings(workers), workers, engine, pressurePct: pressure(), now: last.at },
          history,
          last.at
        );
      } catch {
        /* a failed tick leaves the last payload and the ring as they are */
      }
    })();
    try {
      await ticking;
    } finally {
      ticking = null;
    }
  };

  return {
    tick,
    payload: async () => {
      if (!last) await tick();
      if (!last) return null;
      return buildRuntimePayload(
        {
          inventory: last.inventory,
          sched: deps.sched(),
          statuses: deps.statuses(logDir()),
          poolState: deps.poolState(logDir()),
          pool: poolSettings(readConfig()),
          workers: readConfig(),
          engine: last.engine,
          pressurePct: pressure(),
          now: deps.now(),
        },
        history
      );
    },
    start: (ms = RUNTIME_SAMPLE_MS) => {
      void tick();
      const timer = setInterval(() => void tick(), ms);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}

/** The scheduler source of the live sampler: the router's own scheduler in production. */
export function schedSourceFrom(get: () => SchedSnapshot | null): () => SchedSnapshot | null {
  return get;
}
