/**
 * Tests for model selection: the shared set/read logic behind `pai worker
 * model` and the worker_model MCP tool. tmp config files only.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classModelCapability,
  parseWorkersConfig,
  resolveModelCapability,
  WorkersConfigError,
  type WorkerProvider,
} from "./config.js";
import { describeModels, resolveProviderName, setProviderModel } from "./providers.js";
import { buildRunEnv } from "./run-env.js";

let dir: string;
let configPath: string;

function writeConfig(workers: unknown): void {
  writeFileSync(configPath, JSON.stringify({ workers }, null, 2) + "\n", "utf8");
}

function readModels(): { default: string; fast?: string; image?: string } {
  const c = parseWorkersConfig(
    JSON.parse(readFileSync(configPath, "utf8")).workers
  );
  return c.providers.glm!.models;
}

/** A minimal runnable provider for resolution tests. */
const provider = (models: WorkerProvider["models"]): WorkerProvider => ({
  enabled: true,
  protocol: "anthropic",
  baseUrl: "https://api.example.com",
  keyFile: null,
  models,
  env: {},
});

const FIXTURE = {
  enabled: true,
  active: "glm",
  providers: {
    glm: {
      enabled: true,
      protocol: "anthropic",
      baseUrl: "https://api.example.com/api/anthropic",
      keyFile: null,
      models: { default: "example-5.3", fast: "example-5.3-flash" },
      env: {},
    },
    other: {
      enabled: true,
      protocol: "anthropic",
      baseUrl: "https://other.example.com/api/anthropic",
      keyFile: null,
      models: { default: "other-1" },
      env: {},
    },
  },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pai-workers-model-"));
  configPath = join(dir, "config.json");
  writeConfig(FIXTURE);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveProviderName", () => {
  it("returns the named provider, else the active one", () => {
    const c = parseWorkersConfig(FIXTURE);
    expect(resolveProviderName(c, "other")).toBe("other");
    expect(resolveProviderName(c)).toBe("glm");
  });

  it("rejects unknown names and an unset/auto active", () => {
    const c = parseWorkersConfig(FIXTURE);
    expect(() => resolveProviderName(c, "nope")).toThrow(/no provider named "nope"/);
    const unset = parseWorkersConfig({ ...FIXTURE, active: null });
    expect(() => resolveProviderName(unset)).toThrow(/no active provider/);
    const auto = parseWorkersConfig({ ...FIXTURE, active: "auto" });
    expect(() => resolveProviderName(auto)).toThrow(/"auto"/);
  });
});

describe("setProviderModel", () => {
  it("sets the default model and persists it through the config file", () => {
    const c = setProviderModel("glm", "default", "example-6", configPath);
    expect(c.providers.glm!.models.default).toBe("example-6");
    expect(readModels().default).toBe("example-6");
    expect(readModels().fast).toBe("example-5.3-flash"); // untouched
  });

  it("sets the fast model, adding it when the provider had none", () => {
    setProviderModel("other", "fast", "other-1-mini", configPath);
    const other = parseWorkersConfig(
      JSON.parse(readFileSync(configPath, "utf8")).workers
    ).providers.other!;
    expect(other.models.fast).toBe("other-1-mini");
    expect(other.models.default).toBe("other-1"); // untouched
  });

  it("rejects empty or whitespace ids and unknown providers", () => {
    expect(() => setProviderModel("glm", "default", "  ", configPath)).toThrow(
      /must not be empty/
    );
    expect(() => setProviderModel("nope", "default", "m", configPath)).toThrow(
      WorkersConfigError
    );
  });
});

describe("model capabilities", () => {
  it("sets the image capability, persisting it next to default and fast", () => {
    const c = setProviderModel("glm", "image", "example-paint", configPath);
    expect(c.providers.glm!.models.image).toBe("example-paint");
    expect(readModels().image).toBe("example-paint");
    expect(readModels().default).toBe("example-5.3"); // untouched
    expect(readModels().fast).toBe("example-5.3-flash"); // untouched
  });

  it("rejects a capability outside MODEL_CAPABILITIES", () => {
    expect(() =>
      setProviderModel("glm", "vision" as never, "m", configPath)
    ).toThrow(/not a model capability/);
  });

  it("parses an image preference from the config file", () => {
    writeConfig({
      ...FIXTURE,
      providers: {
        ...FIXTURE.providers,
        glm: {
          ...FIXTURE.providers.glm,
          models: { default: "example-5.3", image: "example-paint" },
        },
      },
    });
    const c = parseWorkersConfig(
      JSON.parse(readFileSync(configPath, "utf8")).workers
    );
    expect(c.providers.glm!.models.image).toBe("example-paint");
    expect(c.providers.glm!.models.fast).toBeUndefined();
  });

  it("rejects an unknown or empty capability key at parse time", () => {
    const withVision = {
      ...FIXTURE,
      providers: {
        ...FIXTURE.providers,
        glm: { ...FIXTURE.providers.glm, models: { default: "m", vision: "v" } },
      },
    };
    expect(() => parseWorkersConfig(withVision)).toThrow(
      /models\.vision.*not a model capability/
    );
    const withEmpty = {
      ...FIXTURE,
      providers: {
        ...FIXTURE.providers,
        glm: { ...FIXTURE.providers.glm, models: { default: "m", fast: "" } },
      },
    };
    expect(() => parseWorkersConfig(withEmpty)).toThrow(
      /models\.fast.*non-empty/
    );
  });
});

describe("resolveModelCapability", () => {
  it("returns the capability's preference when set", () => {
    const p = provider({ default: "big", fast: "small", image: "painter" });
    expect(resolveModelCapability(p, "fast")).toBe("small");
    expect(resolveModelCapability(p, "image")).toBe("painter");
    expect(resolveModelCapability(p, "default")).toBe("big");
  });

  it("falls back to the default model when a capability is unset", () => {
    const p = provider({ default: "big" });
    expect(resolveModelCapability(p, "fast")).toBe("big");
    expect(resolveModelCapability(p, "image")).toBe("big");
  });
});

describe("classModelCapability", () => {
  it("maps the image class to the image capability, everything else to default", () => {
    expect(classModelCapability("image")).toBe("image");
    expect(classModelCapability("implement")).toBe("default");
    expect(classModelCapability("spotcheck")).toBe("default");
    expect(classModelCapability(undefined)).toBe("default");
    expect(classModelCapability("made-up-class")).toBe("default");
  });
});

describe("model resolution in the run env", () => {
  it("pins the fast model as haiku, falling back to default when unset", () => {
    const env = buildRunEnv(provider({ default: "big", fast: "small" }), true);
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("small");
    const fallback = buildRunEnv(provider({ default: "big" }), true);
    expect(fallback.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("big");
  });
});

describe("describeModels", () => {
  it("lists the active provider and every provider's model ids", () => {
    const lines = describeModels(parseWorkersConfig(FIXTURE));
    expect(lines[0]).toBe("active provider: glm");
    expect(lines[1]).toContain("glm");
    expect(lines[1]).toContain("default example-5.3");
    expect(lines[1]).toContain("fast example-5.3-flash");
    expect(lines[1]).toContain("image (none)"); // unset capability, resolves to default
    expect(lines[2]).toContain("other");
    expect(lines[2]).toContain("fast (none)");
  });

  it("lists an image preference when one is set", () => {
    const lines = describeModels(
      parseWorkersConfig({
        ...FIXTURE,
        providers: {
          ...FIXTURE.providers,
          glm: {
            ...FIXTURE.providers.glm,
            models: { ...FIXTURE.providers.glm.models, image: "example-paint" },
          },
        },
      })
    );
    expect(lines[1]).toContain("image example-paint");
  });

  it("says so when no providers are configured", () => {
    const lines = describeModels(parseWorkersConfig({}));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/no providers configured/);
  });
});
