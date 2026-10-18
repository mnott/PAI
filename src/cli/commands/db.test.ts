import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { helpProblems, runPai } from "../lib/test-helpers.js";
import { dbCommand } from "./db.js";

let home = "";
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "pai-config-test-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("PAI_HOME", join(home, "pai"));
});
afterAll(() => vi.unstubAllEnvs());

describe("pai db", () => {
  it("has a summary, description and two examples on every command", () => {
    expect(helpProblems(dbCommand)).toEqual([]);
  });
  it("pai db query select 1 as one --json exits 0", async () => {
    const r = await runPai(["db","query","select 1 as one","--json"]);
    expect(r.code).toBe(0);
    expect(r.out + r.err).toContain("one");
  });
  it("pai db schema exits 2", async () => {
    const r = await runPai(["db","schema"]);
    expect(r.code).toBe(2);
    expect(r.out + r.err).toContain("missing required argument TABLE");
  });
});
