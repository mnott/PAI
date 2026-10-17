import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { helpProblems, runPai, treeDiff, treeFor } from "../lib/legacy-check.js";
import { registerRegistryCommands } from "../impl/registry/index.js";
import { registryCommand } from "./projects-registry.js";

let home = "";
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "pai-config-test-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("PAI_HOME", join(home, "pai"));
});
afterAll(() => vi.unstubAllEnvs());

describe("pai registry", () => {
  it("declares exactly the subcommands, flags and arguments the implementation registers", () => {
    expect(treeDiff(registryCommand, treeFor(registerRegistryCommands, "registry"))).toEqual([]);
  });
  it("has a summary, description and two examples on every command", () => {
    expect(helpProblems(registryCommand)).toEqual([]);
  });
  it("pai registry stats exits 0", async () => {
    const r = await runPai(["registry","stats"]);
    expect(r.code).toBe(0);
  });
  it("pai registry lookup --bogus exits 2", async () => {
    const r = await runPai(["registry","lookup","--bogus"]);
    expect(r.code).toBe(2);
    expect(r.out + r.err).toContain("unknown option --bogus");
  });
});
