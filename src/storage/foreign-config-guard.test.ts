import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertDestructiveAllowed,
  detectForeignLiveDb,
  foreignConfigsOnLiveDb,
  noteForeignConfigLiveDb,
  resetForeignConfigNote,
} from "./foreign-config-guard.js";
import { PostgresRegistryBackend } from "./registry-postgres.js";
import { PostgresBackend } from "./postgres/backend.js";

const LIVE = "postgresql://u:p@localhost:5432/pai";
const cfg = (url: string): string => `postgres:\n  connectionString: ${url}\n`;

let dir: string;
let canonical: string;
let foreign: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pai-foreign-guard-"));
  mkdirSync(join(dir, "home"));
  canonical = join(dir, "home", "config.yaml");
  foreign = join(dir, "config-eval.yaml");
  writeFileSync(canonical, cfg(LIVE));
  saved = { h: process.env.PAI_HOME, c: process.env.PAI_CONFIG_FILE, a: process.env.PAI_ALLOW_FOREIGN_LIVE_DB };
  process.env.PAI_HOME = join(dir, "home");
  delete process.env.PAI_ALLOW_FOREIGN_LIVE_DB;
  resetForeignConfigNote();
});

afterEach(() => {
  for (const [k, v] of [["PAI_HOME", saved.h], ["PAI_CONFIG_FILE", saved.c], ["PAI_ALLOW_FOREIGN_LIVE_DB", saved.a]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("foreign config on the live database", () => {
  it("refuses destructive operations and logs one line per process for the rest", () => {
    writeFileSync(foreign, cfg(LIVE));
    process.env.PAI_CONFIG_FILE = foreign;
    expect(() => assertDestructiveAllowed("registry reset")).toThrow(/foreign config \(.*config-eval\.yaml\) on the live database localhost:5432\/pai; refusing registry reset\. Point the config at its own database \(e\.g\. pai_eval\)/);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(noteForeignConfigLiveDb()).toMatch(/^FOREIGN-CONFIG-LIVE-DB path=.*config-eval\.yaml .*pid=\d+ cmd=/);
    expect(noteForeignConfigLiveDb()).toBeNull();
    expect(err).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(dir, "home", "logs", "foreign-config.log"), "utf8").match(/FOREIGN-CONFIG-LIVE-DB/g)).toHaveLength(1);
  });

  it("guards every destructive method of the postgres backends before touching the pool", async () => {
    writeFileSync(foreign, cfg(LIVE));
    process.env.PAI_CONFIG_FILE = foreign;
    const pool = { connect: vi.fn(), query: vi.fn() };
    const reg = Object.assign(Object.create(PostgresRegistryBackend.prototype), { pool }) as PostgresRegistryBackend;
    const calls: Array<Promise<unknown>> = [
      reg.resetRegistry(),
      reg.deleteProject(1),
      reg.deleteProjectCascade(1),
      reg.applyProjectMerge({} as never),
      reg.repairOrphans({ dryRun: false }),
      reg.repairOrphans({ dryRun: false, deleteTwins: true }),
      PostgresBackend.prototype.clearEmbeddingsBatch.call({ pool }, 10),
    ];
    for (const c of calls) await expect(c).rejects.toThrow(/refusing/);
    expect(pool.connect).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("allows everything, silently, when the foreign config has its own database", () => {
    writeFileSync(foreign, cfg("postgresql://u:p@localhost:5432/pai_eval"));
    process.env.PAI_CONFIG_FILE = foreign;
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(() => assertDestructiveAllowed("registry reset")).not.toThrow();
    expect(noteForeignConfigLiveDb()).toBeNull();
    expect(err).not.toHaveBeenCalled();
  });

  it("is unchanged for the canonical config, set explicitly or not at all", () => {
    expect(detectForeignLiveDb()).toBeNull();
    process.env.PAI_CONFIG_FILE = canonical;
    expect(detectForeignLiveDb()).toBeNull();
    expect(() => assertDestructiveAllowed("registry reset")).not.toThrow();
  });

  it("matches host aliases and parts-style config, not a different port", () => {
    process.env.PAI_CONFIG_FILE = foreign;
    writeFileSync(foreign, "postgres:\n  host: 127.0.0.1\n  port: 5432\n  database: pai\n");
    expect(detectForeignLiveDb()).not.toBeNull();
    writeFileSync(foreign, "postgres:\n  host: 127.0.0.1\n  port: 5433\n  database: pai\n");
    expect(detectForeignLiveDb()).toBeNull();
  });

  it("PAI_ALLOW_FOREIGN_LIVE_DB=1 overrides", () => {
    writeFileSync(foreign, cfg(LIVE));
    process.env.PAI_CONFIG_FILE = foreign;
    process.env.PAI_ALLOW_FOREIGN_LIVE_DB = "1";
    expect(() => assertDestructiveAllowed("registry reset")).not.toThrow();
    expect(noteForeignConfigLiveDb()).toBeNull();
  });

  it("the doctor scan lists foreign configs on the live database only", () => {
    const cache = join(dir, "cache");
    mkdirSync(join(cache, "eval"), { recursive: true });
    writeFileSync(join(cache, "eval", "live.yaml"), cfg(LIVE));
    writeFileSync(join(cache, "eval", "own.yaml"), cfg("postgresql://u:p@localhost:5432/pai_eval"));
    writeFileSync(join(cache, "eval", "notes.json"), "{}");
    expect(foreignConfigsOnLiveDb(cache).map((f) => f.path)).toEqual([join(cache, "eval", "live.yaml")]);
  });
});
