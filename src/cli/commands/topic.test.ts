import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { helpProblems, runPai, treeDiff, treeFor } from "../lib/legacy-check.js";
import { registerTopicCommands } from "../impl/topic.js";
import { topicCommand } from "./topic.js";

let home = "";
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "pai-config-test-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("PAI_HOME", join(home, "pai"));
});
afterAll(() => vi.unstubAllEnvs());

describe("pai topic", () => {
  it("declares exactly the subcommands, flags and arguments the implementation registers", () => {
    expect(treeDiff(topicCommand, treeFor(registerTopicCommands, "topic"))).toEqual([]);
  });
  it("has a summary, description and two examples on every command", () => {
    expect(helpProblems(topicCommand)).toEqual([]);
  });
  it("pai topic check exits 2", async () => {
    const r = await runPai(["topic","check"]);
    expect(r.code).toBe(2);
    expect(r.out + r.err).toContain("missing required argument CONTEXT");
  });
});
