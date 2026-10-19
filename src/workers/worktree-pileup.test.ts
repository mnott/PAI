/**
 * Worktrees must not pile up: immediate cleanup of empty results, the size cap
 * of the hourly gc, and the hourly daemon schedule. Real throwaway git repo.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addWorktree,
  archiveEmptyResult,
  formatWorktreesStats,
  gcWorktrees,
  git,
  worktreesStats,
} from "./worktree.js";
import { statusPath } from "./paths.js";
import { loadStatus, nowStamp, saveStatus, type WorkerStatus } from "./status.js";

const dir = mkdtempSync(join(tmpdir(), "pai-pileup-test-"));
const repo = join(dir, "repo");
const logDir = join(dir, "logdir");
const HOUR = 3_600_000;

vi.setConfig({ testTimeout: 30_000 });

beforeAll(() => {
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "worker test"]);
  writeFileSync(join(repo, "base.txt"), "base\n", "utf8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
});

function mk(id: string, over: Partial<WorkerStatus> = {}, ageMs = 0, file?: string): { dir: string; st: WorkerStatus } {
  const wt = addWorktree(logDir, id, repo);
  const st: WorkerStatus = {
    id,
    pid: 999_999_999,
    label: id,
    cwd: repo,
    term: "",
    provider: "p",
    model: "m",
    state: "done",
    started: "2026-09-17 10:00:00",
    updated: "2026-09-17 10:00:00",
    turns: 0,
    tools: 0,
    last: "",
    rc: 0,
    secs: 1,
    worktreeDir: wt.dir,
    branch: wt.branch,
    worktreeBase: wt.base,
    ...over,
  };
  saveStatus(logDir, st);
  if (file) writeFileSync(join(wt.dir, file), "x\n", "utf8");
  const t = new Date(Date.now() - ageMs);
  utimesSync(statusPath(logDir, id), t, t);
  return { dir: wt.dir, st };
}

const refs = () => git(repo, ["for-each-ref", "--format=%(refname)"]);

describe("archiveEmptyResult", () => {
  it("removes the worktree of a finished worker with nothing to merge", () => {
    const { dir: d, st } = mk("pe-empty");
    expect(archiveEmptyResult(logDir, st)).toBe(true);
    expect(existsSync(d)).toBe(false);
    expect(refs()).toContain("refs/pai-archive/pe-empty");
    expect(refs()).not.toContain("refs/heads/worker/pe-empty");
    expect(loadStatus(logDir, "pe-empty")?.worktreeDir).toBeNull();
  });

  it("keeps a worktree with an uncommitted file or a commit", () => {
    const dirty = mk("pe-dirty", {}, 0, "d.txt");
    expect(archiveEmptyResult(logDir, dirty.st)).toBe(false);
    expect(existsSync(dirty.dir)).toBe(true);
    const committed = mk("pe-commit", {}, 0, "c.txt");
    git(committed.dir, ["add", "."]);
    git(committed.dir, ["commit", "-q", "-m", "work"]);
    expect(archiveEmptyResult(logDir, committed.st)).toBe(false);
    expect(existsSync(committed.dir)).toBe(true);
  });

  it("never touches a running worker", () => {
    const live = mk("pe-live", { state: "running", pid: process.pid, started: nowStamp() });
    expect(archiveEmptyResult(logDir, live.st)).toBe(false);
    expect(existsSync(live.dir)).toBe(true);
  });
});

describe("gc size cap", () => {
  it("archives oldest finished beyond the age rule, keeps running and unsalvageable, reports", async () => {
    const old = mk("cap-old", {}, 3 * HOUR, "o.txt");
    const newer = mk("cap-newer", {}, 2 * HOUR, "n.txt");
    const live = mk("cap-live", { state: "running", pid: process.pid, started: nowStamp() }, 5 * HOUR, "l.txt");
    const busy = mk("cap-busy", {}, 4 * HOUR, "b.txt");
    const p = spawn("sleep", ["30"], { cwd: busy.dir, stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 300));
      // age rule (6 h) archives nothing; the cap (1 byte) forces the finished ones out
      const none = gcWorktrees(logDir, 6, false, Date.now());
      expect(none.filter((r) => r.id.startsWith("cap-"))).toEqual([]);
      const res = gcWorktrees(logDir, 6, false, Date.now(), false, 1e-9).filter((r) => r.id.startsWith("cap-"));
      expect(res.find((r) => r.id === "cap-busy")?.skipped).toMatch(/busy/);
      expect(res.filter((r) => r.archive).map((r) => r.id).sort()).toEqual(["cap-newer", "cap-old"]);
      expect(existsSync(old.dir) || existsSync(newer.dir)).toBe(false);
      expect(existsSync(busy.dir)).toBe(true);
      expect(existsSync(live.dir)).toBe(true);
      expect(refs()).toContain("refs/heads/worker/cap-live");
    } finally {
      p.kill();
    }
    await new Promise((r) => p.once("exit", r));
  });
});

describe("worktreesStats", () => {
  it("counts directories and formats the header", () => {
    const s = worktreesStats(logDir);
    expect(s.count).toBeGreaterThan(0);
    expect(s.bytes).toBeGreaterThan(0);
    expect(formatWorktreesStats({ count: 3, bytes: 1.5 * 1024 ** 3 })).toBe("worktrees: 3 (1.5 GB)");
  });
});

describe("hourly daemon schedule", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.doUnmock("../workers/worktree.js");
  });

  it("runs gc every hour with the configured age and cap, regardless of quiet mode", async () => {
    vi.useFakeTimers();
    const calls: unknown[][] = [];
    vi.doMock("../workers/worktree.js", () => ({
      gcWorktreesThrottled: (...a: unknown[]) => {
        calls.push(a);
        return [];
      },
    }));
    vi.doMock("../workers/config.js", () => ({
      readWorkersSection: () => ({ workers: { logDir: logDir, gcOlderThanHours: 6, worktreesMaxGb: 20 } }),
    }));
    vi.doMock("../workers/paths.js", () => ({ workersLogDir: (w: { logDir: string }) => w.logDir }));
    const mod = await import("../daemon/worktree-gc.js");
    expect(mod.WORKTREE_GC_TICK_MS).toBe(HOUR);
    const timer = mod.startWorktreeGc();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(calls.length).toBe(2);
    expect(calls[1]?.[3]).toEqual({ olderThanHours: 6, maxGb: 20 });
    clearInterval(timer);
    vi.doUnmock("../workers/config.js");
    vi.doUnmock("../workers/paths.js");
  });
});
