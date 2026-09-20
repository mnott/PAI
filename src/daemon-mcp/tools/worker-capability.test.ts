/**
 * Tests for the worker_capability MCP tool handler (extracted so it can be
 * imported without starting the shim's transport). tmp config files only.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkersConfig } from "../../workers/config.js";
import { workerCapability } from "./worker-capability.js";

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
      models: { default: "example-5.3" },
      env: {},
    },
    pictures: {
      enabled: true,
      protocol: "anthropic",
      baseUrl: "https://images.example.com/v1",
      keyFile: null,
      models: { default: "example-paint", image: "example-paint" },
      engine: "image",
      env: {},
    },
  },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pai-mcp-capability-"));
  configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ workers: FIXTURE }, null, 2) + "\n", "utf8");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function capabilities(): Record<string, string[]> {
  return parseWorkersConfig(JSON.parse(readFileSync(configPath, "utf8")).workers).capabilities;
}

describe("worker_capability list", () => {
  it("says so when nothing is configured", () => {
    const r = workerCapability({}, configPath);
    expect(r.isError).toBeUndefined();
    expect(r.content[0]!.text).toMatch(/no capability preferences set/);
  });

  it("shows what a preference resolves to once one is set", () => {
    workerCapability({ action: "set", capability: "image", providers: ["pictures"] }, configPath);
    const r = workerCapability({ action: "list" }, configPath);
    expect(r.content[0]!.text).toContain("image: [pictures] -> pictures/example-paint  engine image");
  });
});

describe("worker_capability set", () => {
  it("sets a preference list and persists it", () => {
    const r = workerCapability(
      { action: "set", capability: "image", providers: ["pictures", "glm"] },
      configPath
    );
    expect(r.isError).toBeUndefined();
    expect(capabilities().image).toEqual(["pictures", "glm"]);
  });

  it("fails without a capability name", () => {
    const r = workerCapability({ action: "set", providers: ["pictures"] }, configPath);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/capability is required/);
  });

  it("fails with an empty providers list", () => {
    const r = workerCapability({ action: "set", capability: "image", providers: [] }, configPath);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/non-empty providers list/);
  });

  it("fails naming an unknown provider", () => {
    const r = workerCapability({ action: "set", capability: "image", providers: ["nope"] }, configPath);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/no provider named "nope"/);
  });
});

describe("worker_capability unset", () => {
  it("removes a preference", () => {
    workerCapability({ action: "set", capability: "image", providers: ["pictures"] }, configPath);
    const r = workerCapability({ action: "unset", capability: "image" }, configPath);
    expect(r.isError).toBeUndefined();
    expect(capabilities().image).toBeUndefined();
  });

  it("fails when nothing was set", () => {
    const r = workerCapability({ action: "unset", capability: "image" }, configPath);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/no capability preference set/);
  });
});
