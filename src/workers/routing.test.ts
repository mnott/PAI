/**
 * Tests for class/provider resolution and the runner-args parser.
 *
 * Pure functions, no claude/osascript calls — the routing decision is exactly
 * what a misrouted worker gets wrong, so it is pinned here.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkersConfig, type WorkerProvider } from "./config.js";
import {
  autoOrder,
  capabilityForRun,
  nextAutoProvider,
  NoProviderError,
  readRoutingState,
  recordBudgetCooldowns,
  resolveCapabilityRun,
  resolveTarget,
  setCooldown,
  writeRoutingState,
  type RoutingState,
} from "./routing.js";
import { budgetCache, type BudgetReading } from "./budget.js";
import { parseRunnerArgs } from "./args.js";

// resolveTarget reads the spawning session from the environment; keep these runs hermetic
for (const k of ["PAI_SESSION_PROVIDER", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "PAI_WORKER_ID"]) delete process.env[k];

const dir = mkdtempSync(join(tmpdir(), "pai-workers-routing-"));

function config(overrides: Record<string, unknown> = {}) {
  return parseWorkersConfig({
    enabled: true,
    active: "glm",
    providers: {
      glm: {
        baseUrl: "https://api.example.com/api/anthropic",
        keyFile: "~/.config/example/api_key",
        models: { default: "example-4.7", fast: "example-4.7-flash" },
        env: {},
      },
    },
    classes: { implement: "glm", research: "glm", spotcheck: "glm/fast" },
    ...overrides,
  });
}

const GLM: WorkerProvider = {
  enabled: true,
  protocol: "anthropic",
  baseUrl: "https://api.example.com/api/anthropic",
  keyFile: null,
  models: { default: "example-4.7", fast: "example-4.7-flash" },
  env: {},
};

describe("resolveTarget", () => {
  it("resolves a plain class to the provider default model", () => {
    const t = resolveTarget(config(), dir, { className: "research" });
    expect(t.providerName).toBe("glm");
    expect(t.modelAlias).toBeNull();
    expect(t.via).toBe("class");
  });

  it("resolves a fast class to the fast alias", () => {
    const t = resolveTarget(config(), dir, { className: "spotcheck" });
    expect(t.providerName).toBe("glm");
    expect(t.modelAlias).toBe("fast");
  });

  it("gives --provider the highest precedence", () => {
    const t = resolveTarget(config(), dir, { flagProvider: "glm", className: "research" });
    expect(t.via).toBe("flag");
  });

  it("names the class when it does not exist", () => {
    expect(() => resolveTarget(config(), dir, { className: "nope" })).toThrow(/no class named "nope"/);
  });

  it("routes a standard but unconfigured class like a run without one", () => {
    const t = resolveTarget(config(), dir, { className: "draft" });
    expect(t.providerName).toBe("glm");
    expect(t.via).toBe("active");
  });

  it("skips a cooled-down provider in auto order and takes the next", () => {
    const c = config({
      active: "auto",
      providers: {
        glm: GLM,
        other: { ...GLM, baseUrl: "https://other.example.com" },
      },
      routing: { order: ["glm", "other"], cooldownMinutes: 30, retryOnQuota: true },
    });
    setCooldown(dir, "glm", 30);
    const t = resolveTarget(c, dir);
    expect(t.providerName).toBe("other");
    expect(t.via).toBe("auto");
  });

  it("keeps reading the legacy roles key until the config is rewritten", () => {
    const c = parseWorkersConfig({
      enabled: true,
      active: "glm",
      providers: { glm: GLM },
      roles: { implement: "glm" },
    });
    expect(resolveTarget(c, dir, { className: "implement" }).via).toBe("class");
  });
});

describe("resolveTarget \u2014 native anthropic provider", () => {
  it("resolves --provider anthropic to the native provider, bypassing config", () => {
    const t = resolveTarget(config(), dir, { flagProvider: "anthropic" });
    expect(t.providerName).toBe("anthropic");
    expect(t.provider.native).toBe(true);
    expect(t.provider.baseUrl).toBe("");
    expect(t.via).toBe("flag");
  });

  it("resolves active: anthropic to the native provider", () => {
    const c = config({ active: "anthropic" });
    const t = resolveTarget(c, dir, {});
    expect(t.providerName).toBe("anthropic");
    expect(t.provider.native).toBe(true);
  });

  it('resolves a class target of "anthropic" to the native provider', () => {
    const c = config({
      classes: { implement: "glm", research: "glm", spotcheck: "glm/fast", simple: "anthropic" },
    });
    const t = resolveTarget(c, dir, { className: "simple" });
    expect(t.providerName).toBe("anthropic");
    expect(t.provider.native).toBe(true);
    expect(t.via).toBe("class");
  });

  it('resolves a class target of {provider: "anthropic"} to the native provider', () => {
    const c = config({
      classes: { implement: "glm", complex: { provider: "anthropic" } },
    });
    const t = resolveTarget(c, dir, { className: "complex" });
    expect(t.providerName).toBe("anthropic");
    expect(t.provider.native).toBe(true);
    expect(t.via).toBe("class");
  });
});

describe("resolveTarget with class constraints", () => {
  const providers = {
    cheap: { ...GLM, baseUrl: "https://cheap.example.com", costTier: 1, tags: ["fast" as const] },
    smart: {
      ...GLM,
      baseUrl: "https://smart.example.com",
      costTier: 4,
      tags: ["reasoning" as const, "long-context" as const],
    },
  };

  it("auto-routing skips providers above the class's maxCostTier", () => {
    const c = config({
      active: "auto",
      providers,
      classes: { research: { maxCostTier: 2 } },
      routing: { order: ["smart", "cheap"], cooldownMinutes: 30, retryOnQuota: true },
    });
    const t = resolveTarget(c, dir, { className: "research" });
    expect(t.providerName).toBe("cheap");
  });

  it("auto-routing skips providers missing a required tag", () => {
    const c = config({
      active: "auto",
      providers,
      classes: { research: { requireTags: ["reasoning"] } },
      routing: { order: ["cheap", "smart"], cooldownMinutes: 30, retryOnQuota: true },
    });
    const t = resolveTarget(c, dir, { className: "research" });
    expect(t.providerName).toBe("smart");
  });

  it("fails with the exclusion reason of every provider when nothing qualifies", () => {
    const c = config({
      active: "auto",
      providers,
      classes: { complex: { maxCostTier: 1, requireTags: ["reasoning", "long-context"] } },
      routing: { order: ["cheap", "smart"], cooldownMinutes: 30, retryOnQuota: true },
    });
    try {
      resolveTarget(c, dir, { className: "complex" });
      throw new Error("expected resolveTarget to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(NoProviderError);
      const msg = (e as Error).message;
      expect(msg).toMatch(/class "complex"/);
      expect(msg).toMatch(/cheap: missing tags: reasoning, long-context/);
      expect(msg).toMatch(/smart: cost tier 4 > max 1/);
    }
  });

  it("uses the class's own routing order when it has one", () => {
    const c = config({
      active: "auto",
      providers,
      classes: { simple: { order: ["cheap", "smart"] } },
      routing: { order: ["smart", "cheap"], cooldownMinutes: 30, retryOnQuota: true },
    });
    const t = resolveTarget(c, dir, { className: "simple" });
    expect(t.providerName).toBe("cheap");
  });
});

describe("parseRunnerArgs", () => {
  it("keeps the prompt and tools, drops --output-format/--verbose", () => {
    const p = parseRunnerArgs([
      "-p", "fix the buttons",
      "--allowedTools", "Read,Edit,Write,Bash,Grep,Glob",
      "--output-format", "json",
      "--verbose",
    ]);
    expect(p.prompt).toBe("fix the buttons");
    expect(p.headless).toBe(true);
    expect(p.outputFormat).toBe("json");
    expect(p.rest).toEqual([
      "-p", "fix the buttons",
      "--allowedTools", "Read,Edit,Write,Bash,Grep,Glob",
    ]);
  });

  it("notes when the caller pinned --model or --mcp-config", () => {
    const p = parseRunnerArgs(["--model", "big", "--mcp-config", "/tmp/m.json"]);
    expect(p.callerModel).toBe(true);
    expect(p.callerMcpConfig).toBe(true);
    expect(p.headless).toBe(false);
  });
});

describe("capabilityForRun", () => {
  it("an explicit --capability always applies, --provider aside", () => {
    expect(capabilityForRun(config(), { capabilityFlag: "image" })).toBe("image");
  });

  it("a class with an implied non-default capability and no provider of its own routes by capability", () => {
    // "image" is not configured as a class here, so it names no provider
    expect(capabilityForRun(config(), { className: "image" })).toBe("image");
  });

  it("a class already pinned to a provider (even one with a non-default alias) is left alone", () => {
    expect(capabilityForRun(config(), { className: "spotcheck" })).toBeNull(); // glm/fast
  });

  it("a class implying the default capability is left alone", () => {
    expect(capabilityForRun(config(), { className: "implement" })).toBeNull();
  });

  it("no flag and no class resolves nothing", () => {
    expect(capabilityForRun(config(), {})).toBeNull();
  });
});

describe("resolveCapabilityRun", () => {
  it("resolves to a runnable provider and passes through the engine", () => {
    const c = config({
      providers: {
        glm: { ...GLM },
        pictures: { ...GLM, engine: "image", models: { default: "p-default", image: "p-paint" } },
      },
      capabilities: { image: ["pictures"] },
    });
    const r = resolveCapabilityRun(c, "image");
    expect(r).toEqual({
      providerName: "pictures",
      provider: c.providers.pictures,
      model: "p-paint",
      engine: "image",
      fellBack: false,
      capability: "image",
    });
  });

  it("throws naming every checked provider when nothing in the preference list is usable", () => {
    const c = config({ capabilities: { image: ["glm"] } }); // glm has no image model
    expect(() => resolveCapabilityRun(c, "image")).toThrow(/glm/);
  });

  it("refuses a provider whose only claim to image is a classes-idiom models.image entry, not a real image engine", () => {
    // glm declares an "image" model (the classes-based `image: glm/image`
    // idiom) but has no engine: image — a run must not silently spawn
    // claude on that model and call it done
    const c = config({
      providers: { glm: { ...GLM, models: { default: "example-4.7", image: "example-paint" } } },
      capabilities: { image: ["glm"] },
    });
    expect(() => resolveCapabilityRun(c, "image")).toThrow(/has no image engine/);
    expect(() => resolveCapabilityRun(c, "image")).toThrow(/--engine image/);
  });

  it("refuses the active-provider fallback a run would otherwise silently get", () => {
    // no capabilities preference and no provider anywhere declares "image" —
    // resolveCapability alone would fall back to glm's default model, but a
    // run must not silently treat a text model as an image generator
    const c = config();
    expect(() => resolveCapabilityRun(c, "image")).toThrow(/no provider declares the "image" capability/);
    expect(() => resolveCapabilityRun(c, "image")).toThrow(/pai worker capability image/);
  });
});

describe("resolveTarget: fresh install (no active, no class map)", () => {
  const empty = () => parseWorkersConfig({ enabled: true });

  it("routes implement, simple and spotcheck to the built-in anthropic provider", () => {
    for (const className of ["implement", "simple", "spotcheck"]) {
      const t = resolveTarget(empty(), dir, { className });
      expect(t.providerName).toBe("anthropic");
      expect(t.provider.native).toBe(true);
    }
  });

  it("an explicit active provider still wins", () => {
    expect(resolveTarget(config({ classes: {} }), dir, { className: "implement" }).providerName).toBe("glm");
  });

  it("an explicit class mapping still wins", () => {
    expect(resolveTarget(config(), dir, { className: "spotcheck" }).modelAlias).toBe("fast");
  });

  it("a configured-but-missing active provider still errors", () => {
    expect(() => resolveTarget(config({ active: "gone", classes: {} }), dir, { className: "implement" })).toThrow(NoProviderError);
  });
});

// ---------------------------------------------------------------------------
// budget policy: provider fallback driven by the live budget
// ---------------------------------------------------------------------------

describe("resolveTarget — budget policy (live-budget fallback)", () => {
  // a private state dir: the budget tests write wall cooldowns
  const bdir = mkdtempSync(join(tmpdir(), "pai-workers-budget-"));
  const KIMI: WorkerProvider = { ...GLM, baseUrl: "https://kimi.example.com" };

  const budgetConfig = (over: Record<string, unknown> = {}) =>
    config({
      active: "auto",
      providers: { glm: GLM, kimi: KIMI },
      routing: {
        order: [],
        cooldownMinutes: 30,
        retryOnQuota: true,
        policy: "budget",
        priority: ["anthropic", "glm", "kimi"],
        budgetWalls: { anthropic: 95, glm: 90, kimi: 85 },
      },
      ...over,
    });

  const seed = (map: Record<string, [number | null, number | null]>) => {
    const now = Date.now();
    budgetCache.seed(
      Object.fromEntries(
        Object.entries(map).map(([k, [percent, resetAt]]) => [k, { percent, resetAt, fetchedAt: now } satisfies BudgetReading])
      )
    );
  };

  afterEach(() => {
    budgetCache.clear();
    writeRoutingState(bdir, { cooldowns: {} } satisfies RoutingState);
  });

  it("BudgetOrderSkipsWalled: a full anthropic sends the run to glm, with the switch reason", () => {
    // the operator scenario: anthropic 96%, resets in 30 min → next spawn goes glm
    seed({ anthropic: [96, Date.now() + 30 * 60_000], glm: [40, null], kimi: [60, null] });
    const t = resolveTarget(budgetConfig(), bdir, {});
    expect(t.providerName).toBe("glm");
    expect(t.via).toBe("auto");
    expect(t.switchReason).toMatch(/^glm: anthropic 96% until \d{2}:\d{2}$/);
  });

  it("PriorityRespectedWhenBudgetFree: anthropic first while it has budget, even behind glm", () => {
    seed({ anthropic: [80, null], glm: [10, null], kimi: [60, null] });
    const t = resolveTarget(budgetConfig(), bdir, {});
    expect(t.providerName).toBe("anthropic");
    expect(t.provider.native).toBe(true);
    expect(t.switchReason).toBeUndefined();
  });

  it("kimi serves when anthropic and glm are both walled, naming the first skip", () => {
    seed({ anthropic: [96, Date.now() + 30 * 60_000], glm: [92, Date.now() + 10 * 60_000], kimi: [60, null] });
    const t = resolveTarget(budgetConfig(), bdir, {});
    expect(t.providerName).toBe("kimi");
    expect(t.switchReason).toMatch(/^kimi: anthropic 96% until \d{2}:\d{2}$/);
  });

  it("WallCooldownUntilReset: the walled provider cools down until its reset, then re-enters", () => {
    // the operator scenario, end to end: wall → cooldown until resetAt → back on anthropic
    const resetAt = Date.now() + 30 * 60_000;
    seed({ anthropic: [96, resetAt] });
    recordBudgetCooldowns(budgetConfig(), bdir);
    // the cooldown runs to the reset, not just to the 10-minute floor
    const state = readRoutingState(bdir);
    expect(Math.abs(Date.parse(state.cooldowns["anthropic"]!) - resetAt)).toBeLessThan(1_000);

    const t = resolveTarget(budgetConfig(), bdir, {});
    expect(t.providerName).toBe("glm");

    // the window resets: anthropic re-enters on its own
    seed({ anthropic: [40, null] });
    writeRoutingState(bdir, { cooldowns: {} });
    const t2 = resolveTarget(budgetConfig(), bdir, {});
    expect(t2.providerName).toBe("anthropic");
    expect(t2.switchReason).toBeUndefined();
  });

  it("a wall closer than the floor still cools down for the full 10 minutes", () => {
    seed({ anthropic: [96, Date.now() + 3 * 60_000] });
    recordBudgetCooldowns(budgetConfig(), bdir);
    const state = readRoutingState(bdir);
    const ms = Date.parse(state.cooldowns["anthropic"]!) - Date.now();
    expect(ms).toBeGreaterThan(9 * 60_000);
    expect(ms).toBeLessThanOrEqual(10 * 60_000);
  });

  it("MidRunNoSwitch: a quota reroute never lands on a provider with no budget left", () => {
    // anthropic cooled down, kimi walled → there is nowhere good to reroute
    seed({ anthropic: [10, null], glm: [10, null], kimi: [90, null] });
    setCooldown(bdir, "anthropic", 30);
    expect(nextAutoProvider(budgetConfig(), bdir, "glm")).toBeNull();
    // kimi with room: the reroute takes it
    seed({ anthropic: [10, null], glm: [10, null], kimi: [60, null] });
    expect(nextAutoProvider(budgetConfig(), bdir, "glm")).toBe("kimi");
  });

  it("policy order keeps the verbatim walk and ignores budget readings", () => {
    seed({ anthropic: [96, Date.now() + 30 * 60_000], glm: [96, null], kimi: [96, null] });
    const c = budgetConfig({
      routing: { order: ["glm", "kimi"], cooldownMinutes: 30, retryOnQuota: true, policy: "order", priority: [], budgetWalls: {} },
    });
    const t = resolveTarget(c, bdir, {});
    expect(t.providerName).toBe("glm");
    expect(t.switchReason).toBeUndefined();
  });

  it("defaults: budget policy walks anthropic → glm → kimi, skipping the unconfigured", () => {
    const c = config({ active: "auto", providers: { glm: GLM } });
    expect(autoOrder(c)).toEqual(["anthropic", "glm", "kimi"]);
    // no readings at all: unknown never walls, plain priority wins
    const t = resolveTarget(c, bdir, {});
    expect(t.providerName).toBe("anthropic");
  });

  it("a class's own order wins over the priority list, budget walls still applied", () => {
    seed({ anthropic: [96, Date.now() + 30 * 60_000], glm: [96, Date.now() + 10 * 60_000], kimi: [10, null] });
    const c = budgetConfig({ classes: { research: { order: ["glm", "kimi"] } } });
    const t = resolveTarget(c, bdir, { className: "research" });
    expect(t.providerName).toBe("kimi");
    expect(t.switchReason).toMatch(/^kimi: glm 96% until \d{2}:\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// sticky session provider: per-window walls, budget fallback chain
// ---------------------------------------------------------------------------

describe("session provider — sticky, budget fallback, per-window walls", () => {
  const sdir = mkdtempSync(join(tmpdir(), "pai-workers-sticky-"));
  const LOCAL: WorkerProvider = { ...GLM, baseUrl: "http://127.0.0.1:8000" };
  const KIMI: WorkerProvider = { ...GLM, baseUrl: "https://kimi.example.com" };
  const env = (name: string) => ({ PAI_SESSION_PROVIDER: name }) as NodeJS.ProcessEnv;

  const cfg = (walls: Record<string, unknown>, over: Record<string, unknown> = {}) =>
    config({
      active: "kimi",
      providers: { glm: GLM, kimi: KIMI, local30x8: LOCAL },
      classes: { implement: "glm/fast" },
      routing: {
        order: [],
        cooldownMinutes: 30,
        retryOnQuota: true,
        policy: "budget",
        priority: ["anthropic", "local30x8", "glm", "kimi"],
        budgetWalls: walls,
      },
      ...over,
    });

  const seedW = (map: Record<string, Array<[string, number]>>) => {
    const now = Date.now();
    budgetCache.seed(
      Object.fromEntries(
        Object.entries(map).map(([k, ws]) => [
          k,
          {
            percent: Math.max(...ws.map(([, p]) => p)),
            resetAt: null,
            fetchedAt: now,
            windows: ws.map(([name, percent]) => ({ name, percent })),
          } satisfies BudgetReading,
        ])
      )
    );
  };

  afterEach(() => {
    budgetCache.clear();
    writeRoutingState(sdir, { cooldowns: {} } satisfies RoutingState);
  });

  it("a number wall applies to every window", () => {
    seedW({ anthropic: [["5h", 10], ["7d", 96]] });
    const t = resolveTarget(cfg({ anthropic: 95 }), sdir, { sessionEnv: env("anthropic") });
    expect(t.providerName).toBe("glm");
  });

  it("a map wall applies per window; 7d over its wall with 5h low is full", () => {
    seedW({ anthropic: [["5h", 5], ["7d", 71]] });
    const walls = { anthropic: { "5h": 95, "7d": 70 } };
    const t = resolveTarget(cfg(walls), sdir, { sessionEnv: env("anthropic") });
    expect(t.providerName).toBe("glm");
    expect(t.routeWhy).toContain("anthropic full (7d 71% >= 70) -> glm");
    seedW({ anthropic: [["5h", 5], ["7d", 69]] });
    expect(resolveTarget(cfg(walls), sdir, { sessionEnv: env("anthropic") }).providerName).toBe("anthropic");
  });

  it("session anthropic under its walls stays on anthropic (via session)", () => {
    seedW({ anthropic: [["5h", 20], ["7d", 30]], glm: [["5h", 1]] });
    const t = resolveTarget(cfg({}), sdir, { sessionEnv: env("anthropic"), className: "implement" });
    expect(t.providerName).toBe("anthropic");
    expect(t.via).toBe("session");
  });

  it("session anthropic 5h full -> glm; class pin, active and local in priority are ignored", () => {
    seedW({ anthropic: [["5h", 96], ["7d", 10]], glm: [["5h", 1], ["7d", 20]] });
    const t = resolveTarget(cfg({}), sdir, { sessionEnv: env("anthropic"), className: "implement" });
    expect(t.providerName).toBe("glm");
    expect(t.modelAlias).toBe("default");
    expect(t.routeWhy).toContain("anthropic full (5h 96% >= 95) -> glm");
  });

  it("local30x8 is never chosen by the fallback, even first in line", () => {
    seedW({ anthropic: [["5h", 99]], glm: [["5h", 99]], kimi: [["5h", 10]] });
    const c = cfg({}, { active: "glm" });
    const t = resolveTarget(c, sdir, { sessionEnv: env("anthropic") });
    expect(t.providerName).toBe("kimi");
  });

  it("every provider full keeps the old fall-through (class pin)", () => {
    seedW({ anthropic: [["5h", 99]], glm: [["5h", 99]], kimi: [["5h", 99]] });
    const t = resolveTarget(cfg({}), sdir, { sessionEnv: env("anthropic"), className: "implement" });
    expect(t.via).toBe("class");
    expect(t.providerName).toBe("glm");
  });

  it("no session provider: old behaviour, class pin wins", () => {
    seedW({ anthropic: [["5h", 99]] });
    const t = resolveTarget(cfg({}), sdir, { sessionEnv: {} as NodeJS.ProcessEnv, className: "implement", home: sdir, cwd: sdir });
    expect(t.via).toBe("class");
  });

  it("config validation: bad map values throw, number and map forms parse", () => {
    const mk = (budgetWalls: unknown) => () => config({ routing: { budgetWalls } });
    expect(mk({ anthropic: 90 })).not.toThrow();
    expect(mk({ anthropic: { "5h": 95, "7d": 70 } })).not.toThrow();
    expect(mk({ anthropic: { "7d": 170 } })).toThrow(/budgetWalls\.anthropic\.7d/);
    expect(mk({ anthropic: { "7d": "x" } })).toThrow();
    expect(mk({ anthropic: [1] })).toThrow();
  });
});
