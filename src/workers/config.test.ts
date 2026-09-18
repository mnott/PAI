/**
 * Tests for the workers config schema.
 *
 * The workers section is hand-edited JSON on a live machine; a typo must name
 * the field, not produce a run that silently ignores half the config.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseWorkersConfig,
  assertProviderRunnable,
  providerContextWindow,
  readWorkersSection,
  writeWorkersSection,
  WorkersConfigError,
  DEFAULT_CACHE_KEEPALIVE_SECS,
} from "./config.js";

const GLM = {
  baseUrl: "https://api.example.com/api/anthropic",
  keyFile: "~/.config/example/api_key",
  models: { default: "example-4.7", fast: "example-4.7-flash" },
  env: { API_TIMEOUT_MS: "3000000" },
};

describe("parseWorkersConfig", () => {
  it("returns defaults for a missing section", () => {
    const c = parseWorkersConfig(undefined);
    expect(c.enabled).toBe(false);
    expect(c.providers).toEqual({});
    expect(c.pane).toEqual({ enabled: true, fontSize: 13, autoExitSecs: 60 });
    expect(c.logDir).toBe("~/.claude/logs/workers");
  });

  it("parses the reference glm-style config", () => {
    const c = parseWorkersConfig({
      enabled: true,
      active: "glm",
      providers: { glm: GLM },
      classes: { implement: "glm", research: "glm", spotcheck: "glm/fast" },
    });
    expect(c.active).toBe("glm");
    expect(c.providers.glm.models.fast).toBe("example-4.7-flash");
    expect(c.classes.spotcheck).toBe("glm/fast");
  });

  it("names the field on a bad protocol", () => {
    expect(() =>
      parseWorkersConfig({ providers: { glm: { ...GLM, protocol: "grpc" } } })
    ).toThrow(/providers\.glm\.protocol.*grpc/);
  });

  it("rejects a provider without a model", () => {
    expect(() =>
      parseWorkersConfig({
        providers: { glm: { ...GLM, models: { fast: "x" } } },
      })
    ).toThrow(/models\.default/);
  });

  it("rejects a providers.anthropic entry (reserved name)", () => {
    expect(() =>
      parseWorkersConfig({ providers: { anthropic: GLM } })
    ).toThrow(/anthropic.*reserved/i);
  });

  it("rejects classes whose target contains spaces", () => {
    expect(() =>
      parseWorkersConfig({ classes: { implement: "glm fast" } })
    ).toThrow(/classes\.implement/);
  });

  it("reads the legacy roles key as classes (migrates on first write)", () => {
    const c = parseWorkersConfig({ roles: { implement: "glm/fast" } });
    expect(c.classes.implement).toBe("glm/fast");
  });

  it("validates provider costTier and tags", () => {
    expect(() =>
      parseWorkersConfig({ providers: { glm: { ...GLM, costTier: 6 } } })
    ).toThrow(/costTier/);
    expect(() =>
      parseWorkersConfig({ providers: { glm: { ...GLM, tags: ["telepathy"] } } })
    ).toThrow(/tags/);
    const ok = parseWorkersConfig({
      providers: { glm: { ...GLM, costTier: 2, tags: ["code", "fast"] } },
    });
    expect(ok.providers.glm.costTier).toBe(2);
    expect(ok.providers.glm.tags).toEqual(["code", "fast"]);
  });

  // The statusline renders a provider's plan quota straight from this block
  // (docs/provider-abstraction.md carries the two shipped ones verbatim), so
  // the jq expressions must survive parsing untouched — a mangled expression
  // shows up as a missing percentage on the status line, never as an error.
  // Hosts are neutral here; the window expressions are the shipped ones.
  const CREDIT_USAGE = {
    url: "https://api.example.com/api/monitor/usage/quota/limit",
    label: "example",
    ttlSeconds: 60,
    windows: [
      {
        name: "5h",
        percent: ".data.limits[]? | select(.number == 5) | .percentage",
        resetAt: ".data.limits[]? | select(.number == 5) | .nextResetTime",
        resetUnit: "ms",
      },
      {
        name: "7d",
        percent: ".data.limits[]? | select(.number == 1) | .percentage",
        resetAt: ".data.limits[]? | select(.number == 1) | .nextResetTime",
        resetUnit: "ms",
      },
    ],
  };

  it("parses a credit-plan usage block with epoch-ms resets", () => {
    const c = parseWorkersConfig({
      providers: { glm: { ...GLM, usage: CREDIT_USAGE } },
    });
    const u = c.providers.glm.usage!;
    expect(u.url).toBe(CREDIT_USAGE.url);
    expect(u.label).toBe("example");
    expect(u.ttlSeconds).toBe(60);
    expect(u.windows.map((w) => w.name)).toEqual(["5h", "7d"]);
    expect(u.windows[0].percent).toBe(".data.limits[]? | select(.number == 5) | .percentage");
    expect(u.windows[1].resetAt).toBe(".data.limits[]? | select(.number == 1) | .nextResetTime");
    expect(u.windows[1].resetUnit).toBe("ms");
  });

  it("parses ISO resets and a percent computed from a used/limit pair", () => {
    // A plan that reports fractions (0.0262 = 2.62%) and a request-count
    // window carrying no percentage at all: both are expressible as jq, so
    // neither needs a schema extension.
    const c = parseWorkersConfig({
      providers: {
        kimi: {
          ...GLM,
          usage: {
            url: "https://api.example.com/coding/v1/usages",
            authHeader: "Authorization: Bearer",
            windows: [
              {
                name: "5h",
                percent: ".usages.limit_5h.used_ratio * 100",
                resetAt: ".usages.limit_5h.reset_time",
                resetUnit: "iso",
              },
              {
                name: "req",
                percent:
                  "(.limits[0].detail.used | tonumber) / (.limits[0].detail.limit | tonumber) * 100",
                resetAt: ".limits[0].detail.resetTime",
                resetUnit: "iso",
              },
            ],
          },
        },
      },
    });
    const u = c.providers.kimi.usage!;
    expect(u.authHeader).toBe("Authorization: Bearer");
    expect(u.windows[0].percent).toBe(".usages.limit_5h.used_ratio * 100");
    expect(u.windows[0].resetUnit).toBe("iso");
    expect(u.windows[1].percent).toBe(
      "(.limits[0].detail.used | tonumber) / (.limits[0].detail.limit | tonumber) * 100"
    );
  });

  it("omits usage defaults the config did not state", () => {
    const c = parseWorkersConfig({
      providers: {
        glm: {
          ...GLM,
          usage: { url: "https://api.example.com/usage", windows: [{ name: "5h", percent: ".pct" }] },
        },
      },
    });
    const u = c.providers.glm.usage!;
    expect(u.authHeader).toBeUndefined();
    expect(u.label).toBeUndefined();
    expect(u.ttlSeconds).toBeUndefined();
    expect(u.windows[0].resetAt).toBeUndefined();
    expect(u.windows[0].resetUnit).toBeUndefined();
  });

  it("names the offending field on a bad usage block", () => {
    const withUsage = (usage: unknown) =>
      parseWorkersConfig({ providers: { glm: { ...GLM, usage } } });
    expect(() => withUsage({ windows: CREDIT_USAGE.windows })).toThrow(/usage\.url/);
    expect(() => withUsage({ url: "https://api.example.com/usage", windows: [] })).toThrow(
      /usage\.windows/
    );
    expect(() =>
      withUsage({ url: "https://api.example.com/usage", windows: [{ percent: ".pct" }] })
    ).toThrow(/windows\[0\]\.name/);
    expect(() =>
      withUsage({ url: "https://api.example.com/usage", windows: [{ name: "5h" }] })
    ).toThrow(/windows\[0\]\.percent/);
  });

  it("rejects an unknown resetUnit and a non-positive ttl", () => {
    const withUsage = (usage: unknown) =>
      parseWorkersConfig({ providers: { glm: { ...GLM, usage } } });
    expect(() =>
      withUsage({
        url: "https://api.example.com/usage",
        windows: [{ name: "5h", percent: ".pct", resetAt: ".at", resetUnit: "fortnights" }],
      })
    ).toThrow(/windows\[0\]\.resetUnit/);
    expect(() =>
      withUsage({
        url: "https://api.example.com/usage",
        ttlSeconds: 0,
        windows: [{ name: "5h", percent: ".pct" }],
      })
    ).toThrow(/usage\.ttlSeconds/);
  });

  it("validates class constraint fields", () => {
    expect(() =>
      parseWorkersConfig({ classes: { research: { maxCostTier: 9 } } })
    ).toThrow(/classes\.research\.maxCostTier/);
    expect(() =>
      parseWorkersConfig({ classes: { research: { requireTags: ["nope"] } } })
    ).toThrow(/classes\.research\.requireTags/);
  });

  it("tolerates an active provider that no longer exists (parse-time)", () => {
    const c = parseWorkersConfig({ active: "gone", providers: { glm: GLM } });
    expect(c.active).toBe("gone");
  });

  it("reads pane.fontSize and ignores the legacy fontScale", () => {
    const c = parseWorkersConfig({ pane: { fontSize: 11, autoExitSecs: 30 } });
    expect(c.pane.fontSize).toBe(11);
    // fontScale is the pre-fontSize relative scale: tolerated, never applied
    const legacy = parseWorkersConfig({ pane: { fontScale: 0.6 } });
    expect(legacy.pane.fontSize).toBe(13);
  });

  it("names the field on a bad pane.fontSize", () => {
    expect(() => parseWorkersConfig({ pane: { fontSize: 0 } })).toThrow(/pane\.fontSize/);
  });

  it("defaults the sub-worker caps to depth 2, 4 children", () => {
    const c = parseWorkersConfig(undefined);
    expect(c.tree).toEqual({ maxDepth: 2, maxChildren: 4 });
  });

  it("reads custom tree caps and names the field on bad ones", () => {
    const c = parseWorkersConfig({ tree: { maxDepth: 3, maxChildren: 8 } });
    expect(c.tree).toEqual({ maxDepth: 3, maxChildren: 8 });
    expect(() => parseWorkersConfig({ tree: { maxDepth: -1 } })).toThrow(/tree\.maxDepth/);
    expect(() => parseWorkersConfig({ tree: { maxDepth: 1.5 } })).toThrow(/tree\.maxDepth/);
    expect(() => parseWorkersConfig({ tree: { maxChildren: 0 } })).toThrow(/tree\.maxChildren/);
    expect(() => parseWorkersConfig({ tree: "wide" })).toThrow(/tree/);
  });

  it("ships a desktop mcpSet (clickr) that a user section can override", () => {
    expect(parseWorkersConfig(undefined).mcpSets.desktop).toEqual(["clickr"]);
    const custom = parseWorkersConfig({ mcpSets: { desktop: ["clickr", "screencap"] } });
    expect(custom.mcpSets.desktop).toEqual(["clickr", "screencap"]);
    // desktop: [] removes the set deliberately, it does not resurrect
    const off = parseWorkersConfig({ mcpSets: { desktop: [] } });
    expect(off.mcpSets.desktop).toEqual([]);
  });
});

describe("assertProviderRunnable", () => {
  it("refuses openai protocol without an upstreamUrl (the proxy needs it)", () => {
    expect(() =>
      assertProviderRunnable("p", { ...GLM, protocol: "openai" } as never)
    ).toThrow(WorkersConfigError);
    expect(() =>
      assertProviderRunnable("p", { ...GLM, protocol: "openai" } as never)
    ).toThrow(/upstreamUrl/);
  });

  it("accepts an openai provider with an upstreamUrl (runs through the proxy)", () => {
    expect(() =>
      assertProviderRunnable("p", { ...GLM, protocol: "openai", upstreamUrl: "https://api.example.com/v1" } as never)
    ).not.toThrow();
  });

  it("accepts the codex engine", () => {
    expect(() =>
      assertProviderRunnable("p", { ...GLM, engine: "codex" } as never)
    ).not.toThrow();
  });

  it("accepts a plain anthropic provider", () => {
    expect(() => assertProviderRunnable("glm", GLM as never)).not.toThrow();
  });
});

describe("modelTiers", () => {
  it("parses model id → tier overrides", () => {
    const c = parseWorkersConfig({
      providers: { glm: { ...GLM, modelTiers: { "example-4.7-max": "opus" } } },
    });
    expect(c.providers.glm.modelTiers).toEqual({ "example-4.7-max": "opus" });
  });

  it("names the field on a bad tier value", () => {
    expect(() =>
      parseWorkersConfig({
        providers: { glm: { ...GLM, modelTiers: { "example-4.7-max": "ultra" } } },
      })
    ).toThrow(/providers\.glm\.modelTiers\.example-4\.7-max/);
  });
});

describe("providerContextWindow", () => {
  it("prefers an explicit contextWindow over anything derivable", () => {
    const c = parseWorkersConfig({
      providers: { glm: { ...GLM, models: { ...GLM.models, default: "example-5.3[1m]" }, contextWindow: 128_000 } },
    });
    expect(providerContextWindow(c.providers.glm)).toBe(128_000);
  });

  it("derives the window from the default model's id ([1m] → 1M)", () => {
    const c = parseWorkersConfig({
      providers: { glm: { ...GLM, models: { ...GLM.models, default: "example-5.3[1m]" } } },
    });
    expect(providerContextWindow(c.providers.glm)).toBe(1_000_000);
  });

  it("falls back to the last-resort default for an id with no window information", () => {
    const c = parseWorkersConfig({ providers: { glm: GLM } });
    expect(providerContextWindow(c.providers.glm)).toBe(200_000);
  });
});

describe("writeWorkersSection — round-trip (the 2026-09-18 regression)", () => {
  it("writes the loaded values back, preserving every other section", () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-workers-cfg-"));
    try {
      const path = join(dir, "config.json");
      const raw = {
        socketPath: "/tmp/pai.sock",
        indexIntervalSecs: 86400,
        identity: { selfEmails: ["owner@example.ch"] },
        workers: {
          enabled: true,
          active: "glm",
          providers: { glm: { ...GLM, models: { ...GLM.models, default: "example-5.3" } } },
          logDir: join(dir, "logs"),
        },
      };
      writeFileSync(path, JSON.stringify(raw, null, 2) + "\n", "utf8");

      // load → modify one value → save the same object: the shape every
      // legitimate config mutation must go through
      const loaded = readWorkersSection(path);
      loaded.workers.pane.fontSize = 15;
      writeWorkersSection(loaded.raw, loaded.workers, path);

      const reread = readWorkersSection(path);
      expect(reread.workers.pane.fontSize).toBe(15);
      expect(reread.workers.providers.glm.models.default).toBe("example-5.3");
      expect(reread.workers.enabled).toBe(true);
      // untouched sections survive the write
      const saved = JSON.parse(readFileSync(path, "utf8"));
      expect(saved.socketPath).toBe("/tmp/pai.sock");
      expect(saved.identity).toEqual(raw.identity);
      // and no schema-shaped dump ever appears in the file
      const text = readFileSync(path, "utf8");
      expect(text).not.toContain("socketPath: string");
      expect(text).not.toMatch(/":\s*"(int|bool)"\s*$/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cacheKeepaliveSecs knob", () => {
  it("defaults to DEFAULT_CACHE_KEEPALIVE_SECS when absent", () => {
    const c = parseWorkersConfig({ providers: { glm: GLM } });
    expect(c.cacheKeepaliveSecs).toBe(DEFAULT_CACHE_KEEPALIVE_SECS);
    expect(DEFAULT_CACHE_KEEPALIVE_SECS).toBe(0); // off until the operator arms it
  });

  it("parses 0 as off and a positive cadence verbatim", () => {
    expect(parseWorkersConfig({ cacheKeepaliveSecs: 0 }).cacheKeepaliveSecs).toBe(0);
    expect(parseWorkersConfig({ cacheKeepaliveSecs: 120 }).cacheKeepaliveSecs).toBe(120);
  });

  it("rejects negative and non-integer values by field name", () => {
    expect(() => parseWorkersConfig({ cacheKeepaliveSecs: -1 })).toThrow(
      WorkersConfigError
    );
    expect(() => parseWorkersConfig({ cacheKeepaliveSecs: -1 })).toThrow(
      /\.cacheKeepaliveSecs/
    );
    expect(() => parseWorkersConfig({ cacheKeepaliveSecs: 1.5 })).toThrow(
      /\.cacheKeepaliveSecs/
    );
    expect(() => parseWorkersConfig({ cacheKeepaliveSecs: "120" })).toThrow(
      /\.cacheKeepaliveSecs/
    );
  });
});

