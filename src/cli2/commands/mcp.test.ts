import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { helpProblems, runPai, treeDiff, treeFor } from "../lib/legacy-check.js";
import { registerMcpCommands } from "../impl/mcp.js";
import { mcpCommand } from "./mcp.js";

let home = "";
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "pai-config-test-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("PAI_HOME", join(home, "pai"));
});
afterAll(() => vi.unstubAllEnvs());

describe("pai mcp", () => {
  it("declares exactly the subcommands, flags and arguments the implementation registers", () => {
    expect(treeDiff(mcpCommand, treeFor(registerMcpCommands, "mcp"))).toEqual([]);
  });
  it("has a summary, description and two examples on every command", () => {
    expect(helpProblems(mcpCommand)).toEqual([]);
  });
  it("pai mcp status exits 0", async () => {
    const r = await runPai(["mcp","status"]);
    expect(r.code).toBe(0);
  });
  it("pai mcp install extra exits 2", async () => {
    const r = await runPai(["mcp","install","extra"]);
    expect(r.code).toBe(2);
    expect(r.out + r.err).toContain("unexpected argument");
  });
});
