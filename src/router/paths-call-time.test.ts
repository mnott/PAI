import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { usageLogFile } from "./usage.js";
import { routerPidFile, routerLogFile } from "./supervisor.js";
import { gateFile } from "./limits.js";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("router file paths resolve at call time", () => {
  it("a PAI_HOME stub set after import redirects usage log, pid and gate files", () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-router-paths-"));
    dirs.push(dir);
    vi.stubEnv("PAI_HOME", dir);
    expect(usageLogFile()).toBe(join(dir, "logs", "router-usage.jsonl"));
    expect(routerPidFile()).toBe(join(dir, "router.pid"));
    expect(routerLogFile()).toBe(join(dir, "logs", "router.log"));
    expect(gateFile()).toBe(join(dir, "logs", "router-poll-gate.json"));
  });

  it("a HOME stub set after import redirects them when PAI_HOME is unset", () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-router-home-"));
    dirs.push(dir);
    vi.stubEnv("PAI_HOME", "");
    vi.stubEnv("HOME", dir);
    expect(usageLogFile()).toBe(join(dir, ".pai", "logs", "router-usage.jsonl"));
    expect(routerPidFile()).toBe(join(dir, ".pai", "router.pid"));
  });
});
