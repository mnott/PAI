import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { helpProblems, runPai, treeDiff, treeFor } from "../lib/legacy-check.js";
import { registerIssueCommands } from "../impl/issue.js";
import { issueCommand } from "./issue.js";

let home = "";
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "pai-config-test-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("PAI_HOME", join(home, "pai"));
});
afterAll(() => vi.unstubAllEnvs());

describe("pai issue", () => {
  it("declares exactly the subcommands, flags and arguments the implementation registers", () => {
    expect(treeDiff(issueCommand, treeFor(registerIssueCommands, "issue"))).toEqual([]);
  });
  it("has a summary, description and two examples on every command", () => {
    expect(helpProblems(issueCommand)).toEqual([]);
  });
  it("pai issue claim exits 2", async () => {
    const r = await runPai(["issue","claim"]);
    expect(r.code).toBe(2);
    expect(r.out + r.err).toContain("missing required argument N");
  });
  it("pai issue bogus exits 2", async () => {
    const r = await runPai(["issue","bogus"]);
    expect(r.code).toBe(2);
    expect(r.out + r.err).toContain("unknown command");
  });
});
