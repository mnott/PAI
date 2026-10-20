/**
 * shipped-defaults.test.ts — the shipped defaults mechanism: the defaults
 * files load, deep-merge UNDER the user's files (user wins, arrays replace,
 * objects merge), a missing user file yields the defaults alone, and
 * `pai config get --source` reports which file a value came from. Temp dirs
 * only — never the live config.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  shippedMainDefaults,
  shippedWorkersDefaults,
  effectiveMainConfig,
  deepMergeConfig,
  shippedMainDefaultsPath,
  shippedWorkersDefaultsPath,
} from "./shipped-defaults.js";
import { defaultWorkersConfig, nativeAnthropicModels, parseWorkersConfig } from "../workers/config.js";
import { effectiveWorkersYamlData, workersYamlPath } from "../workers/workers-config.js";

// CONFIG_FILE is resolved once at module load, so the ops/loadConfig cases
// need PAI_CONFIG_FILE/PAI_WORKERS_YAML set BEFORE those modules are first
// imported (same trick as main-config-ops.test.ts).
const savedHome = process.env.HOME;
const savedPaiHome = process.env.PAI_HOME;
const savedConfigFile = process.env.PAI_CONFIG_FILE;
const savedWorkersYaml = process.env.PAI_WORKERS_YAML;

const dirs: string[] = [];
function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), "pai-shipped-defaults-"));
  dirs.push(d);
  return d;
}

let configFile: string;
let getConfigValueOp: typeof import("./main-config-ops.js")["getConfigValueOp"];
let formatConfigSource: typeof import("./main-config-ops.js")["formatConfigSource"];
let loadConfig: typeof import("../daemon/config.js")["loadConfig"];

beforeAll(async () => {
  process.env.HOME = newDir();
  const paiHome = newDir();
  process.env.PAI_HOME = paiHome;
  configFile = join(paiHome, "config.json");
  process.env.PAI_CONFIG_FILE = configFile;
  process.env.PAI_WORKERS_YAML = join(paiHome, "workers.yaml");
  ({ getConfigValueOp, formatConfigSource } = await import("./main-config-ops.js"));
  ({ loadConfig } = await import("../daemon/config.js"));
});

afterAll(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedPaiHome === undefined) delete process.env.PAI_HOME;
  else process.env.PAI_HOME = savedPaiHome;
  if (savedConfigFile === undefined) delete process.env.PAI_CONFIG_FILE;
  else process.env.PAI_CONFIG_FILE = savedConfigFile;
  if (savedWorkersYaml === undefined) delete process.env.PAI_WORKERS_YAML;
  else process.env.PAI_WORKERS_YAML = savedWorkersYaml;
});

// The module-level CONFIG_FILE / workersYamlPath() are pinned to paiHome by
// beforeAll, so the user files the loadConfig/getConfigValueOp/readWorkersYaml
// cases exercise must live there — cleared between tests so each starts bare.
const userYaml = (): string => join(dirname(configFile), "config.yaml");
let dir: string;
beforeEach(() => {
  dir = newDir();
  rmSync(configFile, { force: true });
  rmSync(userYaml(), { force: true });
  rmSync(workersYamlPath(), { force: true });
});

describe("the shipped defaults files", () => {
  it("exist next to the loader module and parse as mappings", () => {
    expect(shippedMainDefaultsPath()).toContain("config/defaults/config.yaml");
    expect(shippedWorkersDefaultsPath()).toContain("config/defaults/workers.yaml");
    const main = shippedMainDefaults();
    expect(main.indexIntervalSecs).toBe(300);
    expect((main.search as Record<string, unknown>).recencyBoostDays).toBe(90);
    const workers = shippedWorkersDefaults();
    expect((workers.workers as Record<string, unknown>).pool).toMatchObject({ enabled: false, maxSlots: 3, idleSecs: 900 });
    expect(workers.mcp_sets).toEqual({ desktop: ["clickr"] });
  });

  it("carry the policy values the code used to hardcode", () => {
    const w = defaultWorkersConfig();
    expect(w.tree).toEqual({ maxDepth: 2, maxChildren: 4 });
    expect(w.routing.cooldownMinutes).toBe(30);
    expect(w.routing.budgetPriority).toEqual(["anthropic", "glm", "kimi"]);
    expect(w.routing.budgetPercent).toEqual({ anthropic: 95, glm: 90, kimi: 85 });
    expect(w.routing.budgetWall).toBe(95);
    expect(w.waitAlarmMinutes).toBe(120);
    expect(w.gcOlderThanHours).toBe(6);
    expect(w.worktreesMaxGb).toBe(20);
    expect(w.stagger).toEqual({ enabled: true, localDefaultSec: 20, remoteDefaultSec: 8, minSec: 3, maxSec: 120 });
    expect(w.capacity).toEqual({ enabled: true, localDefaultCap: 1, uncappedQueueCap: 3, maxTotalWaitMs: 7_200_000, heartbeatMs: 60_000, agingMs: 900_000 });
    expect(w.localIdle).toEqual({ enabled: true, gpuBelowPct: 10, minutes: 2, backoffMinutes: 10 });
    expect(w.costTier).toBe(3);
    expect(w.quotaSkipAt).toBe(95);
    expect(nativeAnthropicModels()).toEqual({ default: "sonnet", fast: "haiku" });
    expect(w.mcpSets).toEqual({ desktop: ["clickr"] });
    expect(w.classes).toEqual({});
  });
});

describe("deepMergeConfig", () => {
  it("user values win, arrays replace, objects merge", () => {
    const merged = deepMergeConfig(
      { a: 1, nested: { x: 1, y: 2 }, list: [1, 2, 3] },
      { a: 2, nested: { y: 9 }, list: [7] }
    );
    expect(merged).toEqual({ a: 2, nested: { x: 1, y: 9 }, list: [7] });
  });

  it("null in the user file replaces the default (active: null)", () => {
    expect(deepMergeConfig({ active: "anthropic" }, { active: null })).toEqual({ active: null });
  });
});

describe("effectiveMainConfig", () => {
  it("missing user file -> the defaults alone", () => {
    const merged = effectiveMainConfig(join(dir, "config.json"));
    expect(merged.indexIntervalSecs).toBe(300);
    expect(merged.logLevel).toBe("info");
  });

  it("user config.yaml deep-merges UNDER the defaults: user wins, arrays replace", () => {
    writeFileSync(
      join(dir, "config.yaml"),
      "indexIntervalSecs: 999\nsearch:\n  defaultLimit: 42\nidentity:\n  selfEmails: [me@example.ch]\n"
    );
    const merged = effectiveMainConfig(join(dir, "config.json"));
    expect(merged.indexIntervalSecs).toBe(999);
    // sibling defaults survive the partial user subtree
    expect((merged.search as Record<string, unknown>).recencyBoostDays).toBe(90);
    expect((merged.search as Record<string, unknown>).defaultLimit).toBe(42);
    expect(merged.logLevel).toBe("info");
    // a user array replaces the defaults' array wholesale
    expect((merged.identity as Record<string, unknown>).selfEmails).toEqual(["me@example.ch"]);
  });

  it("user config.json works the same when no config.yaml exists", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ logLevel: "debug" }));
    const merged = effectiveMainConfig(join(dir, "config.json"));
    expect(merged.logLevel).toBe("debug");
    expect(merged.indexIntervalSecs).toBe(300);
  });
});

describe("effective workers.yaml / readWorkersYaml", () => {
  it("missing user workers.yaml -> the defaults alone", () => {
    const d = effectiveWorkersYamlData(workersYamlPath());
    expect(d.mcpSets).toEqual({ desktop: ["clickr"] });
    expect(d.nativeModels).toEqual({ default: "sonnet", fast: "haiku" });
    expect(d.active).toBeNull();
    expect(d.providers).toEqual({});
  });

  it("user workers.yaml merges UNDER the defaults: providers merge, classes replace", () => {
    writeFileSync(
      workersYamlPath(),
      "providers:\n  glm:\n    url: https://api.example.com\n    models:\n      default: glm-x\n      fast: glm-y\n"
    );
    const d = effectiveWorkersYamlData(workersYamlPath());
    // the defaults' builtin anthropic block is not a user provider
    expect(Object.keys(d.providers)).toEqual(["glm"]);
    expect(d.providers.glm.models.fast).toBe("glm-y");
    // the class map lives in the main config's shipped defaults; a bare
    // workers.yaml names none
    expect(d.classes).toEqual({});
    expect(d.mcpSets).toEqual({ desktop: ["clickr"] });
  });

  it("a user classes block replaces the shipped class map wholesale", () => {
    writeFileSync(
      workersYamlPath(),
      "providers:\n  glm:\n    url: https://api.example.com\n    models:\n      default: glm-x\n\nclasses:\n  implement: glm\n"
    );
    const d = effectiveWorkersYamlData(workersYamlPath());
    expect(d.classes).toEqual({ implement: "glm" });
  });

  it("a user mcp_sets entry replaces the default set; desktop: [] removes it", () => {
    writeFileSync(workersYamlPath(), "mcp_sets:\n  desktop: []\n  extra: [srv]\n");
    const d = effectiveWorkersYamlData(workersYamlPath());
    expect(d.mcpSets).toEqual({ desktop: [], extra: ["srv"] });
  });

  it("the JSON workers section merges UNDER the defaults too", () => {
    const c = parseWorkersConfig({ tree: { maxDepth: 5 } });
    expect(c.tree).toEqual({ maxDepth: 5, maxChildren: 4 });
    expect(c.routing.policy).toBe("budget");
  });
});

describe("loadConfig", () => {
  it("missing user file -> the shipped defaults", () => {
    const cfg = loadConfig();
    expect(cfg.indexIntervalSecs).toBe(300);
    expect(cfg.search.defaultLimit).toBe(10);
    expect(cfg.sessions.cacheKeepalive.enabled).toBe(false);
    expect(cfg.sessions.cacheKeepalive.idleMinutes).toBe(50);
    expect(cfg.notifications.routing.error).toEqual(["whatsapp", "macos", "ntfy", "cli"]);
    expect(cfg.tasks.enabled).toBe(false);
    // computed values stay in code, over the defaults file
    expect(cfg.socketPath).toBeTruthy();
    expect(cfg.postgres?.connectionString).toMatch(/^postgresql:\/\/pai:pai@localhost:5432\/pai_/);
  });

  it("user file wins over the defaults", () => {
    writeFileSync(userYaml(), "search:\n  defaultLimit: 3\n");
    const cfg = loadConfig();
    expect(cfg.search.defaultLimit).toBe(3);
    expect(cfg.search.mode).toBe("keyword");
  });
});

describe("pai config get --source", () => {
  it("a value only in the defaults file reports source=defaults", () => {
    const r = getConfigValueOp("search.recencyBoostDays");
    expect(r.found).toBe(true);
    expect(r.value).toBe(90);
    expect(r.source).toBe("defaults");
    expect(formatConfigSource(r.source)).toBe("shipped defaults");
  });

  it("a value the user set reports source=user", () => {
    writeFileSync(userYaml(), "search:\n  defaultLimit: 3\n");
    const r = getConfigValueOp("search.defaultLimit");
    expect(r.value).toBe(3);
    expect(r.source).toBe("user");
    expect(formatConfigSource(r.source)).toBe("user config");
    // a sibling the user did not set still comes from the defaults
    const s = getConfigValueOp("search.mode");
    expect(s.value).toBe("keyword");
    expect(s.source).toBe("defaults");
  });
});
