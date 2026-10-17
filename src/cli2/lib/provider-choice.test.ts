import { describe, expect, it } from "vitest";
import { CliError } from "../define.js";
import { assertAvailable, chooseProvider, inferOrigin, modelFor } from "./provider-choice.js";

const providers = {
  glm: { enabled: true, models: { default: "glm-5.3[1m]", fast: "glm-5.3-flash" } },
  kimi: { enabled: true, models: { default: "k3[1m]" } },
  off: { enabled: false, models: { default: "off-model" } },
};

describe("inferOrigin", () => {
  it("maps a transcript model to the configured provider that owns it, variant suffix ignored", () => {
    expect(inferOrigin("glm-5.3", providers)).toEqual({ provider: "glm", model: "glm-5.3" });
  });
  it("calls a claude-* model anthropic", () => {
    expect(inferOrigin("claude-opus-5-5", providers)?.provider).toBe("anthropic");
  });
  it("ignores disabled providers and unknown models", () => {
    expect(inferOrigin("off-model", providers)).toBeNull();
    expect(inferOrigin(null, providers)).toBeNull();
  });
});

describe("chooseProvider precedence: flag > session > active > anthropic", () => {
  const origin = { provider: "glm", model: "glm-5.3" };

  it("an explicit --provider beats the session's provider and the active one", () => {
    const c = chooseProvider({ flagProvider: "kimi", origin, active: "glm" });
    expect(c).toEqual({ provider: "kimi", model: undefined, source: "flag" });
  });
  it("an explicit --provider equal to the session's keeps the session's model", () => {
    expect(chooseProvider({ flagProvider: "glm", origin, active: "kimi" }).model).toBe("glm-5.3");
  });
  it("--model is honoured with --provider", () => {
    expect(chooseProvider({ flagProvider: "kimi", flagModel: "k3[1m]", origin, active: null }).model).toBe("k3[1m]");
  });
  it("without a flag the session's own provider beats the active one", () => {
    expect(chooseProvider({ origin, active: "kimi" })).toEqual({ provider: "glm", model: "glm-5.3", source: "session" });
  });
  it("with neither, the active provider", () => {
    expect(chooseProvider({ origin: null, active: "kimi" })).toEqual({ provider: "kimi", model: undefined, source: "active" });
  });
  it("active 'auto' or none means plain anthropic", () => {
    expect(chooseProvider({ origin: null, active: "auto" }).provider).toBe("anthropic");
    expect(chooseProvider({ origin: null, active: null })).toMatchObject({ provider: "anthropic", source: "default" });
  });
});

describe("assertAvailable", () => {
  it("passes for an available provider", () => {
    expect(() => assertAvailable("glm", ["anthropic", "glm"], (a) => a)).not.toThrow();
  });
  it("fails with the reason, the available list and an exact command that works", () => {
    try {
      assertAvailable("nope", ["anthropic", "glm"], (alt) => `pai open X --provider ${alt}`);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      const err = e as CliError;
      expect(err.message).toContain('"nope" is not available');
      expect(err.message).toContain("anthropic, glm");
      expect(err.hint).toBe("pai open X --provider anthropic");
    }
  });
});

describe("modelFor", () => {
  it("keeps a recorded model only when the target offers it", () => {
    expect(modelFor(providers.glm, "glm-5.3")).toBe("glm-5.3[1m]");
    expect(modelFor(providers.kimi, "glm-5.3")).toBeUndefined();
    expect(modelFor(providers.kimi, undefined)).toBeUndefined();
  });
});
