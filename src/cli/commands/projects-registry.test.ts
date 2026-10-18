import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { helpProblems, runPai } from "../lib/legacy-check.js";
import { registryCommand } from "./projects-registry.js";

let home = "";
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "pai-config-test-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("PAI_HOME", join(home, "pai"));
});
afterAll(() => vi.unstubAllEnvs());

describe("pai registry", () => {
  it("has a summary, description and two examples on every command", () => {
    expect(helpProblems(registryCommand)).toEqual([]);
  });
  it("pai registry stats exits 0", async () => {
    const r = await runPai(["registry","stats"]);
    expect(r.code).toBe(0);
  });
  it("pai registry lookup --bogus exits 2", async () => {
    const r = await runPai(["registry","lookup","--bogus"]);
    expect(r.code).toBe(2);
    expect(r.out + r.err).toContain("unknown option --bogus");
  });
  it("pai registry lookup --path exits 1 when path not found", async () => {
    const r = await runPai(["registry","lookup","--path","/nonexistent/path"]);
    expect(r.code).toBe(1);
  });
  it("pai registry scan --show-dirs exits 0", async () => {
    const r = await runPai(["registry","scan","--show-dirs"]);
    expect(r.code).toBe(0);
  });
  it("pai registry scan --quick exits 0", async () => {
    const r = await runPai(["registry","scan","--quick"]);
    expect(r.code).toBe(0);
  });
  it("pai registry rebuild exits 0", async () => {
    const r = await runPai(["registry","rebuild"]);
    expect(r.code).toBe(0);
  });
  it("pai registry migrate exits 0", async () => {
    const r = await runPai(["registry","migrate"]);
    expect(r.code).toBe(0);
  });
  it("pai registry dedupe exits 0", async () => {
    const r = await runPai(["registry","dedupe"]);
    expect(r.code).toBe(0);
  });
  it("pai registry dedupe --execute exits 0", async () => {
    const r = await runPai(["registry","dedupe","--execute"]);
    expect(r.code).toBe(0);
  });
  it("pai registry reconnect exits 0", async () => {
    const r = await runPai(["registry","reconnect"]);
    expect(r.code).toBe(0);
  });
  it("pai registry reconnect --execute exits 0", async () => {
    const r = await runPai(["registry","reconnect","--execute"]);
    expect(r.code).toBe(0);
  });
});