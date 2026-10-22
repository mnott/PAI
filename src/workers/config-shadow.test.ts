/**
 * config-shadow: a workers key in the wrong file is reported, and the cockpit
 * registry editor refuses to save an edit of it. Temp dirs only.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workersConfigShadows, liveWorkersConfigShadows, logWorkersConfigShadowsOnce, resetWorkersConfigShadowLogForTest } from "./config-shadow.js";
import { hashText, saveRegistry, validateRegistry, validateRequest, type RegistryCtx } from "../router/cockpit-registry.js";

let dir: string;
let ctx: RegistryCtx;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "shadow-"));
  ctx = { yamlPath: join(dir, "workers.yaml"), backupDir: join(dir, "bk"), mainConfigPath: join(dir, "config.json") };
  resetWorkersConfigShadowLogForTest();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const MAIN = "workers:\n  pool:\n    spares: 1\n    maxSlots: 3\n";
const WYAML = "workers:\n  pool:\n    maxSlots: 4\n    spares: 2\npool:\n  enabled: true\n  max_slots: 4\nproviders: {}\n";

describe("workersConfigShadows", () => {
  it("names a key present in both files as ignored in workers.yaml, effective in config.yaml", () => {
    const s = workersConfigShadows({ workers: { pool: { maxSlots: 3 } } }, { workers: { pool: { maxSlots: 4 } } });
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ file: "workers.yaml", key: "workers.pool.maxSlots", effective: "config.yaml:workers.pool.maxSlots" });
    expect(s[0]!.message).toContain("which also sets it and wins");
  });
  it("reports a workers.yaml-only workers key as ignored too", () => {
    const s = workersConfigShadows({}, { workers: { pool: { spares: 1 } } });
    expect(s.map((x) => x.key)).toEqual(["workers.pool.spares"]);
    expect(s[0]!.message).not.toContain("also sets it");
  });
  it("reports unknown top-level blocks as unused, known ones not", () => {
    const s = workersConfigShadows({}, { pool: { enabled: true, max_slots: 4 }, providers: {}, tiers: [], local_tiers: {} });
    expect(s.map((x) => x.key)).toEqual(["pool"]);
    expect(s[0]!.message).toContain("unused");
  });
  it("knows the read keys local and orchestratorModel", () => {
    expect(workersConfigShadows({}, { local: "x", orchestratorModel: "opus", bogus: 1 }).map((x) => x.key)).toEqual(["bogus"]);
  });
  it("reports config.yaml routing tables that workers.yaml shadows, only when workers.yaml exists", () => {
    const main = { workers: { providers: { a: {} }, pane: { enabled: true } } };
    expect(workersConfigShadows(main, null)).toEqual([]);
    expect(workersConfigShadows(main, {}).map((x) => `${x.file}:${x.key}`)).toEqual(["config.yaml:workers.providers"]);
  });
  it("live reader and daemon log read the files", () => {
    writeFileSync(join(dir, "config.yaml"), MAIN);
    writeFileSync(ctx.yamlPath, WYAML);
    const keys = liveWorkersConfigShadows(ctx.mainConfigPath, ctx.yamlPath).map((s) => s.key);
    expect(keys).toEqual(["workers.pool.maxSlots", "workers.pool.spares", "pool"]);
  });
});

describe("registry editor", () => {
  it("warns on unchanged shadowed keys and refuses an edit of one", () => {
    writeFileSync(join(dir, "config.yaml"), MAIN);
    writeFileSync(ctx.yamlPath, WYAML);
    const cur = readFileSync(ctx.yamlPath, "utf8");
    const same = validateRegistry(cur, ctx, cur);
    expect(same.errors).toEqual([]);
    expect(same.warnings!.map((w) => w.path)).toEqual(["workers.pool.maxSlots", "workers.pool.spares", "pool"]);

    const edited = cur.replace("maxSlots: 4", "maxSlots: 5");
    const r = validateRequest(edited, hashText(cur), ctx);
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.message).toContain("reads workers.pool.maxSlots from config.yaml");

    const saved = saveRegistry(edited, hashText(cur), ctx);
    expect(saved.ok).toBe(false);
    expect(readFileSync(ctx.yamlPath, "utf8")).toBe(cur);
  });
  it("refuses a newly added unused block", () => {
    writeFileSync(ctx.yamlPath, "providers: {}\n");
    const cur = readFileSync(ctx.yamlPath, "utf8");
    const r = validateRegistry(cur + "pool:\n  max_slots: 4\n", ctx, cur);
    expect(r.errors.map((e) => e.path)).toEqual(["pool"]);
  });
  it("saves an unrelated edit while the shadowed keys stay as warnings", () => {
    writeFileSync(join(dir, "config.yaml"), MAIN);
    writeFileSync(ctx.yamlPath, WYAML);
    const cur = readFileSync(ctx.yamlPath, "utf8");
    expect(saveRegistry(cur.replace("providers: {}", "providers: {}\nbogusKey: opus"), hashText(cur), ctx).ok).toBe(false); // bogusKey is unused: new key refused
    expect(saveRegistry(cur + "\n", hashText(cur), ctx).ok).toBe(true);
  });
});

describe("daemon log", () => {
  it("writes one line per shadowed key, once per process", () => {
    writeFileSync(join(dir, "config.yaml"), MAIN);
    writeFileSync(ctx.yamlPath, WYAML);
    const prev = { c: process.env.PAI_CONFIG_FILE, w: process.env.PAI_WORKERS_YAML };
    process.env.PAI_CONFIG_FILE = ctx.mainConfigPath;
    process.env.PAI_WORKERS_YAML = ctx.yamlPath;
    try {
      const lines: string[] = [];
      logWorkersConfigShadowsOnce((l) => lines.push(l));
      logWorkersConfigShadowsOnce((l) => lines.push(l));
      expect(lines).toHaveLength(3);
      expect(lines[0]).toContain("config warning: workers.yaml:workers.pool.maxSlots");
    } finally {
      if (prev.c === undefined) delete process.env.PAI_CONFIG_FILE; else process.env.PAI_CONFIG_FILE = prev.c;
      if (prev.w === undefined) delete process.env.PAI_WORKERS_YAML; else process.env.PAI_WORKERS_YAML = prev.w;
    }
  });
});
