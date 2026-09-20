/**
 * Tests for daemon-side LLM spawn planning: background summarizers must run
 * through the provider registry (base URL, token, concrete model id, no
 * ANTHROPIC_API_KEY) and keep working exactly as before when no provider is
 * configured. tmp config files only.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function writeConfig(workers: Record<string, unknown>): void {
  // logDir pinned into the tmp dir so the containment config never lands in
  // the real worker log tree from a test
  writeFileSync(
    configPath,
    JSON.stringify({ workers: { logDir: join(dir, "logs"), ...workers } }, null, 2) + "\n",
    "utf8"
  );
}

/** The containment slice of a plan's args: strict empty MCP + empty tool grant. */
function containmentOf(args: string[]): { mcpConfig: string; allowedTools: string; tools: string } {
  const mcp = args.indexOf("--mcp-config");
  const allowedTools = args.indexOf("--allowedTools");
  const tools = args.indexOf("--tools");
  return {
    mcpConfig: mcp === -1 ? "" : args[mcp + 1],
    allowedTools: allowedTools === -1 ? "<absent>" : args[allowedTools + 1],
    tools: tools === -1 ? "<absent>" : args[tools + 1],
  };
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
    expect(plan.args).toEqual([
      "--model", "example-5.3",
      "--strict-mcp-config", "--mcp-config", join(dir, "logs", "no-mcp.json"),
      "--allowedTools", "",
      "--tools", "",
      "-p", "--no-session-persistence",
    ]);
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
    const { mcpConfig, allowedTools, tools } = containmentOf(plan.args);
    // containment survives the fallback: no tools, no MCP servers, ever
    expect(plan.args).toContain("--strict-mcp-config");
    expect(mcpConfig.endsWith("no-mcp.json")).toBe(true);
    expect(allowedTools).toBe("");
    expect(tools).toBe("");
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

describe("planLlmSpawn — containment (the 2026-09-18 config-corruption fix)", () => {
  it("grants no tool at all: the allowlist is empty on every path", async () => {
    writeConfig({
      enabled: true,
      active: "glm",
      providers: { glm: { ...PROVIDER, keyFile: keyPath } },
    });
    for (const plan of [
      await planLlmSpawn("haiku", configPath),
      await planLlmSpawn("sonnet", configPath),
      await planLlmSpawn("opus", configPath),
    ]) {
      const { allowedTools, tools } = containmentOf(plan.args);
      expect(allowedTools).toBe("");
      expect(tools).toBe("");
      // no file, shell or search tool can hide in an empty grant
      for (const t of ["Read", "Write", "Edit", "Bash", "Grep", "Glob"]) {
        expect(allowedTools).not.toContain(t);
      }
    }
  });

  it("points MCP at a strict empty config the spawn cannot widen", async () => {
    writeConfig({
      enabled: true,
      active: "glm",
      providers: { glm: { ...PROVIDER, keyFile: keyPath } },
    });
    const plan = await planLlmSpawn("sonnet", configPath);
    expect(plan.args).toContain("--strict-mcp-config");
    const { mcpConfig } = containmentOf(plan.args);
    expect(mcpConfig.startsWith(dir)).toBe(true);
    expect(JSON.parse(readFileSync(mcpConfig, "utf8"))).toEqual({ mcpServers: {} });
  });

  it("carries the same containment on the no-provider fallback", async () => {
    writeConfig({ enabled: true, active: null, providers: {} });
    const plan = await planLlmSpawn("haiku", configPath);
    const { mcpConfig, allowedTools, tools } = containmentOf(plan.args);
    expect(mcpConfig.startsWith(dir)).toBe(true);
    expect(allowedTools).toBe("");
    expect(tools).toBe("");
  });
});
