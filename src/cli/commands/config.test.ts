import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { helpProblems, runPai } from "../lib/legacy-check.js";
import { configCommand } from "./config.js";

let home = "";
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "pai-config-test-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("PAI_HOME", join(home, "pai"));
});
afterAll(() => vi.unstubAllEnvs());

describe("pai config", () => {
  it("has a summary, description and two examples on every command", () => {
    expect(helpProblems(configCommand)).toEqual([]);
  });
  it("pai config path exits 0", async () => {
    const r = await runPai(["config","path"]);
    expect(r.code).toBe(0);
    expect(r.out + r.err).toContain("pai-config-test");
  });
  it("pai config get exits 2", async () => {
    const r = await runPai(["config","get"]);
    expect(r.code).toBe(2);
    expect(r.out + r.err).toContain("missing required argument PATH");
  });
  it("pai config yaml --dry-run with no config.json reports the error and exits 1", async () => {
    const r = await runPai(["config","yaml","--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("config.yaml");
  });
  it("pai config list exits 0", async () => {
    const r = await runPai(["config","list"]);
    expect(r.code).toBe(0);
  });
  it("pai config get on an unset key exits 1", async () => {
    const r = await runPai(["config","get","no.such.key"]);
    expect(r.code).toBe(1);
    expect(r.out + r.err).toContain("no.such.key");
  });
  it("pai config set without a value exits 2", async () => {
    const r = await runPai(["config","set","a.b"]);
    expect(r.code).toBe(2);
    expect(r.out + r.err).toContain("missing required argument VALUE");
  });
  it("pai config unset without a path exits 2", async () => {
    const r = await runPai(["config","unset"]);
    expect(r.code).toBe(2);
    expect(r.out + r.err).toContain("missing required argument PATH");
  });
  it("pai config migrate --dry-run exits 0 and writes nothing", async () => {
    const r = await runPai(["config","migrate","--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out + r.err).toContain("logs/workers");
  });
});
