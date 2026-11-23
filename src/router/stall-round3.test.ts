/**
 * Router stall round 3 (#24): per-request lookups must not rebuild or re-parse.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clearJobNameCache, defaultSources } from "./sessions.js";
import { clearParseCache, parseCacheStats } from "../config/parse-cache.js";
import { readLocalConfig } from "../workers/local-tiers.js";
import { SystemMonitor } from "./system.js";

describe("stall round 3 caches", () => {
  it("defaultSources is built once per window", () => {
    clearJobNameCache();
    const first = defaultSources();
    for (let i = 0; i < 100; i++) expect(defaultSources()).toBe(first);
    clearJobNameCache();
    expect(defaultSources()).not.toBe(first);
  });

  it("readLocalConfig parses workers.yaml once for 100 calls, again after a change", () => {
    const dir = mkdtempSync(join(tmpdir(), "stall3-"));
    try {
      const f = join(dir, "workers.yaml");
      writeFileSync(f, "providers: {}\n");
      clearParseCache();
      for (let i = 0; i < 100; i++) readLocalConfig(f);
      expect(parseCacheStats.parses).toBe(1);
      writeFileSync(f, "providers: {}\n# changed, longer\n");
      readLocalConfig(f);
      expect(parseCacheStats.parses).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("SystemMonitor spawns hw.memsize once, not per poll", async () => {
    const calls: string[] = [];
    const run = async (cmd: string, args: string[]) => {
      calls.push(`${cmd} ${args.join(" ")}`);
      return args.includes("hw.memsize") ? "17179869184\n" : "";
    };
    let t = 1_000_000;
    const m = new SystemMonitor({ file: "/dev/null", telemetryFile: "/dev/null", workersLogDir: () => tmpdir(), now: () => t, run, ttlMs: 1 });
    await m.current();
    t += 10_000;
    await m.current();
    expect(calls.filter((c) => c.includes("hw.memsize")).length).toBe(1);
    expect(calls.filter((c) => c.startsWith("vm_stat")).length).toBe(2);
  });
});
