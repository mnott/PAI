import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { helpProblems, runPai } from "../lib/test-helpers.js";
import { projectCommand, projectAliasCommand } from "./project.js";

let home = "";
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "pai-config-test-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("PAI_HOME", join(home, "pai"));
});
afterAll(() => vi.unstubAllEnvs());

describe("pai project", () => {
  it("has a summary, description and two examples on every command", () => {
    expect(helpProblems(projectCommand)).toEqual([]);
  });
  it("pai project names --json exits 0", async () => {
    const r = await runPai(["project","names","--json"]);
    expect(r.code).toBe(0);
  });
  it("pai projects info no-such-project exits 1", async () => {
    const r = await runPai(["projects","info","no-such-project"]);
    expect(r.code).toBe(1);
  });
  it("pai project tag only-one-arg exits 2", async () => {
    const r = await runPai(["project","tag","only-one-arg"]);
    expect(r.code).toBe(2);
    expect(r.out + r.err).toContain("missing required argument");
  });
});
