import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { helpProblems, runPai } from "../lib/test-helpers.js";
import { daemonCommand } from "./daemon.js";

let home = "";
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "pai-config-test-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("PAI_HOME", join(home, "pai"));
});
afterAll(() => vi.unstubAllEnvs());

describe("pai daemon", () => {
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
  it("pai daemon serve extra exits 2", async () => {
    const r = await runPai(["daemon","serve","extra"]);
    expect(r.code).toBe(2);
    expect(r.out + r.err).toContain("unexpected argument");
  });
  it("pai daemon migrate --connection-string needs a value (exit 2)", async () => {
    const r = await runPai(["daemon","migrate","--connection-string"]);
    expect(r.code).toBe(2);
    expect(r.out + r.err).toContain("needs a value");
  });
  it("pai daemon status extra exits 2", async () => {
    const r = await runPai(["daemon","status","extra"]);
    expect(r.code).toBe(2);
    expect(r.out + r.err).toContain("unexpected argument");
  });
  it("pai daemon install --help exits 0", async () => {
    const r = await runPai(["daemon","install","--help"]);
    expect(r.code).toBe(0);
    expect(r.out + r.err).toContain("Install the daemon as a login service");
  });
  it("pai daemon uninstall extra exits 2", async () => {
    const r = await runPai(["daemon","uninstall","extra"]);
    expect(r.code).toBe(2);
    expect(r.out + r.err).toContain("unexpected argument");
  });
  it("pai daemon keepalive exits 0 in an empty home", async () => {
    const r = await runPai(["daemon","keepalive"]);
    expect(r.code).toBe(0);
    expect(r.out + r.err).toContain("Session cache keepalive");
  });
});
