import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  RUNTIME_HISTORY_LEN,
  buildRuntimePayload,
  createRuntimeSampler,
  engineNameOf,
  probeEngines,
  runtimeLive,
  sampleRuntimes,
  strataEngineMetrics,
  type RuntimeSample,
  type RuntimeSamplerInput,
} from "./runtime-samples.js";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { COCKPIT_HTML } from "./cockpit-page.js";
import { handleCockpit, setRuntimeSampler } from "./cockpit.js";
import type { ModelInventory } from "../workers/model-inventory.js";
import type { WorkersConfig, WorkerProvider } from "../workers/config.js";
import type { WorkerStatus } from "../workers/status.js";
import type { SchedSnapshot } from "./scheduler.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function provider(raw: Record<string, unknown>): WorkerProvider {
  return {
    enabled: true,
    protocol: "anthropic",
    baseUrl: "http://127.0.0.1:8035",
    keyFile: null,
    models: { default: "m" },
    env: {},
    ...raw,
  } as WorkerProvider;
}

function workersConfig(providers: Record<string, WorkerProvider>, poolSpares = 1): WorkersConfig {
  return {
    enabled: true,
    active: null,
    providers,
    classes: {},
    mcpSets: {},
    capabilities: {},
    pane: { enabled: false, fontSize: 12 },
    logDir: "/tmp/pai-test-workers",
    routing: { order: [] },
    tree: {},
    supervision: { pointer: false, push: "harness", stallMinutes: 10 },
    pool: { enabled: true, maxSlots: 3, idleSecs: 900, port: 8798, native: true, spares: poolSpares },
    cacheKeepaliveSecs: 0,
    defaultMaxMinutes: 60,
    waitAlarmMinutes: 120,
    stagger: {},
    capacity: { enabled: true },
    localIdle: { enabled: true, gpuBelowPct: 10, minutes: 2, backoffMinutes: 10 },
    noBrowserByDefault: false,
    gcOlderThanHours: 24,
    worktreesMaxGb: 50,
    reaper: true,
    caveman: false,
    fallback: null,
    nativeModels: { default: "m" },
  } as unknown as WorkersConfig;
}

const inventory: ModelInventory = {
  at: "2026-10-20T10:00:00.000Z",
  duplicates: [],
  runtimes: [
    { name: "gyro-m", kind: "strata", status: "running", port: 8035, models: [{ model: "flash-next", kind: "coding", loaded: true, memoryMb: 50000, usedBy: [] }], users: ["worker:w1"] },
    { name: "ollama", kind: "ollama", status: "running", port: 11434, models: [{ model: "arctic", kind: "embedding", loaded: true, memoryMb: 600, usedBy: [] }], users: [] },
    { name: "coder", kind: "strata", status: "stopped", port: 8034, models: [], users: [] },
  ],
};

const sched: SchedSnapshot = {
  at: 1,
  engines: { "gyro-m": { inflight: { session: "PAI", worker: "w1", sinceMs: 5 }, queued: { PAI: 2 }, counters: {} } },
  workers: {},
};

function status(over: Partial<WorkerStatus>): WorkerStatus {
  // the id encodes this process's spawn time, so ownsPid() accepts the pid without a `ps` match on `started`
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const id = `20261020-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${process.pid}`;
  return { id, pid: process.pid, label: "fix-x", cwd: "/x", term: "", provider: "gyro-m", model: "flash-next", state: "running", started: "2026-10-20 10:00:00", updated: "", turns: 1, tools: 0, last: "", rc: null, secs: 1, session: { id: "u", name: "PAI" }, ...over } as WorkerStatus;
}

function input(over: Partial<RuntimeSamplerInput> = {}): RuntimeSamplerInput {
  return {
    inventory,
    sched,
    statuses: [status({})],
    poolState: { hostPid: 1, port: 8798, startedAt: "", updatedAt: "", slots: [], tasksServed: 0, tokensCarried: 0, spares: [{ id: "s1", repo: "/r", provider: "gyro-m", model: "flash-next", dir: "/r/wt", branch: "b", base: "h", pid: 9, createdAt: "", state: "ready" }] },
    pool: { enabled: true, maxSlots: 3, idleSecs: 900, port: 8798, native: true, spares: 1, idleKillSec: 1800, continuation: false },
    workers: workersConfig({ "gyro-m": provider({ baseUrl: "http://127.0.0.1:8035", conversationSlots: 4 }), ollama: provider({ baseUrl: "http://127.0.0.1:11434" }) }),
    engine: { "gyro-m": { decode: 73.4, prefill: 715, phase: "idle", parked: 2, slots: 4, reusedPct: 90, lastDecode: 73.4, lastPrompt: null, lastReused: null, lastPromptMs: null, lastUsed: null, gpuMemUsed: null, gpuMemTotal: null, maxContext: null, liveUsed: null } },
    now: 1000,
    ...over,
  };
}

describe("engineNameOf", () => {
  it("maps a runtime to the enabled loopback provider on its port, else keeps the runtime name", () => {
    const providers = { "gyro-m": provider({ baseUrl: "http://127.0.0.1:8035" }), off: { ...provider({ baseUrl: "http://127.0.0.1:8035" }), enabled: false } };
    expect(engineNameOf({ name: "gyro-m", port: 8035, kind: "strata" }, providers)).toBe("gyro-m");
    expect(engineNameOf({ name: "ollama", port: 11434, kind: "ollama" }, providers)).toBe("ollama");
    expect(engineNameOf({ name: "other", port: 9999, kind: "strata" }, providers)).toBe("other");
  });
});

describe("strataEngineMetrics", () => {
  it("reads decode, prefill, phase and the conversation cache from Strata's metrics payload", () => {
    const e = strataEngineMetrics({
      engine: { max_context: 262144 },
      live: { state: "generating", phase: "draft", tok_s: 71.2, prefill_tok_s_mean: 800, prompt_tokens: 150000, generated: 5000 },
      conversation_cache: { parked: 3, slots: 8, prompt_tokens: 1000, reused_tokens: 250 },
      hardware: { gpu_mem_used: 45576978432, gpu_mem_total: 115448725504 },
      requests: [{ decode_tok_s: 50.9, prompt_tokens: 43884, reused: 42819, prompt_ms: 1828.5, output_tokens: 120 }],
    });
    expect(e).toEqual({
      decode: 71.2, prefill: 800, phase: "generating", parked: 3, slots: 8, reusedPct: 25,
      lastDecode: 50.9, lastPrompt: 43884, lastReused: 42819, lastPromptMs: 1828.5, lastUsed: 44004,
      gpuMemUsed: 45576978432, gpuMemTotal: 115448725504, maxContext: 262144, liveUsed: 155000,
    });
  });
  it("idle falls back to the last request, as Strata's monitor does: Decode last request, prefill from fresh tokens / prompt_ms, context from the last request", () => {
    const e = strataEngineMetrics({
      engine: { max_context: 262144 },
      live: { state: "idle", tok_s: null, prefill_tok_s_mean: null },
      conversation_cache: {},
      hardware: { gpu_mem_used: 45576978432, gpu_mem_total: 115448725504 },
      requests: [{ decode_tok_s: 78.0, prompt_tokens: 155000, reused: 150000, prompt_ms: 5000, output_tokens: 500 }],
    });
    expect(e?.decode).toBe(78.0);
    expect(e?.prefill).toBe(1000); // (155000 - 150000) / 5 s
    expect(e?.lastUsed).toBe(155500);
    expect(e?.liveUsed).toBeNull();
  });
  it("a failed probe or a payload without fields is null / nulls, never a crash", () => {
    expect(strataEngineMetrics(null)).toBeNull();
    expect(strataEngineMetrics({})).toBeNull(); // not Strata's dialect
    expect(strataEngineMetrics({ live: {} })).toEqual({
      decode: null, prefill: null, phase: null, parked: null, slots: null, reusedPct: null,
      lastDecode: null, lastPrompt: null, lastReused: null, lastPromptMs: null, lastUsed: null,
      gpuMemUsed: null, gpuMemTotal: null, maxContext: null, liveUsed: null,
    });
  });
});

describe("runtimeLive", () => {
  it("workers, queued, cap, slots and ready spares for the engine's runtime", () => {
    const rt = inventory.runtimes[0]!;
    const live = runtimeLive(rt, input());
    expect(live.workers.length).toBe(1);
    expect(live.workers[0]!.label).toBe("fix-x");
    expect(live.workers[0]!.session).toBe("PAI");
    expect(live.workers[0]!.state).toBe("running");
    expect(live.queued).toBe(2);
    expect(live.cap).toBe(1); // local default cap 1, below the conversationSlots-1 limit of 3
    expect(live.conversationSlots).toBe(4);
    expect(live.sparesReady).toBe(1);
    expect(live.engine?.decode).toBe(73.4);
    expect(live.rssMb).toBeNull();
  });
  it("the RSS reading lands on the runtime's live object", () => {
    const live = runtimeLive(inventory.runtimes[0]!, input({ rss: { "gyro-m": 36148 } }));
    expect(live.rssMb).toBe(36148);
  });
  it("a runtime with no provider behind it keeps its own name and no workers", () => {
    const live = runtimeLive(inventory.runtimes[1]!, input({ statuses: [] }));
    expect(live.workers).toEqual([]);
    expect(live.queued).toBe(0);
    expect(live.engine).toBeNull();
  });
});

describe("sampleRuntimes + payload", () => {
  it("one sample per running runtime; stopped ones get no ring; a failed engine probe leaves null gaps", () => {
    const history: Record<string, RuntimeSample[]> = {};
    sampleRuntimes(input({ engine: { "gyro-m": null } }), history, 1000);
    expect(Object.keys(history).sort()).toEqual(["port:11434", "port:8035"]);
    expect(history["port:8035"]![0]!.decode).toBeNull();
    expect(history["port:8035"]![0]!.queued).toBe(2);
    expect(history["port:8035"]![0]!.running).toBe(1);
    expect(history["port:8035"]![0]!.memoryMb).toBe(50000);
    expect(history["port:11434"]![0]!.memoryMb).toBe(600);
    expect(history["port:11434"]![0]!.pressurePct).toBeNull();
  });
  it("the ring keeps the last 60 samples and the payload returns the columns oldest first", () => {
    const history: Record<string, RuntimeSample[]> = {};
    for (let i = 0; i < RUNTIME_HISTORY_LEN + 10; i++) sampleRuntimes(input(), history, 1000 + i * 5000);
    expect(history["port:8035"]!.length).toBe(RUNTIME_HISTORY_LEN);
    const p = buildRuntimePayload(input(), history) as { at: number; runtimes: Array<{ name: string; history: { decode: Array<number | null> } }> };
    const g = p.runtimes.find((r) => r.name === "gyro-m")!;
    expect(g.history.decode.length).toBe(RUNTIME_HISTORY_LEN);
    expect(g.history.decode[0]).toBe(73.4);
    const stopped = p.runtimes.find((r) => r.name === "coder")!;
    expect(stopped.history.decode).toEqual([]);
  });
});

describe("probeEngines", () => {
  it("probes only running strata runtimes with a 1 s-budgeted getJson; a failure is a null entry", async () => {
    const urls: string[] = [];
    const out = await probeEngines(
      { inventory, workers: workersConfig({ "gyro-m": provider({ baseUrl: "http://127.0.0.1:8035" }) }) },
      async (url) => {
        urls.push(url);
        return url.includes("8035") ? { live: { state: "idle", tok_s: 0 }, conversation_cache: {} } : null;
      }
    );
    expect(urls).toEqual(["http://127.0.0.1:8035/metrics"]);
    expect(out["gyro-m"]?.phase).toBe("idle");
    expect(out["coder"]).toBeUndefined();
  });
});

describe("Strata behind an openai-server runtime", () => {
  const openai: ModelInventory = {
    ...inventory,
    runtimes: [{ name: "gyro-m", kind: "openai-server", status: "running", port: 8035, models: [{ model: "m", kind: "coding", loaded: true, memoryMb: 100, usedBy: [] }], users: [] }],
  };
  const cfg = () => workersConfig({ "gyro-m": provider({ baseUrl: "http://127.0.0.1:8035", maxConcurrent: 4, conversationSlots: 4 }) });

  it("is probed by its dialect; a non-Strata port is asked once and remembered", async () => {
    const urls: string[] = [];
    const dialects = new Map<number, boolean>();
    const strata = async (u: string) => (urls.push(u), { live: { state: "idle", tok_s: 5 } });
    expect((await probeEngines({ inventory: openai, workers: cfg() }, strata, dialects))["gyro-m"]?.decode).toBe(5);
    expect(dialects.get(8035)).toBe(true);
    const plain = new Map<number, boolean>();
    const other = async (u: string) => (urls.push(u), { object: "list" });
    expect(await probeEngines({ inventory: openai, workers: cfg() }, other, plain)).toEqual({});
    await probeEngines({ inventory: openai, workers: cfg() }, other, plain);
    expect(urls.length).toBe(2); // 1 strata + 1 plain; the second plain tick skipped
  });

  it("a failed probe still yields live with scheduler, worker, pool and cap fields; history grows per tick", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-runtime-samples-"));
    dirs.push(dir);
    let t = 0;
    const sampler = createRuntimeSampler(
      {
        inventory: async () => openai,
        sched: () => sched,
        statuses: () => [status({}), status({ state: "queued", label: "w2" })],
        poolState: () => input().poolState,
        getJson: async () => null,
        rssMb: async () => 0,
        gpuTotalBytes: async () => null,
        now: () => (t += 5000),
      },
      cfg,
      () => dir
    );
    await sampler.tick();
    await sampler.tick();
    const p = (await sampler.payload()) as { runtimes: Array<{ live: { workers: Array<{ state: string }>; queued: number; cap: number | null; sparesReady: number; engine: unknown }; history: { queued: unknown[] } }> };
    const g = p.runtimes[0]!;
    expect(g.live.engine).toBeNull();
    expect(g.live.workers.map((w) => w.state)).toEqual(["running", "queued"]);
    expect(g.live.cap).toBe(3); // conversationSlots-1
    expect(g.live.queued).toBe(3); // 2 in the router scheduler + 1 waiting on the admission gate
    expect(g.live.sparesReady).toBe(1);
    expect(g.history.queued.length).toBe(2);
  });

  it("the page flattens each runtime's live object and history (workers, cap, engine)", () => {
    expect(COCKPIT_HTML).toContain("Object.assign({},l.live,{history:l.history})");
  });

  it("the payload's current values come from a fresh reading, not the ring's last sample; the reading is cached ≤ 2 s", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-runtime-samples-"));
    dirs.push(dir);
    let t = 0;
    let probes = 0;
    let speed = 78.0;
    const sampler = createRuntimeSampler(
      {
        inventory: async () => openai,
        sched: () => sched,
        statuses: () => [],
        poolState: () => null,
        getJson: async () => {
          probes++;
          return { live: { state: "generating", tok_s: speed, prefill_tok_s_mean: 900, prompt_tokens: 155000, generated: 5000 }, conversation_cache: { parked: 1, slots: 4 }, engine: { max_context: 262144 }, hardware: { gpu_mem_used: 45576978432, gpu_mem_total: 115448725504 }, requests: [{ decode_tok_s: 71.1, prompt_tokens: 1000, output_tokens: 10 }] };
        },
        rssMb: async () => 36148,
        gpuTotalBytes: async () => 137438953472,
        now: () => t,
      },
      cfg,
      () => dir
    );
    await sampler.tick(); // the ring's sample carries the tick's probe (78.0)
    const p1 = (await sampler.payload()) as { runtimes: Array<{ name: string; live: { engine: { decode: number | null }, rssMb?: number | null }; history: { decode: Array<number | null> } }> };
    const g = p1.runtimes.find((r) => r.name === "gyro-m")!;
    expect(g.live.engine?.decode).toBe(78.0);
    expect(g.live.rssMb).toBe(36148);
    expect(g.history.decode.length).toBe(1); // the ring stays for the sparklines only
    expect(probes).toBe(2); // the tick's probe + the payload's fresh reading
    const probesAfterFresh = probes;
    await sampler.payload(); // within the 2 s cache: no new probe
    expect(probes).toBe(probesAfterFresh);
    // the engine changes; the card must show the new value, not the ring's last sample
    speed = 91.5;
    t += 2000; // past the reading cache: a fresh probe
    const p2 = (await sampler.payload()) as { runtimes: Array<{ name: string; live: { engine: { decode: number | null } } }> };
    expect(p2.runtimes.find((r) => r.name === "gyro-m")!.live.engine.decode).toBe(91.5);
    expect(probes).toBe(3);
  });

  it("a failed fresh reading falls back to the tick's last reading, never a blank card", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-runtime-samples-"));
    dirs.push(dir);
    let ok = true;
    let t = 0;
    const sampler = createRuntimeSampler(
      {
        inventory: async () => openai,
        sched: () => sched,
        statuses: () => [],
        poolState: () => null,
        getJson: async () => (ok ? { live: { state: "idle", tok_s: 0 }, conversation_cache: {} } : null),
        rssMb: async () => 0,
        gpuTotalBytes: async () => null,
        now: () => t,
      },
      cfg,
      () => dir
    );
    t = 1000;
    await sampler.tick();
    t = 1000;
    const p0 = (await sampler.payload()) as { runtimes: Array<{ live: { engine: unknown } }> };
    expect(p0.runtimes[0]!.live.engine).not.toBeNull(); // the first reading succeeded
    ok = false;
    t = 3001; // past the reading cache: the fresh probe now fails
    const p = (await sampler.payload()) as { runtimes: Array<{ live: { engine: unknown } }> };
    expect(p.runtimes[0]!.live.engine).not.toBeNull(); // the last good reading, not null
  });
});

describe("createRuntimeSampler", () => {
  it("ticks fill the ring and the payload carries live + history per runtime; a failing tick keeps the last payload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-runtime-samples-"));
    dirs.push(dir);
    const logDir = join(dir, "logs");
    let fail = false;
    const sampler = createRuntimeSampler(
      {
        inventory: async () => {
          if (fail) throw new Error("inventory down");
          return inventory;
        },
        sched: () => sched,
        statuses: () => [status({})],
        poolState: () => null,
        getJson: async () => null,
        rssMb: async () => 0,
        gpuTotalBytes: async () => null,
        now: () => 2000,
      },
      () => workersConfig({ "gyro-m": provider({ baseUrl: "http://127.0.0.1:8035" }) }),
      () => logDir,
      () => 62
    );
    await sampler.tick();
    const p = (await sampler.payload()) as { at: number; runtimes: Array<{ name: string; live: { workers: unknown[]; pressurePct?: unknown }; history: { pressurePct: Array<number | null> } }> };
    expect(p.at).toBe(2000);
    const g = p.runtimes.find((r) => r.name === "gyro-m")!;
    expect(g.live.workers.length).toBe(1);
    expect(g.history.pressurePct).toEqual([62]);
    fail = true;
    await sampler.tick(); // a failed tick changes nothing
    expect(((await sampler.payload()) as { at: number }).at).toBe(2000);
  });
});

describe("/cockpit/models with the sampler", () => {
  afterEach(() => setRuntimeSampler(null));

  async function get(path: string): Promise<Record<string, unknown>> {
    const srv = http.createServer((req, res) => {
      if (!handleCockpit(req, res, { get: async () => [] }, () => [], () => new Map())) res.end("other");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    const body = await new Promise<string>((resolve) => {
      http.get({ host: "127.0.0.1", port, path }, (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve(b));
      });
    });
    srv.close();
    return JSON.parse(body) as Record<string, unknown>;
  }

  it("without a sampler the payload is the bare inventory", async () => {
    const j = await get("/cockpit/models");
    expect(Array.isArray(j.runtimes)).toBe(true);
    expect(j.live).toBeUndefined();
  });

  it("with a sampler the response carries live and history per runtime", async () => {
    const history: Record<string, RuntimeSample[]> = {};
    sampleRuntimes(input(), history, 1000);
    setRuntimeSampler({
      tick: async () => {},
      payload: async () => buildRuntimePayload(input(), history),
      cardReading: async () => null,
      start: () => () => {},
    });
    const j = await get("/cockpit/models") as { runtimes: unknown[]; live: { runtimes: Array<{ name: string; live: { workers: unknown[] }; history: { decode: Array<number | null> } }> } };
    expect(j.runtimes.length).toBe(3); // the inventory stays
    const g = j.live.runtimes.find((r) => r.name === "gyro-m")!;
    expect(g.live.workers.length).toBe(1);
    expect(g.history.decode).toEqual([73.4]);
  });

  it("the page renders a card per running runtime and chips for stopped ones", () => {
    expect(COCKPIT_HTML).toContain('class="rt-grid"');
    expect(COCKPIT_HTML).toContain('<div class="rt-card">');
    expect(COCKPIT_HTML).toContain("rt-chips dim");
    expect(COCKPIT_HTML).toContain("not loaded");
  });
});
