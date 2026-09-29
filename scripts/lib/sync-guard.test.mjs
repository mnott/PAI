/**
 * Tests for the worktree sync guard (scripts/lib/sync-guard.mjs). The guard's
 * one job: classify a build cwd as "inside a per-worker worktree" so the
 * --sync steps leave the live ~/.claude symlinks alone. Pure path logic —
 * nothing here writes outside its tmp dir (HOME is sandboxed by the setup
 * file anyway).
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isInsideWorkerWorktree, workersLogDirFromConfig, syncSkipReason } from "./sync-guard.mjs";

const dir = mkdtempSync(join(tmpdir(), "pai-sync-guard-test-"));

describe("workersLogDirFromConfig", () => {
  it("defaults to ~/.claude/logs/workers without a config", () => {
    expect(workersLogDirFromConfig(join(dir, "missing.json"))).toBe(
      join(homedir(), ".claude", "logs", "workers")
    );
  });

  it("reads workers.logDir from JSON and expands its ~", () => {
    const cfg = join(dir, "config.json");
    writeFileSync(cfg, JSON.stringify({ workers: { logDir: "~/somewhere/workers" } }), "utf8");
    expect(workersLogDirFromConfig(cfg)).toBe(join(homedir(), "somewhere", "workers"));
  });

  it("reads workers.logDir from YAML and expands its ~", () => {
    const cfg = join(dir, "config.yaml");
    writeFileSync(cfg, "workers:\n  logDir: ~/yaml-workers\n", "utf8");
    expect(workersLogDirFromConfig(cfg)).toBe(join(homedir(), "yaml-workers"));
  });

  it("falls back to the default on a non-JSON/YAML or empty workers section", () => {
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "not json or yaml", "utf8");
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

describe("syncSkipReason (canonical install)", () => {
  const mk = (name) => {
    const root = join(dir, name);
    mkdirSync(join(root, "dist", "hooks"), { recursive: true });
    writeFileSync(join(root, "package.json"), "{}", "utf8");
    writeFileSync(join(root, "dist", "hooks", "h.mjs"), "", "utf8");
    return root;
  };
  const claudeWithHook = (canon) => {
    const claudeDir = join(dir, `claude-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(claudeDir, "Hooks"), { recursive: true });
    symlinkSync(join(canon, "dist", "hooks", "h.mjs"), join(claudeDir, "Hooks", "h.mjs"));
    return claudeDir;
  };
  const logDir = join(dir, "no-workers");

  it("skips, with the message, for a repo that is not the canonical root", () => {
    const canon = mk("canon-a");
    const other = mk("other-a");
    const reason = syncSkipReason({ repoRoot: other, cwd: other, claudeDir: claudeWithHook(canon), logDir });
    expect(reason).toMatch(/^skipping symlink sync: .*other-a is not the canonical install .*canon-a$/);
  });

  it("syncs for the canonical root", () => {
    const canon = mk("canon-b");
    expect(syncSkipReason({ repoRoot: canon, cwd: canon, claudeDir: claudeWithHook(canon), logDir })).toBeNull();
  });

  it("syncs on first install (no Hooks symlinks yet)", () => {
    const repo = mk("first");
    expect(syncSkipReason({ repoRoot: repo, cwd: repo, claudeDir: join(dir, "empty-claude"), logDir })).toBeNull();
  });
});
