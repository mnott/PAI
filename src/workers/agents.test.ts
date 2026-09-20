/**
 * Tests for agent model → class mapping: tier aliases keep working, provider
 * model ids map through the registry (fast → cheap tier, default → middle
 * tier, modelTiers override), and an unknown id falls back loudly instead of
 * dropping the hint silently.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { deriveLabel, modelTier, modelToClass } from "./agents.js";
import { parseWorkersConfig } from "./config.js";

const providers = parseWorkersConfig({
  providers: {
    glm: {
      baseUrl: "https://api.example.com/api/anthropic",
      keyFile: null,
      models: { default: "example-5.3", fast: "example-5.3-flash" },
      modelTiers: { "example-5.3-max": "opus" },
      env: {},
    },
  },
}).providers;

describe("modelTier", () => {
  it("recognizes the CLI tier aliases anywhere in the id", () => {
    expect(modelTier("claude-haiku-4-5")).toBe("haiku");
    expect(modelTier("claude-sonnet-5")).toBe("sonnet");
    expect(modelTier("claude-opus-5")).toBe("opus");
  });

  it("maps configured provider models into the tier table", () => {
    expect(modelTier("example-5.3-flash", providers)).toBe("haiku"); // fast → cheap tier
    expect(modelTier("example-5.3", providers)).toBe("sonnet"); // default → middle tier
    expect(modelTier("example-5.3-max", providers)).toBe("opus"); // modelTiers override
  });

  it("returns null for an id that matches nothing", () => {
    expect(modelTier("mystery-9")).toBeNull();
    expect(modelTier("example-5.3")).toBeNull(); // unknown without the registry
  });
});

describe("modelToClass", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps tiers to classes, claude ids unchanged", () => {
    expect(modelToClass("claude-haiku-4-5")).toBe("simple");
    expect(modelToClass("claude-sonnet-5")).toBe("implement");
    expect(modelToClass("claude-opus-5")).toBe("complex");
    expect(modelToClass(undefined)).toBeUndefined();
  });

  it("a configured fast model resolves to the cheap tier's class", () => {
    expect(modelToClass("example-5.3-flash", providers)).toBe("simple");
    expect(modelToClass("example-5.3", providers)).toBe("implement");
  });

  it("an unknown id logs once and falls back to the middle tier's class, not nothing", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(modelToClass("mystery-9")).toBe("implement");
    expect(modelToClass("mystery-9")).toBe("implement"); // second call: no new log
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0][0]).toContain('model "mystery-9"');
  });
});

describe("deriveLabel", () => {
  it("truncates a long first line to 48 chars and appends an ellipsis", () => {
    const prompt = "x".repeat(60);
    const label = deriveLabel(prompt, "implement");
    expect(label).toBe(`${"x".repeat(48)}…`);
  });

  it("strips a leading markdown marker (#, *, -, >)", () => {
    expect(deriveLabel("# Fix the login bug", "implement")).toBe("Fix the login bug");
    expect(deriveLabel("- do the thing", "implement")).toBe("do the thing");
    expect(deriveLabel("> quoted brief", "implement")).toBe("quoted brief");
    expect(deriveLabel("* starred item", "implement")).toBe("starred item");
  });

  it("collapses internal whitespace in the first line", () => {
    expect(deriveLabel("fix   the    thing", "implement")).toBe("fix the thing");
  });

  it("a multi-line prompt takes the first non-empty line", () => {
    expect(deriveLabel("\n\n  \nSecond real line\nmore text", "implement")).toBe("Second real line");
  });

  it("falls back to 'worker <class>' for an empty/whitespace-only prompt", () => {
    expect(deriveLabel("", "simple")).toBe("worker simple");
    expect(deriveLabel("   \n  \n", "simple")).toBe("worker simple");
    expect(deriveLabel(null, "simple")).toBe("worker simple");
    expect(deriveLabel(undefined, "simple")).toBe("worker simple");
  });
});
