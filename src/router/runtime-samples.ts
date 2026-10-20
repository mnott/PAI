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

import { execFile } from "node:child_process";
import { capacityOf, providerCap } from "../workers/capacity.js";
import { providerHostPort } from "../workers/local-provider.js";
import { isLoopbackProvider } from "../workers/run-env.js";
import { loadStatusesCached, isLive, type WorkerStatus } from "../workers/status.js";
import { ownerSessionName } from "../workers/scope.js";
import { poolSettings, readPoolState, type PoolSettings, type PoolState } from "../workers/pool.js";
import type { WorkersConfig } from "../workers/config.js";
import type { ModelInventory } from "../workers/model-inventory.js";
import type { SchedSnapshot } from "./scheduler.js";

/**
 * The fallback used when the config cannot be read. The policy values live in
 * the shipped defaults file (src/config/defaults/config.yaml, `router.samples`)
 * and reach the sampler through `loadConfig().router.samples` → `runtimeSampleSettings`.
 */
export interface RuntimeSampleSettings {
  /** Sampling cadence of the ring (the page polls /cockpit/models every 5 s too), ms. */
  sampleMs: number;
  /** Samples kept per runtime: 60 × 5 s = the last 5 minutes. */
  historyLen: number;
  /** An engine's own status endpoint must answer within this, ms; a slow engine is simply not reported. */
  engineStatusTimeoutMs: number;
  /** How old the card reading served from /cockpit/models may be before a new one is taken, ms. */
  cardReadingMaxAgeMs: number;
}

export const DEFAULT_RUNTIME_SAMPLES: RuntimeSampleSettings = { sampleMs: 5_000, historyLen: 60, engineStatusTimeoutMs: 1_000, cardReadingMaxAgeMs: 2_000 };

/** Merge a raw `router.samples` config block over the fallback; bad values fall back. */
export function runtimeSampleSettings(raw: unknown): RuntimeSampleSettings {
  const out = { ...DEFAULT_RUNTIME_SAMPLES };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  for (const k of ["sampleMs", "historyLen", "engineStatusTimeoutMs", "cardReadingMaxAgeMs"] as const) {
    const v = r[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = v;
  }
  return out;
}

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
  /** the process tree's RSS MB on the engine's port (the Memory tile's RAM number) */
  rssMb: number | null;
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
  /** GPU memory in use / total bytes (the engine's hardware reading, as Strata's monitor shows) */
  gpuMemUsed: number | null;
  gpuMemTotal: number | null;
  /** max context tokens (engine-reported) */
  maxContext: number | null;
  /** conversation tokens in use now: the running request, else the last one (Strata's context fill) */
  contextUsed: number | null;
}

/** The ring's last N samples, oldest first; nulls are gaps (failed probes). */
export type RuntimeHistory = Record<"decode" | "prefill" | "memoryMb" | "queued" | "pressurePct" | "reusedPct" | "gpuMemUsed" | "contextUsed", Array<number | null>>;

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
  /** the process tree's RSS MB on the engine's port (the Memory tile's RAM number) */
  rssMb: number | null;
  /** the engine's own live reading, when it reports one */
  engine: {
    decode: number | null;
    prefill: number | null;
    phase: string | null;
    parked: number | null;
    slots: number | null;
    reusedPct: number | null;
    /** decode of the last finished request (Strata's "Decode last request") */
    lastDecode: number | null;
    /** fresh prompt tokens / prompt ms of the last request (its prefill rate) */
    lastPrompt: number | null;
    lastReused: number | null;
    lastPromptMs: number | null;
    /** conversation tokens of the last request (context fill when idle) */
    lastUsed: number | null;
    /** GPU memory in use / total bytes (the engine's hardware reading) */
    gpuMemUsed: number | null;
    gpuMemTotal: number | null;
    /** max context tokens */
    maxContext: number | null;
    /** conversation tokens of the request running right now */
    liveUsed: number | null;
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
  /** the process tree's RSS MB on each engine's port (the Memory tile's RAM number) */
  rss?: Record<string, number | null>;
  /** the machine's total GPU memory bytes, when the engine's reading carries none (Metal recommended working set) */
  gpuMemTotalFallback?: number | null;
  /** the machine's memory pressure % (0-100) from the system monitor, for the Memory tile */
  pressurePct?: number | null;
  /** the sampler's policy values (router.samples); default when absent */
  settings?: RuntimeSampleSettings;
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

/** Strata's `metrics` payload → the engine's live reading; null for anything else or a failed probe.
 *  The fields mirror serve/web/app.js's Monitor: decode = the running request's `tok_s`, else the
 *  last request's `decode_tok_s`; prefill = `prefill_tok_s_mean` while busy, else the last request's
 *  fresh tokens / prompt_ms; the hardware section carries the GPU's in-use / total bytes; the context
 *  fill counts the running request's prompt + generated tokens, else the last request's. */
export function strataEngineMetrics(body: unknown): RuntimeLive["engine"] {
  if (!isStrataMetrics(body)) return null;
  const m = body as {
    engine?: { max_context?: number };
    live?: { state?: string; phase?: string; tok_s?: number; prefill_tok_s_mean?: number; queued?: number; prompt_tokens?: number; generated?: number };
    conversation_cache?: { parked?: number; slots?: number; prompt_tokens?: number; reused_tokens?: number };
    hardware?: { gpu_mem_used?: number; gpu_mem_total?: number };
    requests?: Array<{ decode_tok_s?: number; prompt_tokens?: number; reused?: number; prompt_ms?: number; output_tokens?: number }>;
  } | null;
  if (!m || typeof m !== "object") return null;
  const live = m.live ?? {};
  const cc = m.conversation_cache ?? {};
  const hw = m.hardware ?? {};
  const last = (m.requests ?? [])[0] ?? null;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const prompt = num(cc.prompt_tokens), reused = num(cc.reused_tokens);
  const state = typeof live.state === "string" ? live.state : null;
  // the same choices as serve/web/app.js's renderMonitor: the running request's tok_s while
  // generating, else the last request's decode_tok_s (0 is a reading, not a gap)
  const decode = state === "generating" ? num(live.tok_s) : last && last.decode_tok_s != null ? last.decode_tok_s : num(live.tok_s);
  const prefill = state && state !== "idle" ? num(live.prefill_tok_s_mean) : last && (last.prompt_ms ?? 0) > 0 ? Math.max(0, (last.prompt_tokens ?? 0) - (last.reused ?? 0)) / (last.prompt_ms! / 1000) : num(live.prefill_tok_s_mean);
  return {
    decode,
    prefill,
    phase: state,
    parked: num(cc.parked),
    slots: num(cc.slots),
    reusedPct: prompt && prompt > 0 && reused != null ? (reused / prompt) * 100 : null,
    lastDecode: num(last?.decode_tok_s),
    lastPrompt: num(last?.prompt_tokens),
    lastReused: num(last?.reused),
    lastPromptMs: num(last?.prompt_ms),
    lastUsed: last != null ? (last.prompt_tokens ?? 0) + (last.output_tokens ?? 0) : null,
    gpuMemUsed: num(hw.gpu_mem_used),
    gpuMemTotal: num(hw.gpu_mem_total),
    maxContext: num(m.engine?.max_context),
    liveUsed: state && state !== "idle" ? (live.prompt_tokens ?? 0) + (live.generated ?? 0) : null,
  };
}

/** One runtime's live view from the input; pure, so tests drive it directly. */
export function runtimeLive(rt: RuntimeSamplerInput["inventory"]["runtimes"][number], input: RuntimeSamplerInput): RuntimeLive {
  const { workers, sched, statuses, poolState, pool } = input;
  const engine = engineNameOf(rt, workers.providers);
  const live: RuntimeLive = {
    workers: [],
    queued: 0,
    cap: providerCap(workers, engine) ?? (rt.port != null ? capacityOf(workers.capacity).localDefaultCap : null),
    conversationSlots: workers.providers[engine]?.conversationSlots ?? null,
    sparesReady: 0,
    sparesConfig: pool.spares,
    rssMb: input.rss?.[engine] ?? null,
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
  const historyLen = input.settings?.historyLen ?? DEFAULT_RUNTIME_SAMPLES.historyLen;
  const runtimes = input.inventory.runtimes.map((rt) => {
    const live = runtimeLive(rt, input);
    const ring = (history[keyOf(rt)] ?? []).slice(-historyLen);
    const col = (k: keyof RuntimeSample) => ring.map((s) => s[k] ?? null);
    return {
      name: rt.name,
      status: rt.status,
      live,
      history: { decode: col("decode"), prefill: col("prefill"), memoryMb: col("memoryMb"), queued: col("queued"), pressurePct: col("pressurePct"), reusedPct: col("reusedPct"), gpuMemUsed: col("gpuMemUsed"), contextUsed: col("contextUsed") },
    };
  });
  return { at: input.now, runtimes };
}

/** One tick: a sample per running runtime (engine gaps stay null). */
export function sampleRuntimes(input: RuntimeSamplerInput, history: Record<string, RuntimeSample[]>, now: number): void {
  const historyLen = input.settings?.historyLen ?? DEFAULT_RUNTIME_SAMPLES.historyLen;
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
      rssMb: live.rssMb,
      gpuMemUsed: live.engine?.gpuMemUsed ?? null,
      gpuMemTotal: live.engine?.gpuMemTotal ?? input.gpuMemTotalFallback ?? null,
      maxContext: live.engine?.maxContext ?? null,
      contextUsed: live.engine?.liveUsed ?? live.engine?.lastUsed ?? null,
    };
    const ring = (history[keyOf(rt)] ??= []);
    ring.push(s);
    if (ring.length > historyLen) ring.splice(0, ring.length - historyLen);
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
  /** the process tree's RSS MB on a port (0 = not found) */
  rssMb: (port: number) => Promise<number>;
  /** the machine's total GPU memory bytes (Metal recommended working set), null when unknown */
  gpuTotalBytes: () => Promise<number | null>;
  now: () => number;
}

/**
 * Deps for a router process: the scheduler snapshot comes from the caller's
 * getter (the router passes its own `sharedScheduler()`), never from the
 * module-level singleton — a test importing this module must not touch the
 * router's scheduler.
 */
/**
 * The machine's total GPU memory bytes — the Metal recommended working set, the
 * same figure Strata's monitor shows as the VRAM total. One `sysctl` read; null
 * when it cannot be answered.
 */
export async function metalRecommendedWorkingSet(exec: (cmd: string, args: string[]) => Promise<string | null>): Promise<number | null> {
  const out = await exec("sysctl", ["-n", "hw.memsize"]);
  const n = out ? Number(out.trim()) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The engine status probes a fresh card reading needs: every running port is
 * asked for `/metrics` with a 1 s timeout, in parallel. A port remembered as
 * non-Strata is skipped; a failed probe is a null entry (never cached).
 */
export async function freshEngineReadings(
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

export function routerSamplerDeps(sched: () => SchedSnapshot | null, engineStatusTimeoutMs: () => number = () => DEFAULT_RUNTIME_SAMPLES.engineStatusTimeoutMs): SamplerDeps {
  const exec = (cmd: string, args: string[]): Promise<string | null> =>
    new Promise((resolve) => {
      try {
        execFile(cmd, args, { timeout: 2_000, maxBuffer: 1 << 20 }, (e, stdout) => resolve(e ? null : String(stdout)));
      } catch {
        resolve(null);
      }
    });
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
        const r = await fetch(url, { signal: AbortSignal.timeout(engineStatusTimeoutMs()) });
        return r.ok ? await r.json() : null;
      } catch {
        return null;
      }
    },
    async rssMb(port) {
      const { processTreeRssMb } = await import("../workers/model-inventory.js");
      const pid = ((await exec("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"])) ?? "").split("\n")[0];
      if (!pid) return 0;
      return processTreeRssMb(pid, exec);
    },
    gpuTotalBytes: () => metalRecommendedWorkingSet(exec),
    now: () => Date.now(),
  };
}

/** The fresh engine reading behind the card's current values (probes + RSS + the GPU total). */
export interface CardReading {
  engine: Record<string, RuntimeLive["engine"]>;
  rss: Record<string, number | null>;
  gpuTotalBytes: number | null;
  at: number;
}

/**
 * The router-side sampler: a 5 s tick that never blocks requests (disk reads
 * are cached, engine probes are 1 s and fire-and-forget). Returns the stop
 * function; the payload builder reads the ring it fills.
 */

export interface RuntimeSampler {
  tick: () => Promise<void>;
  payload: () => Promise<{ at: number; runtimes: unknown[] } | null>;
  /** the fresh engine reading behind the card's current values (cached at most 2 s) */
  cardReading: () => Promise<CardReading | null>;
  start: (ms?: number) => () => void;
}

export function createRuntimeSampler(
  deps: SamplerDeps,
  readConfig: () => WorkersConfig,
  logDir: () => string,
  /** machine memory pressure % used (system monitor); null/undefined = not reported */
  pressure: () => number | null = () => null,
  /** the sampler's policy values (router.samples); default when absent */
  settings: () => RuntimeSampleSettings = () => DEFAULT_RUNTIME_SAMPLES
): RuntimeSampler {
  const history: Record<string, RuntimeSample[]> = {};
  let last: { inventory: ModelInventory; engine: Record<string, RuntimeLive["engine"]>; at: number } | null = null;
  const dialects: EngineDialects = new Map();
  let ticking: Promise<void> | null = null;
  /** the card reading served from /cockpit/models: fresh engine probes, cached at most settings().cardReadingMaxAgeMs */
  let card: CardReading | null = null;
  let cardPending: Promise<CardReading | null> | null = null;
  /** the last reading in which an engine spoke; a failed probe is a gap, never a blank card */
  let lastEngine: Record<string, RuntimeLive["engine"]> = {};

  /** A fresh reading of the engines (1 s probes in parallel + the RSS tree of each port);
   *  served from cache while it is younger than settings().cardReadingMaxAgeMs. */
  const cardReading = async (): Promise<CardReading | null> => {
    if (card && deps.now() - card.at < settings().cardReadingMaxAgeMs) return card;
    if (cardPending) return cardPending;
    const startedAt = deps.now();
    const run = async (): Promise<CardReading | null> => {
      try {
        const inventory = await deps.inventory();
        if (!inventory) return card;
        const workers = readConfig();
        const engine = await freshEngineReadings({ inventory, workers }, deps.getJson, dialects);
        const rss: Record<string, number | null> = {};
        await Promise.all(
          inventory.runtimes
            .filter((rt) => rt.status !== "stopped" && rt.port != null)
            .map(async (rt) => {
              const mb = await deps.rssMb(rt.port!);
              rss[engineNameOf(rt, workers.providers)] = mb > 0 ? mb : null;
            })
        );
        const gpuTotalBytes = await deps.gpuTotalBytes();
        // stamp the cache with the time the reading started: a slow probe must not
        // make the next payload take another one
        card = { engine, rss, gpuTotalBytes, at: startedAt };
        if (Object.values(engine).some((e) => e != null)) lastEngine = engine;
      } catch {
        /* a failed reading keeps the previous one */
      }
      // every probe failed: keep the last reading that spoke (a failed probe is a
      // gap, never a blank card)
      if (!Object.values(card?.engine ?? {}).some((e) => e != null)) card = { engine: lastEngine, rss: card?.rss ?? {}, gpuTotalBytes: card?.gpuTotalBytes ?? null, at: startedAt };
      return card;
    };
    // the caller waits on the run itself; the cache is stamped with the time the
    // reading started, so a slow probe never makes the next payload take another
    cardPending = run();
    void cardPending.finally(() => {
      cardPending = null;
    });
    return cardPending;
  };

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
          { inventory, sched: deps.sched(), statuses: deps.statuses(logDir()), poolState: deps.poolState(logDir()), pool: poolSettings(workers), workers, engine, pressurePct: pressure(), settings: settings(), now: last.at },
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
    cardReading,
    payload: async () => {
      if (!last) await tick();
      if (!last) return null;
      // the card's current values come from a fresh engine reading (cached ≤ 2 s);
      // the ring stays for the sparklines only
      const reading = await cardReading();
      return buildRuntimePayload(
        {
          inventory: last.inventory,
          sched: deps.sched(),
          statuses: deps.statuses(logDir()),
          poolState: deps.poolState(logDir()),
          pool: poolSettings(readConfig()),
          workers: readConfig(),
          engine: reading?.engine ?? last.engine,
          rss: reading?.rss,
          gpuMemTotalFallback: reading?.gpuTotalBytes ?? null,
          pressurePct: pressure(),
          settings: settings(),
          now: deps.now(),
        },
        history
      );
    },
    start: (ms = settings().sampleMs) => {
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
