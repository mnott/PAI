/**
 * Tests for role/provider resolution and the runner-args parser.
 *
 * Pure functions, no claude/osascript calls — the routing decision is exactly
 * what a misrouted worker gets wrong, so it is pinned here.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkersConfig, type WorkerProvider } from "./config.js";
import { resolveTarget, setCooldown } from "./routing.js";
import { parseRunnerArgs } from "./args.js";

const dir = mkdtempSync(join(tmpdir(), "pai-workers-routing-"));

function config(overrides: Record<string, unknown> = {}) {
  return parseWorkersConfig({
    enabled: true,
    active: "glm",
    providers: {
      glm: {
        baseUrl: "https://api.example.com/api/anthropic",
        keyFile: "~/.config/example/api_key",
        models: { default: "example-4.7", fast: "example-4.7-flash" },
        env: {},
      },
    },
    roles: { implement: "glm", research: "glm", spotcheck: "glm/fast" },
    ...overrides,
  });
}

const GLM: WorkerProvider = {
  enabled: true,
  protocol: "anthropic",
  baseUrl: "https://api.example.com/api/anthropic",
  keyFile: null,
  models: { default: "example-4.7", fast: "example-4.7-flash" },
  env: {},
};

describe("resolveTarget", () => {
  it("resolves a plain role to the provider default model", () => {
    const t = resolveTarget(config(), dir, { role: "research" });
    expect(t.providerName).toBe("glm");
    expect(t.modelAlias).toBeNull();
    expect(t.via).toBe("role");
  });

  it("resolves a fast role to the fast alias", () => {
    const t = resolveTarget(config(), dir, { role: "spotcheck" });
    expect(t.providerName).toBe("glm");
    expect(t.modelAlias).toBe("fast");
  });

  it("gives --provider the highest precedence", () => {
    const t = resolveTarget(config(), dir, { flagProvider: "glm", role: "research" });
    expect(t.via).toBe("flag");
  });

  it("names the role when it does not exist", () => {
    expect(() => resolveTarget(config(), dir, { role: "nope" })).toThrow(/no role named "nope"/);
  });

  it("skips a cooled-down provider in auto order and takes the next", () => {
    const c = config({
      active: "auto",
      providers: {
        glm: GLM,
        other: { ...GLM, baseUrl: "https://other.example.com" },
      },
      routing: { order: ["glm", "other"], cooldownMinutes: 30, retryOnQuota: true },
    });
    setCooldown(dir, "glm", 30);
    const t = resolveTarget(c, dir);
    expect(t.providerName).toBe("other");
    expect(t.via).toBe("auto");
  });
});

describe("parseRunnerArgs", () => {
  it("keeps the prompt and tools, drops --output-format/--verbose", () => {
    const p = parseRunnerArgs([
      "-p", "fix the buttons",
      "--allowedTools", "Read,Edit,Write,Bash,Grep,Glob",
      "--output-format", "json",
      "--verbose",
    ]);
    expect(p.prompt).toBe("fix the buttons");
    expect(p.headless).toBe(true);
    expect(p.outputFormat).toBe("json");
    expect(p.rest).toEqual([
      "-p", "fix the buttons",
      "--allowedTools", "Read,Edit,Write,Bash,Grep,Glob",
    ]);
  });

  it("notes when the caller pinned --model or --mcp-config", () => {
    const p = parseRunnerArgs(["--model", "big", "--mcp-config", "/tmp/m.json"]);
    expect(p.callerModel).toBe(true);
    expect(p.callerMcpConfig).toBe(true);
    expect(p.headless).toBe(false);
  });
});
