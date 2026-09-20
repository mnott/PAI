/**
 * main-config.ts — dual-format (config.yaml / config.json) read/write and
 * the `pai config yaml` JSON→YAML migration.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  yamlSiblingPath,
  readDualFormatConfigRaw,
  writeDualFormatConfigRaw,
  migrateMainConfigToYaml,
  MainConfigError,
} from "./main-config.js";

const dirs: string[] = [];
function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), "pai-main-config-"));
  dirs.push(d);
  return d;
}

afterAll(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("readDualFormatConfigRaw", () => {
  it("prefers config.yaml when both files exist", () => {
    const dir = newDir();
    const jsonPath = join(dir, "config.json");
    const yamlPath = yamlSiblingPath(jsonPath);
    writeFileSync(jsonPath, JSON.stringify({ logLevel: "from-json" }), "utf-8");
    writeFileSync(yamlPath, "logLevel: from-yaml\n", "utf-8");

    const raw = readDualFormatConfigRaw(jsonPath);

    expect(raw.logLevel).toBe("from-yaml");
  });

  it("falls back to config.json when no config.yaml exists", () => {
    const dir = newDir();
    const jsonPath = join(dir, "config.json");
    writeFileSync(jsonPath, JSON.stringify({ logLevel: "json-only" }), "utf-8");

    const raw = readDualFormatConfigRaw(jsonPath);

    expect(raw.logLevel).toBe("json-only");
  });

  it("returns {} when neither file exists", () => {
    const dir = newDir();
    const jsonPath = join(dir, "config.json");

    expect(readDualFormatConfigRaw(jsonPath)).toEqual({});
  });
});

describe("writeDualFormatConfigRaw", () => {
  it("writes YAML comment-preserving when config.yaml exists", () => {
    const dir = newDir();
    const jsonPath = join(dir, "config.json");
    const yamlPath = yamlSiblingPath(jsonPath);
    writeFileSync(yamlPath, "# keep me\nlogLevel: info\n", "utf-8");

    writeDualFormatConfigRaw(jsonPath, { logLevel: "debug" });

    const text = readFileSync(yamlPath, "utf-8");
    expect(text).toContain("# keep me");
    expect(text).toContain("logLevel: debug");
    expect(existsSync(jsonPath)).toBe(false);
  });

  it("writes JSON when no config.yaml exists", () => {
    const dir = newDir();
    const jsonPath = join(dir, "config.json");

    writeDualFormatConfigRaw(jsonPath, { logLevel: "debug" });

    expect(JSON.parse(readFileSync(jsonPath, "utf-8"))).toEqual({ logLevel: "debug" });
  });
});

describe("migrateMainConfigToYaml", () => {
  it("dry-run reports the plan and writes nothing", () => {
    const dir = newDir();
    const jsonPath = join(dir, "config.json");
    const yamlPath = yamlSiblingPath(jsonPath);
    writeFileSync(jsonPath, JSON.stringify({ logLevel: "info", search: { mode: "keyword" } }), "utf-8");

    const r = migrateMainConfigToYaml(jsonPath, { dryRun: true });

    expect(r.dryRun).toBe(true);
    expect(r.backupPath).toBeNull();
    expect(r.yamlText).toContain("logLevel: info");
    expect(existsSync(yamlPath)).toBe(false);
    expect(existsSync(jsonPath)).toBe(true);
  });

  it("converts config.json to config.yaml, adds section comments, renames the JSON aside", () => {
    const dir = newDir();
    const jsonPath = join(dir, "config.json");
    const yamlPath = yamlSiblingPath(jsonPath);
    writeFileSync(jsonPath, JSON.stringify({ logLevel: "info", search: { mode: "keyword" } }), "utf-8");

    const r = migrateMainConfigToYaml(jsonPath, {});

    expect(r.dryRun).toBe(false);
    expect(existsSync(yamlPath)).toBe(true);
    expect(existsSync(jsonPath)).toBe(false);
    expect(r.backupPath).toMatch(/config\.json\.migrated-\d{4}-\d{2}-\d{2}$/);
    expect(existsSync(r.backupPath!)).toBe(true);

    const yamlText = readFileSync(yamlPath, "utf-8");
    expect(yamlText).toContain("# Daemon log level: debug, info, warn, or error.");
    expect(yamlText).toContain("logLevel: info");
    expect(yamlText).toContain("# Search defaults");
  });

  it("folds a leading-underscore JSON comment key into a real # comment", () => {
    const dir = newDir();
    const jsonPath = join(dir, "config.json");
    writeFileSync(
      jsonPath,
      JSON.stringify({ _comment: "hand-written note", logLevel: "info" }),
      "utf-8"
    );

    const r = migrateMainConfigToYaml(jsonPath, {});

    expect(r.yamlText).toContain("# hand-written note");
    expect(r.yamlText).not.toContain("_comment");
    const reparsed = readDualFormatConfigRaw(jsonPath);
    expect(reparsed).not.toHaveProperty("_comment");
  });

  it("refuses to overwrite an existing config.yaml without --force (idempotent)", () => {
    const dir = newDir();
    const jsonPath = join(dir, "config.json");
    const yamlPath = yamlSiblingPath(jsonPath);
    writeFileSync(jsonPath, JSON.stringify({ logLevel: "info" }), "utf-8");
    migrateMainConfigToYaml(jsonPath, {});

    writeFileSync(jsonPath, JSON.stringify({ logLevel: "changed" }), "utf-8");
    expect(() => migrateMainConfigToYaml(jsonPath, {})).toThrow(MainConfigError);
    expect(readFileSync(yamlPath, "utf-8")).toContain("logLevel: info");
  });

  it("--force regenerates config.yaml from the current JSON", () => {
    const dir = newDir();
    const jsonPath = join(dir, "config.json");
    const yamlPath = yamlSiblingPath(jsonPath);
    writeFileSync(jsonPath, JSON.stringify({ logLevel: "info" }), "utf-8");
    migrateMainConfigToYaml(jsonPath, {});

    writeFileSync(jsonPath, JSON.stringify({ logLevel: "changed" }), "utf-8");
    const r = migrateMainConfigToYaml(jsonPath, { force: true });

    expect(r.dryRun).toBe(false);
    expect(readFileSync(yamlPath, "utf-8")).toContain("logLevel: changed");
  });

  it("refuses when config.json does not exist", () => {
    const dir = newDir();
    const jsonPath = join(dir, "config.json");

    expect(() => migrateMainConfigToYaml(jsonPath, {})).toThrow(MainConfigError);
  });
});
