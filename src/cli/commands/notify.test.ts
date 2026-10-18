import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { helpProblems, runPai } from "../lib/test-helpers.js";
import { notifyCommand } from "./notify.js";

let home = "";
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "pai-config-test-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("PAI_HOME", join(home, "pai"));
});
afterAll(() => vi.unstubAllEnvs());

describe("pai notify", () => {
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
  it("pai notify status exits 1", async () => {
    const r = await runPai(["notify","status"]);
    // This will fail due to no daemon, so it exits 1
    expect(r.code).toBe(1);
  });
  it("pai notify test exits 1", async () => {
    const r = await runPai(["notify","test"]);
    // This will fail due to no daemon, so it exits 1
    expect(r.code).toBe(1);
  });
  it("pai notify set options enable and disable are repeatable", () => {
    const setCommand = notifyCommand.subcommands?.find(c => c.name === "set");
    expect(setCommand).toBeDefined();
    if (setCommand && setCommand.options) {
      const enableOption = setCommand.options.find(o => o.name === "enable");
      const disableOption = setCommand.options.find(o => o.name === "disable");
      expect(enableOption).toBeDefined();
      expect(disableOption).toBeDefined();
      if (enableOption) {
        expect(enableOption.repeatable).toBe(true);
      }
      if (disableOption) {
        expect(disableOption.repeatable).toBe(true);
      }
    }
  });
});
