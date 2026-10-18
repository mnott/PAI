import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { helpProblems, runPai } from "../lib/test-helpers.js";
import { identityCommand } from "./identity.js";

let home = "";
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "pai-config-test-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("PAI_HOME", join(home, "pai"));
});
afterAll(() => vi.unstubAllEnvs());

describe("pai identity", () => {
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
  it("pai identity set-delivery rejects a non-address with exit 1", async () => {
    const r = await runPai(["identity","set-delivery","nope"]);
    expect(r.code).toBe(1);
    expect(r.out + r.err).toContain("Not a usable email address: nope");
  });
  it("pai identity add rejects a non-address with exit 1", async () => {
    const r = await runPai(["identity","add","nope"]);
    expect(r.code).toBe(1);
    expect(r.out + r.err).toContain("Not a usable email address: nope");
  });
  it("pai identity remove of an unlisted address exits 0 and changes nothing", async () => {
    const r = await runPai(["identity","remove","ghost@example.com"]);
    expect(r.code).toBe(0);
    expect(r.out + r.err).toContain("was not listed. Nothing changed.");
  });
});
