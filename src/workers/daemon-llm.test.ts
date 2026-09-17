/**
 * Tests for daemon-side LLM spawn planning: background summarizers must run
 * through the provider registry (base URL, token, concrete model id, no
 * ANTHROPIC_API_KEY) and keep working exactly as before when no provider is
 * configured. tmp config files only.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planLlmSpawn, LLM_TIMEOUT_MS } from "./daemon-llm.js";

let dir: string;
let configPath: string;
let keyPath: string;

const PROVIDER = {
  enabled: true,
  protocol: "anthropic",
  baseUrl: "https://api.example.com/api/anthropic",
  keyFile: "", // filled per-test (tmp path)
  models: { default: "example-5.3", fast: "example-5.3-flash" },
  env: {},
};

function writeConfig(workers: unknown): void {
  writeFileSync(configPath, JSON.stringify({ workers }, null, 2) + "\n", "utf8");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pai-daemon-llm-"));
  configPath = join(dir, "config.json");
  keyPath = join(dir, "api_key");
  writeFileSync(keyPath, "test-token\n", "utf8");
  chmodSync(keyPath, 0o600);
  process.env.ANTHROPIC_API_KEY = "must-never-reach-the-child";
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  rmSync(dir, { recursive: true, force: true });
});

describe("planLlmSpawn — provider configured", () => {
  it("routes the spawn through the provider: env, model id, args", async () => {
    writeConfig({
      enabled: true,
      active: "glm",
      providers: { glm: { ...PROVIDER, keyFile: keyPath } },
    });

    const plan = await planLlmSpawn("sonnet", configPath);
    expect(plan.provider).toBe("glm");
    // the configured default model, not the tier alias
    expect(plan.model).toBe("example-5.3");
    expect(plan.args).toEqual(["--model", "example-5.3", "-p", "--no-session-persistence"]);
    // the provider env the worker runner would set
    expect(plan.env.ANTHROPIC_BASE_URL).toBe("https://api.example.com/api/anthropic");
    expect(plan.env.ANTHROPIC_AUTH_TOKEN).toBe("test-token");
    expect(plan.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("example-5.3");
    // nothing can fall back to Anthropic billing
    expect(plan.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(plan.timeoutMs).toBe(LLM_TIMEOUT_MS.sonnet);
  });

  it("resolves the cheap tier to the provider's fast model", async () => {
    writeConfig({
      enabled: true,
      active: "glm",
      providers: { glm: { ...PROVIDER, keyFile: keyPath } },
    });
    const plan = await planLlmSpawn("haiku", configPath);
    expect(plan.model).toBe("example-5.3-flash");
    expect(plan.timeoutMs).toBe(LLM_TIMEOUT_MS.haiku);
  });
});

describe("planLlmSpawn — no provider configured", () => {
  it("keeps the historical behaviour: tier alias, ambient env minus the Anthropic key", async () => {
    // no config file at all
    const plan = await planLlmSpawn("sonnet", join(dir, "missing.json"));
    expect(plan.provider).toBeNull();
    expect(plan.model).toBe("sonnet");
    expect(plan.args).toEqual(["--model", "sonnet", "-p", "--no-session-persistence"]);
    expect(plan.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(plan.env.PATH).toBe(process.env.PATH);
    expect(plan.timeoutMs).toBe(LLM_TIMEOUT_MS.sonnet);
  });

  it("falls back the same way when workers are enabled but no provider resolves", async () => {
    writeConfig({ enabled: true, active: null, providers: {} });
    const plan = await planLlmSpawn("haiku", configPath);
    expect(plan.provider).toBeNull();
    expect(plan.model).toBe("haiku");
  });
});

describe("planLlmSpawn — broken provider", () => {
  it("throws rather than silently billing Anthropic", async () => {
    writeConfig({
      enabled: true,
      active: "glm",
      providers: { glm: { ...PROVIDER, keyFile: join(dir, "no-such-key") } },
    });
    await expect(planLlmSpawn("sonnet", configPath)).rejects.toThrow(/key file/);
  });
});
