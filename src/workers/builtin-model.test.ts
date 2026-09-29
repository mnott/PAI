/**
 * worker model get/set on the built-in `anthropic` provider. Every test uses a
 * temp-dir config.json + workers.yaml (PAI_WORKERS_YAML); the live config is
 * never touched.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readWorkersSection } from "./config.js";
import { describeModels, resolveProviderName, setProviderModel } from "./providers.js";
import { workerModel } from "../daemon-mcp/tools/worker-model.js";

const YAML = `# top comment
active: anthropic   # active comment

providers:
  anthropic:
    builtin: true   # builtin comment
    models:
      default: sonnet   # default comment
  glm:
    url: https://api.example.com/anthropic
    key: "k"
    models:
      default: glm-1
`;

let dir: string;
let configPath: string;
let yamlPath: string;
const savedEnv = process.env.PAI_WORKERS_YAML;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pai-builtin-model-"));
  configPath = join(dir, "config.json");
  yamlPath = join(dir, "workers.yaml");
  writeFileSync(configPath, "{}\n", "utf8");
  writeFileSync(yamlPath, YAML, "utf8");
  process.env.PAI_WORKERS_YAML = yamlPath;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.PAI_WORKERS_YAML;
  else process.env.PAI_WORKERS_YAML = savedEnv;
  rmSync(dir, { recursive: true, force: true });
});

describe("built-in anthropic provider models", () => {
  it("get shows the config table merged over the native defaults", () => {
    const { workers } = readWorkersSection(configPath);
    expect(describeModels(workers).join("\n")).toMatch(/anthropic\s+\[active\]\s+default sonnet\s+fast haiku/);
    const r = workerModel({ action: "get", provider: "anthropic" }, configPath);
    expect(r.isError).toBeUndefined();
    expect(r.content[0]!.text).toMatch(/^anthropic\s+default sonnet\s+fast haiku/);
  });

  it("set default and fast writes the table and keeps comments", () => {
    setProviderModel("anthropic", "default", "opus", configPath);
    const r = workerModel({ action: "set", provider: "anthropic", capability: "fast", model: "haiku-x" }, configPath);
    expect(r.isError).toBeUndefined();
    expect(r.content[0]!.text).toBe("anthropic fast model: haiku-x");
    const text = readFileSync(yamlPath, "utf8");
    expect(text).toMatch(/default: opus\s+# default comment/);
    expect(text).toMatch(/fast: haiku-x/);
    expect(text).toContain("# top comment");
    expect(text).toContain("# active comment");
    expect(text).toContain("# builtin comment");
    const { workers } = readWorkersSection(configPath);
    expect(workers.nativeModels).toMatchObject({ default: "opus", fast: "haiku-x" });
    expect(workers.providers.glm.models.default).toBe("glm-1");
  });

  it("set creates the anthropic entry with builtin: true when absent", () => {
    writeFileSync(yamlPath, "providers:\n  glm:\n    url: https://api.example.com/anthropic\n    key: \"k\"\n    models:\n      default: glm-1\n", "utf8");
    setProviderModel("anthropic", "fast", "haiku-y", configPath);
    const text = readFileSync(yamlPath, "utf8");
    expect(text).toMatch(/anthropic:\s+builtin: true/);
    expect(readWorkersSection(configPath).workers.nativeModels.fast).toBe("haiku-y");
  });

  it("an unknown provider still errors, listing anthropic too", () => {
    const { workers } = readWorkersSection(configPath);
    expect(() => resolveProviderName(workers, "nope")).toThrow(/Configured: anthropic, glm/);
    expect(() => setProviderModel("nope", "default", "m", configPath)).toThrow(/Configured: anthropic, glm/);
  });
});
