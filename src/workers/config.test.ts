/**
 * Tests for the workers config schema.
 *
 * The workers section is hand-edited JSON on a live machine; a typo must name
 * the field, not produce a run that silently ignores half the config.
 */

import { describe, it, expect } from "vitest";
import {
  parseWorkersConfig,
  assertProviderRunnable,
  WorkersConfigError,
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
      roles: { implement: "glm", research: "glm", spotcheck: "glm/fast" },
    });
    expect(c.active).toBe("glm");
    expect(c.providers.glm.models.fast).toBe("example-4.7-flash");
    expect(c.roles.spotcheck).toBe("glm/fast");
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

  it("rejects roles whose target contains spaces", () => {
    expect(() =>
      parseWorkersConfig({ roles: { implement: "glm fast" } })
    ).toThrow(/roles\.implement/);
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
