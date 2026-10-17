/**
 * Tests for the model step-down (run.ts): a worker never runs on the
 * orchestrator's own model — observed 2026-10-17, when the default class
 * resolved glm's default (glm-5.3[1m]) while the orchestrating session
 * itself ran on glm-5.3[1m], and nothing detected the equality.
 */

import { describe, expect, it } from "vitest";
import { canonicalModelId, stepDownOrchestratorModel } from "./run.js";
import { nativeAnthropicProvider, type WorkerProvider } from "./config.js";

const glm: WorkerProvider = {
  enabled: true,
  protocol: "anthropic",
  baseUrl: "https://api.z.ai/api/anthropic",
  keyFile: null,
  models: { default: "glm-5.3[1m]", fast: "glm-5.3-flash" },
  env: {},
};

/** The env an orchestrating glm session carries (buildRunEnv set it). */
const orchestratorEnv = { ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.3[1m]" };

const step = (over: Partial<Parameters<typeof stepDownOrchestratorModel>[0]> = {}) =>
  stepDownOrchestratorModel({
    resolved: "glm-5.3",
    providerName: "glm",
    provider: glm,
    env: orchestratorEnv,
    ...over,
  });

describe("canonicalModelId", () => {
  it("strips a bracketed context suffix", () => {
    expect(canonicalModelId("glm-5.3[1m]")).toBe("glm-5.3");
    expect(canonicalModelId("glm-5.3")).toBe("glm-5.3");
    expect(canonicalModelId("glm-5.3[1m]")).toBe(canonicalModelId("glm-5.3"));
  });

  it("leaves ids without a suffix alone", () => {
    expect(canonicalModelId("claude-sonnet-5")).toBe("claude-sonnet-5");
  });
});

describe("stepDownOrchestratorModel", () => {
  it("class resolves to the orchestrator's model, no --model → fast model, notice line", () => {
    const r = step();
    expect(r.model).toBe("glm-5.3-flash");
    expect(r.notice).toBe(
      "pai: worker model == orchestrator model — stepped down to glm-5.3-flash " +
        "(workers never inherit the orchestrator's model); pass --model to override"
    );
  });

  it("explicit --model equal to the orchestrator's → unchanged, no notice", () => {
    const r = step({ resolved: "glm-5.3", modelFlag: "glm-5.3[1m]" });
    expect(r.model).toBe("glm-5.3");
    expect(r.notice).toBeNull();
  });

  it("a --model pinned in the claude args counts as explicit too", () => {
    const r = step({ callerPinned: true });
    expect(r.model).toBe("glm-5.3");
    expect(r.notice).toBeNull();
  });

  it("resolved model different from the orchestrator's → unchanged", () => {
    const r = step({ resolved: "glm-5.3-flash" });
    expect(r.model).toBe("glm-5.3-flash");
    expect(r.notice).toBeNull();
  });

  it("provider without a distinct fast model → unchanged + warning line", () => {
    const r = step({ provider: { ...glm, models: { default: "glm-5.3[1m]" } } });
    expect(r.model).toBe("glm-5.3");
    expect(r.notice).toContain("no distinct fast model");
    expect(r.notice).toContain("keeping glm-5.3");
  });

  it("a fast model equal to the resolved one is not a step-down either", () => {
    const r = step({ provider: { ...glm, models: { default: "glm-5.3[1m]", fast: "glm-5.3[1m]" } } });
    expect(r.model).toBe("glm-5.3");
    expect(r.notice).toContain("no distinct fast model");
  });

  it("undetectable orchestrator model → unchanged", () => {
    const r = step({ env: {} });
    expect(r.model).toBe("glm-5.3");
    expect(r.notice).toBeNull();
  });

  it("the built-in anthropic provider steps down to haiku", () => {
    const r = stepDownOrchestratorModel({
      resolved: "sonnet",
      providerName: "anthropic",
      provider: nativeAnthropicProvider(),
      env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "sonnet" },
    });
    expect(r.model).toBe("haiku");
    expect(r.notice).toContain("stepped down to haiku");
  });
});
