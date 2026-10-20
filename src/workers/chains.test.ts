/**
 * chains.test.ts — model ranks per role: derivation from the legacy keys,
 * rank changes, persistence round trip (temp config only, never the live
 * file) and routing reading the chain.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkersConfig, readWorkersSection } from "./config.js";
import { applyRank, chainForPolicy, chatProviderOf, configuredLocal, setChain, setLocalFirst, chainSummary, roleSummary, deriveChains, effectiveChains, parseRank, setModelRank, setRoleChain } from "./chains.js";
import { routeRun, writePolicy, clearPolicy, POLICY_MODES } from "./policy.js";
import { flatChain } from "./config.js";
import { autoOrder, resolveTarget } from "./routing.js";

const dir = mkdtempSync(join(tmpdir(), "pai-chains-"));
const savedYaml = process.env.PAI_WORKERS_YAML;

beforeAll(() => {
  process.env.PAI_WORKERS_YAML = join(dir, "no-workers.yaml");
});
afterAll(() => {
  if (savedYaml === undefined) delete process.env.PAI_WORKERS_YAML;
  else process.env.PAI_WORKERS_YAML = savedYaml;
  rmSync(dir, { recursive: true, force: true });
});

const PROVIDERS = {
  glm: { baseUrl: "https://api.example.com/anthropic", keyFile: "~/k", models: { default: "g", fast: "gf" }, env: {} },
  kimi: { baseUrl: "https://api.example.com/kimi", keyFile: "~/k", models: { default: "k", fast: "kf" }, env: {} },
  "gyro-m": { baseUrl: "http://127.0.0.1:8010", models: { default: "q", fast: "q" }, env: {} },
  "gyro-m-b": { baseUrl: "http://127.0.0.1:8011", models: { default: "q", fast: "q" }, env: {} },
  iq3s: { baseUrl: "http://127.0.0.1:8012", models: { default: "q", fast: "q" }, env: {} },
};
const rc = (local: string[], cloud: string[], localFirst = true) => ({ local, cloud, localFirst });
// ping by port: which local servers are loaded
const loaded = (...ports: number[]) => async (url: string) => ports.some((p) => url.endsWith(`:${p}`));

function cfg(extra: Record<string, unknown> = {}) {
  return parseWorkersConfig({ enabled: true, active: "auto", providers: PROVIDERS, ...extra });
}

function tempConfig(workers: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): string {
  const path = join(dir, `config-${Math.random().toString(36).slice(2)}.yaml`);
  writeFileSync(path, JSON.stringify({ workers: { enabled: true, active: "auto", providers: PROVIDERS, ...workers }, ...extra }));
  return path;
}

describe("chain derivation", () => {
  it("workers cloud group falls back to routing.priority, then order, then the default priority", () => {
    expect(deriveChains(cfg(), "").workers).toEqual(rc([], ["anthropic", "glm", "kimi"]));
    expect(deriveChains(cfg({ routing: { order: ["kimi", "glm"] } }), "").workers.cloud).toEqual(["kimi", "glm"]);
    expect(deriveChains(cfg({ routing: { order: ["kimi"], priority: ["glm", "anthropic"] } }), "").workers.cloud).toEqual(["glm", "anthropic"]);
  });

  it("orchestrator chain is the chat provider, anthropic by default", () => {
    expect(deriveChains(cfg(), "").orchestrator.cloud).toEqual(["anthropic"]);
    expect(deriveChains(cfg(), "glm").orchestrator.cloud).toEqual(["glm"]);
  });

  it("workers.chains wins over the legacy keys", () => {
    const c = cfg({ chains: { workers: rc(["gyro-m"], ["glm"]), orchestrator: rc([], ["glm", "anthropic"]) }, routing: { priority: ["kimi"] } });
    expect(deriveChains(c, "kimi")).toEqual({ workers: rc(["gyro-m"], ["glm"]), orchestrator: rc([], ["glm", "anthropic"]) });
  });

  it("migrates the flat chain into local and cloud groups", () => {
    const c = cfg({ chains: { workers: ["gyro-m", "anthropic", "glm", "kimi"], orchestrator: ["anthropic"] } });
    expect(c.chains.workers).toEqual(rc(["gyro-m"], ["anthropic", "glm", "kimi"]));
    expect(c.chains.orchestrator).toEqual(rc([], ["anthropic"]));
    // cloud ahead of local in the old chain: the local group migrates switched off
    expect(cfg({ chains: { workers: ["anthropic", "gyro-m"] } }).chains.workers).toEqual(rc(["gyro-m"], ["anthropic"], false));
  });

  it("migration classifies models by providers that live in workers.yaml", () => {
    const c = parseWorkersConfig({ chains: { workers: ["gyro-m", "anthropic"] } }, PROVIDERS as never);
    expect(c.chains.workers).toEqual(rc(["gyro-m"], ["anthropic"]));
  });

  it("summary line", () => {
    const w = { ...rc(["gyro-m", "iq3s", "gyro-m-b"], ["anthropic", "glm", "kimi"]), running: "gyro-m" };
    const o = { ...rc([], ["anthropic", "glm"]), running: null };
    expect(chainSummary({ workers: w, orchestrator: o })).toBe(
      "Workers: local gyro-m (running) → iq3s, gyro-m-b (not loaded) · then cloud anthropic → glm → kimi · Orchestrator: cloud anthropic → glm"
    );
    expect(roleSummary({ ...rc(["gyro-m"], ["glm"]), running: null })).toBe("local gyro-m (not loaded) · then cloud glm");
    expect(roleSummary({ ...rc(["gyro-m"], ["glm"], false), running: "gyro-m" })).toBe("cloud glm · local off (gyro-m)");
  });
});

describe("rank change", () => {
  it("t0 shifts the others down: no duplicates, no gaps", () => {
    expect(applyRank(["anthropic", "glm"], "kimi", 0)).toEqual(["kimi", "anthropic", "glm"]);
    expect(applyRank(["anthropic", "glm", "kimi"], "kimi", 0)).toEqual(["kimi", "anthropic", "glm"]);
    expect(applyRank(["anthropic", "glm", "kimi"], "anthropic", 1)).toEqual(["glm", "anthropic", "kimi"]);
  });
  it("a rank beyond the end lands at the end; off closes the gap; at most four ranks", () => {
    expect(applyRank(["a"], "b", 3)).toEqual(["a", "b"]);
    expect(applyRank(["a", "b", "c"], "b", "off")).toEqual(["a", "c"]);
    expect(applyRank(["a", "b", "c", "d"], "e", 0)).toEqual(["e", "a", "b", "c"]);
  });
  it("parses ranks", () => {
    expect(parseRank("t2")).toBe(2);
    expect(parseRank("off")).toBe("off");
    expect(parseRank("t4")).toBeNull();
    expect(parseRank("x")).toBeNull();
  });
});

describe("ranks are per group", () => {
  it("ranking a local model t0 does not move it behind the cloud, and cloud ranks do not shift local ones", () => {
    const path = tempConfig({ chains: { workers: ["anthropic", "glm", "kimi"], orchestrator: [] } });
    setModelRank("workers", "iq3s", 0, path);
    setModelRank("workers", "gyro-m", 0, path);
    setModelRank("workers", "kimi", 0, path);
    const w = readWorkersSection(path).workers.chains.workers;
    expect(w).toEqual(rc(["gyro-m", "iq3s"], ["kimi", "anthropic", "glm"]));
    expect(flatChain(w)).toEqual(["gyro-m", "iq3s", "kimi", "anthropic", "glm"]);
  });
  it("setChain takes a group and refuses a model of the other group", () => {
    const path = tempConfig();
    setChain("workers", "local", ["gyro-m", "iq3s"], path);
    setChain("workers", "cloud", ["anthropic", "glm"], path);
    expect(readWorkersSection(path).workers.chains.workers).toEqual(rc(["gyro-m", "iq3s"], ["anthropic", "glm"]));
    expect(() => setChain("workers", "local", ["glm"], path)).toThrow(/cloud model/);
    expect(() => setChain("workers", "cloud", ["gyro-m"], path)).toThrow(/local model/);
    setLocalFirst("workers", false, path);
    expect(readWorkersSection(path).workers.chains.workers.localFirst).toBe(false);
  });
});

describe("persistence round trip (temp config)", () => {
  it("writes workers.chains and derives the legacy keys; a reread gives the same chains", () => {
    const path = tempConfig();
    const before = readFileSync(path, "utf8");
    setModelRank("workers", "gyro-m", 0, path);
    const r = setModelRank("orchestrator", "glm", 0, path);
    expect(r.chains.orchestrator.cloud).toEqual(["glm", "anthropic"]);
    const { raw, workers } = readWorkersSection(path);
    expect(workers.chains.workers).toEqual(rc(["gyro-m"], ["anthropic", "glm", "kimi"]));
    expect(workers.chains.orchestrator.cloud).toEqual(["glm", "anthropic"]);
    // legacy keys follow: priority = the cloud group, chat provider = orchestrator t0
    expect(workers.routing.priority).toEqual(["anthropic", "glm", "kimi"]);
    expect((raw as { session: { profile: { chat: { provider: string } } } }).session.profile.chat.provider).toBe("glm");
    expect(readFileSync(path, "utf8")).not.toBe(before);
  });

  it("refuses an unknown model", () => {
    expect(() => setModelRank("workers", "nobody", 0, tempConfig())).toThrow(/no model named/);
  });

  it("off removes a model from its group", () => {
    const path = tempConfig();
    setModelRank("workers", "kimi", "off", path);
    expect(readWorkersSection(path).workers.chains.workers.cloud).toEqual(["anthropic", "glm"]);
  });
});

describe("routing reads the chain", () => {
  it("autoOrder prefers workers.chains over routing.priority / order: local group first", () => {
    const c = cfg({ chains: { workers: rc(["gyro-m"], ["glm"]) }, routing: { priority: ["kimi"], order: ["anthropic"] } });
    expect(autoOrder(c)).toEqual(["gyro-m", "glm"]);
    expect(autoOrder(cfg({ chains: { workers: rc(["gyro-m"], ["glm"], false) } }))).toEqual(["glm"]);
  });
  it("a class's own order still wins; no chain keeps the legacy order", () => {
    const c = cfg({ chains: { workers: rc([], ["glm"]) } });
    expect(autoOrder(c, { order: ["kimi"] })).toEqual(["kimi"]);
    expect(autoOrder(cfg({ routing: { priority: ["kimi"] } }))).toEqual(["kimi"]);
  });
  it("resolveTarget walks the cloud group: glm first although the default priority starts with anthropic", () => {
    const c = cfg({ chains: { workers: rc([], ["glm", "anthropic"]) } });
    expect(resolveTarget(c, dir, {}).providerName).toBe("glm");
  });
});

describe("local first, cloud second", () => {
  const mk = (workers: ReturnType<typeof rc>) => cfg({ logDir: dir, chains: { workers, orchestrator: rc([], []) } });
  const route = (c: ReturnType<typeof mk>, ping: (u: string) => Promise<boolean>, flags = {}) =>
    routeRun(c, dir, flags, { ping, battery: () => false });

  it("the running local model serves, ahead of the cloud", async () => {
    const c = mk(rc(["gyro-m", "iq3s"], ["anthropic", "glm"]));
    expect((await route(c, loaded(8010)))?.providerFlag).toBe("gyro-m");
    expect(resolveTarget(c, dir, { className: "implement" }).providerName).toBe("gyro-m");
  });

  it("a ranked local model that is not loaded is skipped, the next ranked one serves", async () => {
    const c = mk(rc(["gyro-m", "iq3s"], ["anthropic"]));
    expect((await route(c, loaded(8012)))?.providerFlag).toBe("iq3s");
  });

  it("an unranked local server never serves", async () => {
    const c = mk(rc(["gyro-m"], ["anthropic"]));
    expect((await route(c, loaded(8011)))?.providerFlag).toBeNull();
  });

  it("no ranked local model running -> the cloud group in its order", async () => {
    const c = mk(rc(["gyro-m", "iq3s"], ["glm", "anthropic"]));
    const r = await route(c, loaded());
    expect(r?.providerFlag).toBeNull();
    expect(flatChain(c.chains.workers).slice(2)).toEqual(["glm", "anthropic"]);
  });

  it("falls through to cloud on --urgent / --cloud; local off puts cloud first; no cloud group is local only", async () => {
    const c = mk(rc(["gyro-m"], ["anthropic"]));
    expect((await route(c, loaded(8010), { urgent: true }))?.providerFlag).toBeNull();
    expect((await route(c, loaded(8010), { cloud: true }))?.providerFlag).toBeNull();
    const off = mk(rc(["gyro-m"], ["anthropic"], false));
    expect((await route(off, loaded(8010)))?.providerFlag).toBeNull();
    expect((await route(off, loaded(8010), { localOk: true }))?.providerFlag).toBe("gyro-m");
    const only = mk(rc(["gyro-m"], []));
    expect((await route(only, loaded(8010)))?.providerFlag).toBe("gyro-m");
    await expect(route(only, loaded())).rejects.toThrow(/local only|chain:/);
  });

  it("display equals routing: the view names the model routeRun pins, for every up/down combination", async () => {
    for (const ping of [loaded(), loaded(8010), loaded(8012), loaded(8010, 8012)]) {
      const c = mk(rc(["gyro-m", "iq3s"], ["anthropic", "glm"]));
      const eff = await effectiveChains({}, c, { ping, logDir: dir });
      const routed = await route(c, ping);
      expect(eff.workers.running).toBe(routed?.providerFlag ?? null);
      expect(chainSummary(eff)).toContain(eff.workers.running ? `${eff.workers.running} (running)` : "(not loaded)");
    }
  });

  it("active does not pin a run once a chain is set", () => {
    const c = cfg({ logDir: dir, active: "kimi", chains: { workers: rc([], ["glm", "anthropic"]), orchestrator: rc([], []) } });
    expect(resolveTarget(c, dir, {}).providerName).toBe("glm");
  });

  it("the orchestrator chain beats active", () => {
    expect(chatProviderOf({}, cfg({ active: "glm", chains: { workers: rc([], []), orchestrator: rc([], ["kimi"]) } }))).toBe("kimi");
  });
});

describe("policy modes map onto the groups", () => {
  const cur = rc(["gyro-m"], ["anthropic", "glm"]);
  it("prefer-local / auto: local on; prefer-cloud / cloud-only: local off; local-only: no cloud group", () => {
    expect(chainForPolicy("prefer-local", cur, "gyro-m")).toEqual(rc(["gyro-m"], ["anthropic", "glm"]));
    expect(chainForPolicy("auto", cur, "gyro-m").localFirst).toBe(true);
    expect(chainForPolicy("prefer-cloud", cur, "gyro-m").localFirst).toBe(false);
    expect(chainForPolicy("cloud-only", cur, "gyro-m")).toEqual(rc(["gyro-m"], ["anthropic", "glm"], false));
    expect(chainForPolicy("local-only", cur, "gyro-m")).toEqual(rc(["gyro-m"], []));
    // leaving local-only restores a cloud group
    expect(chainForPolicy("prefer-local", rc(["gyro-m"], []), "gyro-m", ["anthropic"])).toEqual(rc(["gyro-m"], ["anthropic"]));
  });
  it("an empty local group is seeded with the given (configured) local provider", () => {
    expect(chainForPolicy("prefer-local", rc([], ["anthropic"]), "gyro-m")).toEqual(rc(["gyro-m"], ["anthropic"]));
  });

  it("prefer-local seeds the workers.yaml local: provider, not another loopback provider (gyro-m-b first in config order)", () => {
    const yaml = join(dir, "workers-local.yaml");
    writeFileSync(yaml, "local: gyro-m\nproviders: {}\n");
    const saved = process.env.PAI_WORKERS_YAML;
    process.env.PAI_WORKERS_YAML = yaml;
    try {
      const { "gyro-m-b": b, ...rest } = PROVIDERS;
      const providers = { "gyro-m-b": b, ...rest };
      const c = parseWorkersConfig({ enabled: true, active: "auto", providers });
      expect(Object.keys(c.providers).find((n) => n.startsWith("gyro"))).toBe("gyro-m-b");
      expect(configuredLocal(c)).toBe("gyro-m");
      const path = tempConfig({ providers });
      setRoleChain("workers", chainForPolicy("prefer-local", deriveChains(c, "").workers, configuredLocal(c), c.routing.priority), "t", path);
      expect(readWorkersSection(path).workers.chains.workers.local).toEqual(["gyro-m"]);
    } finally {
      if (saved === undefined) delete process.env.PAI_WORKERS_YAML;
      else process.env.PAI_WORKERS_YAML = saved;
    }
  });

  it("without a local: key the first enabled local provider seeds", () => {
    expect(configuredLocal(cfg())).toBe("gyro-m");
  });
});

describe("effective chains without an explicit chain follow the policy", () => {
  const up = loaded(8010);
  const mk = () => cfg({ logDir: dir });
  it("per mode", async () => {
    const run = async (mode: string | null, ping = up) => {
      if (mode) writePolicy(dir, mode as never);
      else clearPolicy(dir);
      return (await effectiveChains({}, mk(), { ping, battery: () => false, logDir: dir })).workers;
    };
    expect(await run(null)).toMatchObject(rc([], ["anthropic", "glm", "kimi"]));
    expect(await run("cloud-only")).toMatchObject(rc([], ["anthropic", "glm", "kimi"], false));
    expect(await run("local-only")).toMatchObject({ local: ["gyro-m"], cloud: [], running: "gyro-m" });
    expect(await run("prefer-local")).toMatchObject({ local: ["gyro-m"], localFirst: true, running: "gyro-m" });
    expect(await run("prefer-local", loaded())).toMatchObject({ local: [], running: null });
    expect(await run("prefer-cloud")).toMatchObject({ localFirst: false });
    clearPolicy(dir);
  });

  it("the view starts where routeRun sends the next run, for every policy mode", async () => {
    for (const ping of [up, loaded()]) {
      for (const mode of POLICY_MODES) {
        writePolicy(dir, mode);
        const c = mk();
        const eff = await effectiveChains({}, c, { ping, battery: () => false, logDir: dir });
        const routed = await routeRun(c, dir, {}, { ping, battery: () => false }).catch(() => null);
        if (routed?.providerFlag) expect(eff.workers.running).toBe(routed.providerFlag);
        if (routed?.providerFlag === null && eff.workers.localFirst) expect(eff.workers.running).toBeNull();
      }
    }
    clearPolicy(dir);
  });
});
