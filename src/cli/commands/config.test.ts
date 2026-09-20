/**
 * `pai config migrate` — the obsidianVaultPath rewrite.
 *
 * `pai obsidian sync --vault` used to persist the then-default vault path
 * (~/.pai/obsidian-vault) into config.json explicitly. Moving the directory
 * (migrateObsidianVaultDir) left that stale value in place, so every later
 * sync regenerated the vault at the old path instead of the new one.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const savedHome = process.env.HOME;
const savedPaiHome = process.env.PAI_HOME;
const savedConfigFile = process.env.PAI_CONFIG_FILE;

const dirs: string[] = [];
function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), "pai-config-migrate-"));
  dirs.push(d);
  return d;
}

let configFile: string;
let migrateObsidianVaultPathConfig: typeof import("./config.js")["migrateObsidianVaultPathConfig"];
let oldDefaultVaultPath: typeof import("../../obsidian/sync/generate.js")["oldDefaultVaultPath"];

beforeAll(async () => {
  // CONFIG_FILE is resolved once at module load in daemon/config.ts, so the
  // env override has to be in place before config.ts (and everything it
  // imports) is ever imported.
  process.env.HOME = newDir();
  configFile = join(newDir(), "config.json");
  process.env.PAI_CONFIG_FILE = configFile;

  ({ migrateObsidianVaultPathConfig } = await import("./config.js"));
  ({ oldDefaultVaultPath } = await import("../../obsidian/sync/generate.js"));
});

afterAll(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedPaiHome === undefined) delete process.env.PAI_HOME;
  else process.env.PAI_HOME = savedPaiHome;
  if (savedConfigFile === undefined) delete process.env.PAI_CONFIG_FILE;
  else process.env.PAI_CONFIG_FILE = savedConfigFile;
});

function writeConfig(content: Record<string, unknown>): void {
  writeFileSync(configFile, JSON.stringify(content), "utf-8");
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(configFile, "utf-8")) as Record<string, unknown>;
}

describe("migrateObsidianVaultPathConfig", () => {
  it("rewrites the old default path to PAI_HOME/obsidian-vault", () => {
    const paiHome = newDir();
    process.env.PAI_HOME = paiHome;
    const oldPath = oldDefaultVaultPath();
    writeConfig({ obsidianVaultPath: oldPath });

    const r = migrateObsidianVaultPathConfig(false);

    expect(r.status).toBe("rewritten");
    expect(r.from).toBe(oldPath);
    expect(r.to).toBe(join(paiHome, "obsidian-vault"));
    expect(readConfig().obsidianVaultPath).toBe(join(paiHome, "obsidian-vault"));
  });

  it("leaves a custom vault path untouched", () => {
    const paiHome = newDir();
    process.env.PAI_HOME = paiHome;
    const customPath = join(newDir(), "my-vault");
    writeConfig({ obsidianVaultPath: customPath });

    const r = migrateObsidianVaultPathConfig(false);

    expect(r.status).toBe("custom");
    expect(readConfig().obsidianVaultPath).toBe(customPath);
  });

  it("reports not-set and writes nothing when the key is absent", () => {
    const paiHome = newDir();
    process.env.PAI_HOME = paiHome;
    writeConfig({ someOtherKey: "bar" });

    const r = migrateObsidianVaultPathConfig(false);

    expect(r.status).toBe("not-set");
    expect(readConfig()).toEqual({ someOtherKey: "bar" });
  });

  it("reports already-new when config already points at PAI_HOME/obsidian-vault", () => {
    const paiHome = newDir();
    process.env.PAI_HOME = paiHome;
    const newPath = join(paiHome, "obsidian-vault");
    writeConfig({ obsidianVaultPath: newPath });

    const r = migrateObsidianVaultPathConfig(false);

    expect(r.status).toBe("already-new");
    expect(readConfig().obsidianVaultPath).toBe(newPath);
  });

  it("dry-run reports would-rewrite and does not write", () => {
    const paiHome = newDir();
    process.env.PAI_HOME = paiHome;
    const oldPath = oldDefaultVaultPath();
    writeConfig({ obsidianVaultPath: oldPath });

    const r = migrateObsidianVaultPathConfig(true);

    expect(r.status).toBe("would-rewrite");
    expect(r.to).toBe(join(paiHome, "obsidian-vault"));
    expect(readConfig().obsidianVaultPath).toBe(oldPath);
  });
});
