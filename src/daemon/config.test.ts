/**
 * loadConfig() — dual-format (config.yaml / config.json) precedence.
 * CONFIG_FILE is resolved once at module load, so PAI_CONFIG_FILE must be
 * set before daemon/config.ts is ever imported.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const savedHome = process.env.HOME;
const savedPaiHome = process.env.PAI_HOME;
const savedConfigFile = process.env.PAI_CONFIG_FILE;

const dirs: string[] = [];
function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), "pai-daemon-config-"));
  dirs.push(d);
  return d;
}

let configFile: string;
let loadConfig: typeof import("./config.js")["loadConfig"];
let paiConfigYamlFilePath: typeof import("./config.js")["paiConfigYamlFilePath"];
let ensureConfigDir: typeof import("./config.js")["ensureConfigDir"];

beforeAll(async () => {
  process.env.HOME = newDir();
  const paiHome = newDir();
  process.env.PAI_HOME = paiHome;
  configFile = join(paiHome, "config.json");
  process.env.PAI_CONFIG_FILE = configFile;

  ({ loadConfig, paiConfigYamlFilePath, ensureConfigDir } = await import("./config.js"));
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

describe("loadConfig", () => {
  it("returns defaults when neither config.json nor config.yaml exists", () => {
    const cfg = loadConfig();
    expect(cfg.logLevel).toBe("info");
  });

  it("loads config.json when no config.yaml exists", () => {
    writeFileSync(configFile, JSON.stringify({ logLevel: "debug" }), "utf-8");
    expect(loadConfig().logLevel).toBe("debug");
    rmSync(configFile);
  });

  it("prefers config.yaml over config.json when both exist", () => {
    writeFileSync(configFile, JSON.stringify({ logLevel: "from-json" }), "utf-8");
    writeFileSync(paiConfigYamlFilePath(), "logLevel: from-yaml\n", "utf-8");

    expect(loadConfig().logLevel).toBe("from-yaml");

    rmSync(configFile);
    rmSync(paiConfigYamlFilePath());
  });
});

describe("ensureConfigDir", () => {
  it("does not write config.json when config.yaml already exists", () => {
    writeFileSync(paiConfigYamlFilePath(), "logLevel: from-yaml\n", "utf-8");
    ensureConfigDir();
    expect(existsSync(configFile)).toBe(false);
    rmSync(paiConfigYamlFilePath());
  });

  it("writes the default template when neither config.json nor config.yaml exists", () => {
    ensureConfigDir();
    expect(existsSync(configFile)).toBe(true);
    rmSync(configFile);
  });
});
