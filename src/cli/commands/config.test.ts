import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { helpProblems, runPai, treeDiff, treeFor } from "../lib/legacy-check.js";
import { registerConfigCommands } from "../impl/config.js";
import { configCommand } from "./config.js";

let home = "";
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "pai-config-test-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("PAI_HOME", join(home, "pai"));
});
afterAll(() => vi.unstubAllEnvs());

describe("pai config", () => {
  it("declares exactly the subcommands, flags and arguments the implementation registers", () => {
    expect(treeDiff(configCommand, treeFor(registerConfigCommands, "config"))).toEqual([]);
  });
  it("has a summary, description and two examples on every command", () => {
    expect(helpProblems(configCommand)).toEqual([]);
  });
  it("pai config path exits 0", async () => {
    const r = await runPai(["config","path"]);
    expect(r.code).toBe(0);
    expect(r.out + r.err).toContain("pai-config-test");
  });
  it("pai config get exits 2", async () => {
    const r = await runPai(["config","get"]);
    expect(r.code).toBe(2);
    expect(r.out + r.err).toContain("missing required argument PATH");
  });
});
