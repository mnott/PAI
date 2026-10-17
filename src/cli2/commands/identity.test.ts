import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { helpProblems, runPai, treeDiff, treeFor } from "../lib/legacy-check.js";
import { registerIdentityCommands } from "../impl/identity.js";
import { identityCommand } from "./identity.js";

let home = "";
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "pai-config-test-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("PAI_HOME", join(home, "pai"));
});
afterAll(() => vi.unstubAllEnvs());

describe("pai identity", () => {
  it("declares exactly the subcommands, flags and arguments the implementation registers", () => {
    expect(treeDiff(identityCommand, treeFor(registerIdentityCommands, "identity"))).toEqual([]);
  });
  it("has a summary, description and two examples on every command", () => {
    expect(helpProblems(identityCommand)).toEqual([]);
  });
  it("pai identity add me@example.com exits 0", async () => {
    const r = await runPai(["identity","add","me@example.com"]);
    expect(r.code).toBe(0);
  });
  it("pai identity show exits 0", async () => {
    const r = await runPai(["identity","show"]);
    expect(r.code).toBe(0);
    expect(r.out + r.err).toContain("me@example.com");
  });
  it("pai identity remove me@example.com exits 0", async () => {
    const r = await runPai(["identity","remove","me@example.com"]);
    expect(r.code).toBe(0);
  });
});
