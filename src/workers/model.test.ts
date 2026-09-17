/**
 * Tests for model selection: the shared set/read logic behind `pai worker
 * model` and the worker_model MCP tool. tmp config files only.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkersConfig, WorkersConfigError } from "./config.js";
import { describeModels, resolveProviderName, setProviderModel } from "./providers.js";

let dir: string;
let configPath: string;

function writeConfig(workers: unknown): void {
  writeFileSync(configPath, JSON.stringify({ workers }, null, 2) + "\n", "utf8");
}

function readModels(): { default: string; fast?: string } {
  const c = parseWorkersConfig(
    JSON.parse(readFileSync(configPath, "utf8")).workers
  );
  return c.providers.glm!.models;
}

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

describe("describeModels", () => {
  it("lists the active provider and every provider's model ids", () => {
    const lines = describeModels(parseWorkersConfig(FIXTURE));
    expect(lines[0]).toBe("active provider: glm");
    expect(lines[1]).toContain("glm");
    expect(lines[1]).toContain("default example-5.3");
    expect(lines[1]).toContain("fast example-5.3-flash");
    expect(lines[2]).toContain("other");
    expect(lines[2]).toContain("fast (none)");
  });

  it("says so when no providers are configured", () => {
    const lines = describeModels(parseWorkersConfig({}));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/no providers configured/);
  });
});
