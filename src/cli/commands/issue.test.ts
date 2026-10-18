import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { helpProblems, runPai } from "../lib/test-helpers.js";
import { issueCommand } from "./issue.js";

let home = "";
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "pai-config-test-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("PAI_HOME", join(home, "pai"));
});
afterAll(() => vi.unstubAllEnvs());

describe("pai issue", () => {
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
  it("pai issue claim rejects a non-number with exit 1", async () => {
    const r = await runPai(["issue","claim","abc"]);
    expect(r.code).toBe(1);
    expect(r.out + r.err).toContain("not an issue number: abc");
  });
  it("pai issue release rejects a non-number with exit 1", async () => {
    const r = await runPai(["issue","release","0"]);
    expect(r.code).toBe(1);
    expect(r.out + r.err).toContain("not an issue number: 0");
  });
  it("pai issue stale rejects a bad --days with exit 1", async () => {
    const r = await runPai(["issue","stale","--days","x"]);
    expect(r.code).toBe(1);
    expect(r.out + r.err).toContain("bad --days: x");
  });
  it("pai issue claims --help exits 0", async () => {
    const r = await runPai(["issue","claims","--help"]);
    expect(r.code).toBe(0);
    expect(r.out + r.err).toContain("in-progress");
  });
});
