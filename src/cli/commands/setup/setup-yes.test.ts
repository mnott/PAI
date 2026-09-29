/**
 * `pai setup --yes`: every prompt answers its default from the one shared
 * point (prompt()) without reading stdin; --storage sqlite writes a sqlite
 * config. HOME points at a temp dir and modules are re-imported so no path
 * resolves under the real home.
 */

import { mkdtempSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A readline stand-in that fails the test if anything is ever read.
const rl = {
  question: () => {
    throw new Error("stdin was read under --yes");
  },
} as never;

let home: string;

async function load() {
  vi.resetModules();
  vi.stubEnv("HOME", home);
  const utils = await import("./utils.js");
  const storage = await import("./steps/02-storage.js");
  return { ...utils, ...storage };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pai-setup-yes-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("prompt helpers under --yes", () => {
  it("answer their defaults without touching stdin", async () => {
    const u = await load();
    u.setupOptions.yes = true;
    expect(await u.promptYesNo(rl, "q?", true)).toBe(true);
    expect(await u.promptYesNo(rl, "q?", false)).toBe(false);
    expect(await u.promptMenu(rl, [{ label: "a" }, { label: "b" }], 1)).toBe(1);
    expect(await u.prompt(rl, "name: ", "PAI")).toBe("PAI");
  });

  it("a prompt with no default fails instead of returning an empty value", async () => {
    const u = await load();
    u.setupOptions.yes = true;
    await expect(u.prompt(rl, "Paste your token: ")).rejects.toThrow(/no default.*--yes/);
  });
});

describe("--storage", () => {
  it("sqlite writes a sqlite config under the temp HOME", async () => {
    const u = await load();
    u.setupOptions.yes = true;
    u.setupOptions.storage = "sqlite";
    const cfg = await u.stepStorage(rl);
    expect(cfg).toEqual({ storageBackend: "sqlite" });
    u.mergeConfig(cfg);
    const files = readdirSync(join(home, ".claude", "pai")).filter((f) => f.startsWith("config."));
    expect(files.length).toBeGreaterThan(0);
    expect(readFileSync(join(home, ".claude", "pai", files[0]), "utf8")).toMatch(/"?storageBackend"?:\s*"?sqlite/);
  });
});
