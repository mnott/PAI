/**
 * Regression tests for the ~/.claude.json data-loss bug.
 *
 * The original implementation returned {} when the file could not be parsed,
 * and the caller then wrote that object back — replacing every MCP server
 * registration the user had with PAI's single entry. Silently, exit code 0.
 *
 * The decisive test is "read then write cannot wipe a corrupt file". It fails
 * against the old implementation and passes against the current one.
 *
 * Every test runs against an isolated HOME; the real ~/.claude.json is never
 * touched.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pai-claude-json-"));
process.env.HOME = home;

const { readClaudeJson, writeClaudeJson, claudeJsonPath } = await import("./claude-json.js");

const POPULATED = JSON.stringify(
  {
    mcpServers: { todoist: {}, coogle: {}, clickr: {} },
    projects: { alpha: 1, beta: 2 },
  },
  null,
  2
);

function seed(contents: string): void {
  writeFileSync(claudeJsonPath(), contents, "utf8");
}

describe("readClaudeJson", () => {
  beforeEach(() => {
    if (existsSync(claudeJsonPath())) unlinkSync(claudeJsonPath());
  });

  it("returns {} when the file does not exist — a legitimate first run", () => {
    expect(readClaudeJson()).toEqual({});
  });

  it("throws on malformed JSON rather than returning {}", () => {
    seed("{ this is not json");
    expect(() => readClaudeJson()).toThrow(/not valid JSON/i);
  });

  it("leaves a malformed file untouched", () => {
    seed("{ this is not json");
    try { readClaudeJson(); } catch { /* expected */ }
    expect(readFileSync(claudeJsonPath(), "utf8")).toBe("{ this is not json");
  });
});

describe("writeClaudeJson", () => {
  beforeEach(() => {
    if (existsSync(claudeJsonPath())) unlinkSync(claudeJsonPath());
    const bak = `${claudeJsonPath()}.bak-pai`;
    if (existsSync(bak)) unlinkSync(bak);
  });

  it("preserves unrelated servers and top-level keys", () => {
    seed(POPULATED);
    const config = readClaudeJson();
    (config.mcpServers as Record<string, unknown>)["pai"] = { command: "node" };
    writeClaudeJson(config);

    const after = JSON.parse(readFileSync(claudeJsonPath(), "utf8"));
    expect(Object.keys(after.mcpServers)).toHaveLength(4);
    expect(Object.keys(after.projects)).toHaveLength(2);
  });

  it("writes a backup holding the pre-write content", () => {
    seed(POPULATED);
    const config = readClaudeJson();
    (config.mcpServers as Record<string, unknown>)["pai"] = { command: "node" };
    writeClaudeJson(config);

    const bak = `${claudeJsonPath()}.bak-pai`;
    expect(existsSync(bak)).toBe(true);
    expect(JSON.parse(readFileSync(bak, "utf8")).mcpServers.pai).toBeUndefined();
  });
});

describe("the original data-loss path", () => {
  it("read-then-write cannot wipe a corrupt config", () => {
    seed("{ corrupt");

    // Exactly what cmdInstall did: read, add the pai entry, write back.
    expect(() => {
      const config = readClaudeJson();
      config.mcpServers = { pai: { command: "node" } };
      writeClaudeJson(config);
    }).toThrow();

    // The corrupt file is still there to be repaired, not replaced.
    expect(readFileSync(claudeJsonPath(), "utf8")).toBe("{ corrupt");
  });
});

describe("claudeJsonPath", () => {
  it("resolves HOME at call time, not import time", () => {
    const other = mkdtempSync(join(tmpdir(), "pai-claude-json-late-"));
    const prev = process.env.HOME;
    process.env.HOME = other;
    try {
      expect(claudeJsonPath().startsWith(other)).toBe(true);
      writeFileSync(join(other, ".claude.json"), JSON.stringify({ mcpServers: { x: {} } }), "utf8");
      expect(readClaudeJson()).toEqual({ mcpServers: { x: {} } });
    } finally {
      process.env.HOME = prev;
    }
  });
});
