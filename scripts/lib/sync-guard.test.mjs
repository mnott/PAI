/**
 * Tests for the worktree sync guard (scripts/lib/sync-guard.mjs). The guard's
 * one job: classify a build cwd as "inside a per-worker worktree" so the
 * --sync steps leave the live ~/.claude symlinks alone. Pure path logic —
 * nothing here writes outside its tmp dir (HOME is sandboxed by the setup
 * file anyway).
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isInsideWorkerWorktree, workersLogDirFromConfig } from "./sync-guard.mjs";

const dir = mkdtempSync(join(tmpdir(), "pai-sync-guard-test-"));

describe("workersLogDirFromConfig", () => {
  it("defaults to ~/.claude/logs/workers without a config", () => {
    expect(workersLogDirFromConfig(join(dir, "missing.json"))).toBe(
      join(homedir(), ".claude", "logs", "workers")
    );
  });

  it("reads workers.logDir and expands its ~", () => {
    const cfg = join(dir, "config.json");
    writeFileSync(cfg, JSON.stringify({ workers: { logDir: "~/somewhere/workers" } }), "utf8");
    expect(workersLogDirFromConfig(cfg)).toBe(join(homedir(), "somewhere", "workers"));
  });

  it("falls back to the default on a non-JSON or empty workers section", () => {
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "not json", "utf8");
    expect(workersLogDirFromConfig(bad)).toBe(join(homedir(), ".claude", "logs", "workers"));
    const empty = join(dir, "empty.json");
    writeFileSync(empty, JSON.stringify({ workers: {} }), "utf8");
    expect(workersLogDirFromConfig(empty)).toBe(join(homedir(), ".claude", "logs", "workers"));
  });
});

describe("isInsideWorkerWorktree", () => {
  const logDir = join(dir, "logs");
  const wt = join(logDir, "worktrees", "20260917-101010-123");

  it("flags the worktree itself and any path under it", () => {
    mkdirSync(wt, { recursive: true });
    expect(isInsideWorkerWorktree(wt, { logDir })).toBe(true);
    expect(isInsideWorkerWorktree(join(wt, "src", "workers"), { logDir })).toBe(true);
  });

  it("passes the main checkout and sibling dirs under logDir", () => {
    expect(isInsideWorkerWorktree("/opt/src/PAI", { logDir })).toBe(false);
    expect(isInsideWorkerWorktree(join(logDir, "specs", "20260917-1"), { logDir })).toBe(false);
    expect(isInsideWorkerWorktree(join(logDir, "worktrees-backup"), { logDir })).toBe(false);
    // prefix match must respect the separator: worktrees-other is not worktrees
    expect(isInsideWorkerWorktree(join(logDir, "worktrees-x"), { logDir })).toBe(false);
  });

  it("derives the root from the config file when no logDir is given", () => {
    const cfg = join(dir, "cfg2.json");
    writeFileSync(cfg, JSON.stringify({ workers: { logDir: join(dir, "logs") } }), "utf8");
    expect(isInsideWorkerWorktree(wt, { configPath: cfg })).toBe(true);
    expect(isInsideWorkerWorktree("/opt/src/PAI", { configPath: cfg })).toBe(false);
  });
});
