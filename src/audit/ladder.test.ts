import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLadderRungs, newestMcpConfig, LADDER_TOOLS, PROBE_PROMPT } from "./ladder.js";

const dirs: string[] = [];
function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), "pai-ladder-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("buildLadderRungs", () => {
  const rungs = buildLadderRungs("haiku", "/tmp/empty.mcp.json", "/tmp/real.mcp.json");

  it("builds exactly four rungs in order L0..L3", () => {
    expect(rungs.map((r) => r.id)).toEqual(["L0", "L1", "L2", "L3"]);
  });

  it("every rung probes with the fixed prompt, model and json output format", () => {
    for (const rung of rungs) {
      expect(rung.args).toEqual(expect.arrayContaining(["-p", PROBE_PROMPT, "--model", "haiku", "--output-format", "json"]));
    }
  });

  it("L0 uses the empty MCP config and an empty --tools list", () => {
    const l0 = rungs[0];
    expect(l0.args).toEqual(expect.arrayContaining(["--strict-mcp-config", "--mcp-config", "/tmp/empty.mcp.json"]));
    const toolsIdx = l0.args.indexOf("--tools");
    expect(l0.args[toolsIdx + 1]).toBe("");
  });

  it("L1 uses the empty MCP config with the core tool grant", () => {
    const l1 = rungs[1];
    expect(l1.args).toEqual(expect.arrayContaining(["--mcp-config", "/tmp/empty.mcp.json", "--tools", LADDER_TOOLS]));
  });

  it("L2 swaps in the real MCP config but keeps the same tool grant", () => {
    const l2 = rungs[2];
    expect(l2.args).toEqual(expect.arrayContaining(["--mcp-config", "/tmp/real.mcp.json", "--tools", LADDER_TOOLS]));
  });

  it("L3 drops --strict-mcp-config, --mcp-config, and --tools entirely", () => {
    const l3 = rungs[3];
    expect(l3.args).not.toContain("--strict-mcp-config");
    expect(l3.args).not.toContain("--mcp-config");
    expect(l3.args).not.toContain("--tools");
  });
});

describe("newestMcpConfig", () => {
  it("returns null when the log dir has no *.mcp.json files", () => {
    expect(newestMcpConfig(newDir())).toBeNull();
  });

  it("picks the most recently modified *.mcp.json file", () => {
    const dir = newDir();
    const older = join(dir, "old.mcp.json");
    const newer = join(dir, "new.mcp.json");
    writeFileSync(older, "{}", "utf8");
    writeFileSync(newer, "{}", "utf8");
    const now = Date.now() / 1000;
    utimesSync(older, now - 100, now - 100);
    utimesSync(newer, now, now);

    expect(newestMcpConfig(dir)).toBe(newer);
  });

  it("ignores non-.mcp.json files", () => {
    const dir = newDir();
    writeFileSync(join(dir, "status.json"), "{}", "utf8");
    expect(newestMcpConfig(dir)).toBeNull();
  });
});
