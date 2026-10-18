import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { helpProblems, runPai } from "../lib/legacy-check.js";
import { taskCommand, taskAliasCommand } from "./task.js";

let home = "";
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "pai-config-test-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("PAI_HOME", join(home, "pai"));
});
afterAll(() => vi.unstubAllEnvs());

describe("pai task", () => {
  it("has a summary, description and two examples on every command", () => {
    expect(helpProblems(taskCommand)).toEqual([]);
  });
  it("pai task add exits 2", async () => {
    const r = await runPai(["task","add"]);
    expect(r.code).toBe(2);
    expect(r.out + r.err).toContain("missing required argument TITLE");
  });
  it("pai tasks done exits 2", async () => {
    const r = await runPai(["tasks","done"]);
    expect(r.code).toBe(2);
    expect(r.out + r.err).toContain("missing required argument ID");
  });
  it("pai task dispatch --no-such-flag exits 2", async () => {
    const r = await runPai(["task","dispatch","--no-such-flag"]);
    expect(r.code).toBe(2);
    expect(r.out + r.err).toContain("unknown option");
  });
});
