/**
 * Tests for the worker MCP allowlist — reading the server list, expanding
 * names/sets, writing the filtered per-worker config. Pure / tmp-dir
 * functions; the "claude.json" here is fixture data in a temp dir, never the
 * real file.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandMcpNames, readMcpServers, writeMcpConfig, describeMcp, runMcpConfigPath } from "./mcp.js";
import type { WorkersConfig } from "./config.js";

const dir = mkdtempSync(join(tmpdir(), "pai-mcp-test-"));
const claudeJson = join(dir, "claude.json");
writeFileSync(
  claudeJson,
  JSON.stringify({
    mcpServers: {
      memory: { type: "stdio", command: "bun", args: ["run", "memory"] },
      github: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
      fetcher: { type: "stdio", command: "node", args: ["fetch.js"] },
    },
  }),
  "utf8"
);

const workers = { mcpSets: { office: ["memory", "github"], tiny: ["fetcher"] } } as unknown as WorkersConfig;

describe("readMcpServers", () => {
  it("lists the servers of a claude.json", () => {
    expect(Object.keys(readMcpServers(claudeJson)).sort()).toEqual(["fetcher", "github", "memory"]);
  });

  it("tolerates a missing or damaged file (empty map)", () => {
    expect(readMcpServers(join(dir, "not-there"))).toEqual({});
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{not json", "utf8");
    expect(readMcpServers(broken)).toEqual({});
  });
});

describe("expandMcpNames", () => {
  it("expands comma-separated names and sets", () => {
    expect(expandMcpNames(["office", "fetcher"], workers, claudeJson)).toEqual([
      "memory",
      "github",
      "fetcher",
    ]);
  });

  it("splits commas inside one flag value and dedupes", () => {
    expect(expandMcpNames(["memory,github", "github"], workers, claudeJson)).toEqual(["memory", "github"]);
  });

  it("fails fast on an unknown name, listing what exists", () => {
    expect(() => expandMcpNames(["nosuch"], workers, claudeJson)).toThrow(
      /unknown MCP server "nosuch".*Available servers:.*memory.*sets: office/s
    );
  });
});

describe("writeMcpConfig", () => {
  it("writes a filtered mcpServers config for the worker", () => {
    const path = writeMcpConfig(dir, "20260917-120000-123", ["memory"], claudeJson);
    expect(path).toBe(runMcpConfigPath(dir, "20260917-120000-123"));
    const written = JSON.parse(readFileSync(path, "utf8")) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(written.mcpServers)).toEqual(["memory"]);
    expect(written.mcpServers.memory).toEqual({
      type: "stdio",
      command: "bun",
      args: ["run", "memory"],
    });
  });

  it("refuses unknown names", () => {
    expect(() => writeMcpConfig(dir, "w1", ["nosuch"], claudeJson)).toThrow(/unknown MCP server/);
  });
});

describe("describeMcp", () => {
  it("lists servers and sets", () => {
    const out = describeMcp(workers, claudeJson).join("\n");
    expect(out).toContain("memory");
    expect(out).toContain("github");
    expect(out).toContain("office = memory, github");
    expect(out).toContain("--mcp");
  });

  it("notes when no MCP servers are configured", () => {
    const empty = join(dir, "empty.json");
    writeFileSync(empty, JSON.stringify({}), "utf8");
    expect(describeMcp(workers, empty).join("\n")).toMatch(/no MCP servers defined/i);
  });
});
