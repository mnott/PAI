import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { helpProblems, runPai } from "../lib/test-helpers.js";
import { claudeJsonPath, trustProjectPath } from "../../config/claude-json.js";
import { projectCommand, projectAliasCommand } from "./project.js";

vi.mock("../../registry/registrable.js", () => ({ unregistrableReason: () => null }));

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
  it("trustProjectPath marks a folder trusted and keeps other keys", () => {
    writeFileSync(claudeJsonPath(), JSON.stringify({ mcpServers: { a: {} }, projects: { "/x": { allowedTools: [1] } } }), "utf8");
    expect(trustProjectPath("/x")).toBe(true);
    expect(trustProjectPath("/y")).toBe(true);
    expect(trustProjectPath("/y")).toBe(false);
    const j = JSON.parse(readFileSync(claudeJsonPath(), "utf8"));
    expect(j.mcpServers).toEqual({ a: {} });
    expect(j.projects["/x"]).toEqual({ allowedTools: [1], hasTrustDialogAccepted: true });
    expect(j.projects["/y"].hasTrustDialogAccepted).toBe(true);
  });
  it("pai project add trusts the folder; --no-trust opts out", async () => {
    writeFileSync(claudeJsonPath(), "{}", "utf8");
    const a = join(home, "dev", "trusted-app");
    const b = join(home, "dev", "untrusted-app");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    const ra = await runPai(["project", "add", a]);
    const rb = await runPai(["project", "add", b, "--no-trust"]);
    expect([ra.code, rb.code]).toEqual([0, 0]);
    const projects = JSON.parse(readFileSync(claudeJsonPath(), "utf8")).projects ?? {};
    const keys = Object.keys(projects);
    expect(keys.some((k) => k.endsWith("trusted-app") && !k.endsWith("untrusted-app"))).toBe(true);
    expect(keys.some((k) => k.endsWith("untrusted-app"))).toBe(false);
    expect(existsSync(claudeJsonPath())).toBe(true);
  });
});
