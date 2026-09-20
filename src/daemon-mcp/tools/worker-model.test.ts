/**
 * Tests for the worker_model MCP tool handler (extracted so it can be
 * imported without starting the shim's transport). tmp config files only.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkersConfig } from "../../workers/config.js";
import { workerModel } from "./worker-model.js";

let dir: string;
let configPath: string;

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
  },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pai-mcp-model-"));
  configPath = join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ workers: FIXTURE }, null, 2) + "\n",
    "utf8"
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function models(): { default: string; fast?: string; image?: string } {
  return parseWorkersConfig(
    JSON.parse(readFileSync(configPath, "utf8")).workers
  ).providers.glm!.models;
}

describe("worker_model get", () => {
  it("defaults to get and lists every provider when provider is omitted", () => {
    const r = workerModel({}, configPath);
    expect(r.isError).toBeUndefined();
    const t = r.content[0]!.text;
    expect(t).toContain("active provider: glm");
    expect(t).toContain("default example-5.3");
    expect(t).toContain("fast example-5.3-flash");
  });

  it("narrows to one provider when given", () => {
    const r = workerModel({ provider: "glm" }, configPath);
    expect(r.content[0]!.text).toBe(
      "glm  default example-5.3  fast example-5.3-flash  image (none)"
    );
  });

  it("fails on an unknown provider", () => {
    const r = workerModel({ provider: "nope" }, configPath);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/no provider named "nope"/);
  });
});

describe("worker_model set", () => {
  it("sets the active provider's default model and reports the change", () => {
    const r = workerModel({ action: "set", model: "example-6" }, configPath);
    expect(r.isError).toBeUndefined();
    expect(r.content[0]!.text).toBe("glm default model: example-6");
    expect(models().default).toBe("example-6");
  });

  it("sets the fast slot of a named provider", () => {
    const r = workerModel(
      { action: "set", provider: "glm", slot: "fast", model: "example-6-flash" },
      configPath
    );
    expect(r.isError).toBeUndefined();
    expect(r.content[0]!.text).toBe("glm fast model: example-6-flash");
    expect(models().fast).toBe("example-6-flash");
  });

  it("sets the image capability and reports it", () => {
    const r = workerModel(
      { action: "set", provider: "glm", capability: "image", model: "example-paint" },
      configPath
    );
    expect(r.isError).toBeUndefined();
    expect(r.content[0]!.text).toBe("glm image model: example-paint");
    expect(models().image).toBe("example-paint");
    expect(models().default).toBe("example-5.3"); // untouched
  });

  it("sets a capability outside the well-known set (open set)", () => {
    const r = workerModel(
      { action: "set", provider: "glm", capability: "vision", model: "example-vision" },
      configPath
    );
    expect(r.isError).toBeUndefined();
    expect(r.content[0]!.text).toBe("glm vision model: example-vision");
    expect(models().default).toBe("example-5.3"); // untouched
  });

  it("still honours slot as the pre-capability spelling", () => {
    const r = workerModel({ action: "set", slot: "fast", model: "example-6-flash" }, configPath);
    expect(r.isError).toBeUndefined();
    expect(models().fast).toBe("example-6-flash");
  });

  it("rejects a slot and capability that disagree", () => {
    const r = workerModel(
      { action: "set", slot: "fast", capability: "image", model: "example-paint" },
      configPath
    );
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/disagree/);
    expect(models().image).toBeUndefined(); // nothing written
  });

  it("fails without a model id", () => {
    const r = workerModel({ action: "set" }, configPath);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/non-empty model id/);
    expect(models().default).toBe("example-5.3"); // untouched
  });
});
