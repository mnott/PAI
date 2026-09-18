/**
 * Tests for class/provider resolution and the runner-args parser.
 *
 * Pure functions, no claude/osascript calls — the routing decision is exactly
 * what a misrouted worker gets wrong, so it is pinned here.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkersConfig, type WorkerProvider } from "./config.js";
import { NoProviderError, resolveTarget, setCooldown } from "./routing.js";
import { parseRunnerArgs } from "./args.js";

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
