import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMcpConfig, gcMcpConfigs } from "./mcp.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "mcpsec-"));
  const cj = join(dir, "claude.json");
  writeFileSync(cj, JSON.stringify({ mcpServers: { todoist: { command: "x", env: { TODOIST_API_KEY: "fake-secret-123", REGION: "eu" } } } }));
  return { dir, cj };
}

describe("worker MCP config secrets", () => {
  it("omits secret values, keeps the rest, 0600, spawn env carries the key", () => {
    const { dir, cj } = setup();
    const spawn: NodeJS.ProcessEnv = { PATH: "/bin" };
    const p = writeMcpConfig(dir, "w1", ["todoist"], cj, spawn);
    const text = readFileSync(p, "utf8");
    expect(text).not.toContain("fake-secret-123");
    expect(text).toContain('"REGION": "eu"');
    expect(text).toContain("${TODOIST_API_KEY}");
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(spawn.TODOIST_API_KEY).toBe("fake-secret-123");
  });
  it("never passes ANTHROPIC_API_KEY", () => {
    const { dir } = setup();
    const cj = join(dir, "c2.json");
    writeFileSync(cj, JSON.stringify({ mcpServers: { s: { command: "x", env: { ANTHROPIC_API_KEY: "sk-fake-123456" } } } }));
    const spawn: NodeJS.ProcessEnv = {};
    const p = writeMcpConfig(dir, "w2", ["s"], cj, spawn);
    expect(readFileSync(p, "utf8")).not.toContain("sk-fake");
    expect(spawn.ANTHROPIC_API_KEY).toBeUndefined();
  });
  it("gc scrubs an old file", () => {
    const { dir } = setup();
    const old = join(dir, "old.mcp.json");
    writeFileSync(old, JSON.stringify({ mcpServers: { t: { command: "x", env: { TODOIST_API_KEY: "fake-secret-123", REGION: "eu" } } } }), { mode: 0o644 });
    expect(gcMcpConfigs(dir, true)).toEqual([old]);
    expect(readFileSync(old, "utf8")).toContain("fake-secret-123");
    expect(gcMcpConfigs(dir)).toEqual([old]);
    const text = readFileSync(old, "utf8");
    expect(text).not.toContain("fake-secret-123");
    expect(text).toContain("eu");
    expect(statSync(old).mode & 0o777).toBe(0o600);
    expect(gcMcpConfigs(dir)).toEqual([]);
  });
});
