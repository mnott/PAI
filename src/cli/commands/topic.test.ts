import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { helpProblems, runPai } from "../lib/legacy-check.js";
import { topicCommand } from "./topic.js";

let home = "";
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "pai-config-test-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("PAI_HOME", join(home, "pai"));
});
afterAll(() => vi.unstubAllEnvs());

describe("pai topic", () => {
  it("has a summary, description and two examples on every command", () => {
    expect(helpProblems(topicCommand)).toEqual([]);
  });
  it("pai topic check exits 2", async () => {
    const r = await runPai(["topic","check"]);
    expect(r.code).toBe(2);
    expect(r.out + r.err).toContain("missing required argument CONTEXT");
  });
  it("pai topic check rejects an out-of-range threshold with exit 1", async () => {
    const r = await runPai(["topic","check","some text","--threshold","2"]);
    expect(r.code).toBe(1);
    expect(r.out + r.err).toContain("--threshold must be a number between 0 and 1");
  });
});
