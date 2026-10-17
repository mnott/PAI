import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { helpProblems, runPai, treeDiff, treeFor } from "../lib/legacy-check.js";
import { registerDaemonCommands } from "../impl/daemon.js";
import { daemonCommand } from "./daemon.js";

let home = "";
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "pai-config-test-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("PAI_HOME", join(home, "pai"));
});
afterAll(() => vi.unstubAllEnvs());

describe("pai daemon", () => {
  it("declares exactly the subcommands, flags and arguments the implementation registers", () => {
    expect(treeDiff(daemonCommand, treeFor(registerDaemonCommands, "daemon"))).toEqual([]);
  });
  it("has a summary, description and two examples on every command", () => {
    expect(helpProblems(daemonCommand)).toEqual([]);
  });
  it("pai daemon restart extra exits 2", async () => {
    const r = await runPai(["daemon","restart","extra"]);
    expect(r.code).toBe(2);
    expect(r.out + r.err).toContain("unexpected argument");
  });
  it("pai daemon restart --help exits 0", async () => {
    const r = await runPai(["daemon","restart","--help"]);
    expect(r.code).toBe(0);
    expect(r.out + r.err).toContain("Restart the daemon");
  });
  it("pai daemon logs --lines exits 2", async () => {
    const r = await runPai(["daemon","logs","--lines"]);
    expect(r.code).toBe(2);
    expect(r.out + r.err).toContain("needs a value");
  });
});
