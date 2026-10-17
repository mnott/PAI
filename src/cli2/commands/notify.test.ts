import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { helpProblems, runPai, treeDiff, treeFor } from "../lib/legacy-check.js";
import { registerNotifyCommands } from "../impl/notify.js";
import { notifyCommand } from "./notify.js";

let home = "";
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "pai-config-test-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("PAI_HOME", join(home, "pai"));
});
afterAll(() => vi.unstubAllEnvs());

describe("pai notify", () => {
  it("declares exactly the subcommands, flags and arguments the implementation registers", () => {
    expect(treeDiff(notifyCommand, treeFor(registerNotifyCommands, "notify"))).toEqual([]);
  });
  it("has a summary, description and two examples on every command", () => {
    expect(helpProblems(notifyCommand)).toEqual([]);
  });
  it("pai notify set --mode with no value exits 2", async () => {
    const r = await runPai(["notify", "set", "--mode"]);
    expect(r.code).toBe(2);
    expect(r.out + r.err).toContain("needs a value");
  });
  it("pai notify send info exits 2", async () => {
    const r = await runPai(["notify","send","info"]);
    expect(r.code).toBe(2);
    expect(r.out + r.err).toContain("missing required argument MESSAGE");
  });
});
