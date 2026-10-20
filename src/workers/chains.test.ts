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
import { applyRank, chainSummary, deriveChains, effectiveChains, parseRank, setModelRank } from "./chains.js";
import { routeRun, writePolicy, clearPolicy, POLICY_MODES } from "./policy.js";
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
};

function cfg(extra: Record<string, unknown> = {}) {
  return parseWorkersConfig({ enabled: true, active: "auto", providers: PROVIDERS, ...extra });
}

function tempConfig(workers: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): string {
  const path = join(dir, `config-${Math.random().toString(36).slice(2)}.yaml`);
  writeFileSync(path, JSON.stringify({ workers: { enabled: true, active: "auto", providers: PROVIDERS, ...workers }, ...extra }));
  return path;
}

describe("chain derivation", () => {
  it("workers chain falls back to routing.priority, then order, then the default priority", () => {
    expect(deriveChains(cfg(), "").workers).toEqual(["anthropic", "glm", "kimi"]);
    expect(deriveChains(cfg({ routing: { order: ["kimi", "glm"] } }), "").workers).toEqual(["kimi", "glm"]);
    expect(deriveChains(cfg({ routing: { order: ["kimi"], priority: ["glm", "anthropic"] } }), "").workers).toEqual(["glm", "anthropic"]);
  });

  it("orchestrator chain is the chat provider, anthropic by default", () => {
    expect(deriveChains(cfg(), "").orchestrator).toEqual(["anthropic"]);
    expect(deriveChains(cfg(), "glm").orchestrator).toEqual(["glm"]);
  });

  it("workers.chains wins over the legacy keys", () => {
    const c = cfg({ chains: { workers: ["gyro-m", "glm"], orchestrator: ["glm", "anthropic"] }, routing: { priority: ["kimi"] } });
    expect(deriveChains(c, "kimi")).toEqual({ workers: ["gyro-m", "glm"], orchestrator: ["glm", "anthropic"] });
  });

  it("summary line", () => {
    expect(chainSummary({ workers: ["gyro-m", "anthropic", "glm"], orchestrator: ["anthropic", "glm"] })).toBe(
      "Workers: gyro-m → anthropic → glm · Orchestrator: anthropic → glm"
    );
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

describe("persistence round trip (temp config)", () => {
  it("writes workers.chains and derives the legacy keys; a reread gives the same chains", () => {
    const path = tempConfig();
    const before = readFileSync(path, "utf8");
    setModelRank("workers", "gyro-m", 0, path);
    const r = setModelRank("orchestrator", "glm", 0, path);
    expect(r.chains.orchestrator).toEqual(["glm", "anthropic"]);
    const { raw, workers } = readWorkersSection(path);
    expect(workers.chains.workers).toEqual(["gyro-m", "anthropic", "glm", "kimi"]);
    expect(workers.chains.orchestrator).toEqual(["glm", "anthropic"]);
    // legacy keys follow: priority = the cloud members, chat provider = orchestrator t0
    expect(workers.routing.priority).toEqual(["anthropic", "glm", "kimi"]);
    expect((raw as { session: { profile: { chat: { provider: string } } } }).session.profile.chat.provider).toBe("glm");
    expect(readFileSync(path, "utf8")).not.toBe(before);
  });

  it("refuses an unknown model", () => {
    expect(() => setModelRank("workers", "nobody", 0, tempConfig())).toThrow(/no model named/);
  });

  it("off removes a model from the chain", () => {
    const path = tempConfig();
    setModelRank("workers", "kimi", "off", path);
    expect(readWorkersSection(path).workers.chains.workers).toEqual(["anthropic", "glm"]);
  });
});

describe("routing reads the chain", () => {
  it("autoOrder prefers workers.chains over routing.priority / order", () => {
    const c = cfg({ chains: { workers: ["glm", "gyro-m"] }, routing: { priority: ["kimi"], order: ["anthropic"] } });
    expect(autoOrder(c)).toEqual(["glm", "gyro-m"]);
  });
  it("a class's own order still wins; no chain keeps the legacy order", () => {
    const c = cfg({ chains: { workers: ["glm"] } });
    expect(autoOrder(c, { order: ["kimi"] })).toEqual(["kimi"]);
    expect(autoOrder(cfg({ routing: { priority: ["kimi"] } }))).toEqual(["kimi"]);
  });
  it("resolveTarget walks the chain: glm first although the default priority starts with anthropic", () => {
    const c = cfg({ chains: { workers: ["glm", "anthropic"] } });
    expect(resolveTarget(c, dir, {}).providerName).toBe("glm");
  });
});

describe("effective chains follow routing", () => {
  const up = async () => true;
  const down = async () => false;
  const mk = (extra: Record<string, unknown> = {}) => cfg({ logDir: dir, ...extra });

  it("the cockpit workers chain starts where routeRun sends the next run, for every policy mode", async () => {
    for (const ping of [up, down]) {
      for (const mode of POLICY_MODES) {
        writePolicy(dir, mode);
        const c = mk();
        const eff = await effectiveChains({}, c, { ping, battery: () => false, logDir: dir });
        const routed = await routeRun(c, dir, {}, { ping, battery: () => false }).catch(() => null);
        const t0 = routed?.providerFlag ?? eff.workers[0];
        expect(eff.workers[0], `${mode} ping=${ping === up}`).toBe(t0);
        if (routed?.providerFlag) expect(eff.workers[0]).toBe("gyro-m");
        else if (mode === "local-only") expect(eff.workers).toEqual([]);
        else expect(eff.workers[0]).toBe("anthropic");
      }
    }
    clearPolicy(dir);
  });

  it("per mode", async () => {
    const run = async (mode: string | null, ping = up) => {
      if (mode) writePolicy(dir, mode as never);
      else clearPolicy(dir);
      return (await effectiveChains({}, mk(), { ping, battery: () => false, logDir: dir })).workers;
    };
    expect(await run(null)).toEqual(["anthropic", "glm", "kimi"]);
    expect(await run("cloud-only")).toEqual(["anthropic", "glm", "kimi"]);
    expect(await run("local-only")).toEqual(["gyro-m"]);
    expect(await run("prefer-local")).toEqual(["gyro-m", "anthropic", "glm", "kimi"]);
    expect(await run("prefer-local", down)).toEqual(["anthropic", "glm", "kimi"]);
    expect(await run("prefer-cloud")).toEqual(["anthropic", "glm", "kimi", "gyro-m"]);
    clearPolicy(dir);
  });

  it("an explicit chain is shown as set; active feeds only the orchestrator", async () => {
    writePolicy(dir, "prefer-local");
    const c = mk({ chains: { workers: ["glm", "gyro-m"], orchestrator: [] }, active: "glm" });
    const eff = await effectiveChains({}, c, { ping: up, logDir: dir });
    expect(eff.workers).toEqual(["glm", "gyro-m"]);
    clearPolicy(dir);
    const a = await effectiveChains({}, mk({ active: "glm" }), { ping: up, logDir: dir });
    expect(a).toEqual({ workers: ["anthropic", "glm", "kimi"], orchestrator: ["glm"] });
  });
});
