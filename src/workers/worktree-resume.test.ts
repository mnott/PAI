/**
 * A resumed worker owns the worktree it runs in: discard / merge / gc / ps
 * follow the chain old -> new, never the superseded id.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addWorktree,
  adoptTree,
  discardWorker,
  gcWorktrees,
  git,
  markResumed,
  mergeWorker,
  ownedTree,
  recordWorktree,
} from "./worktree.js";
import { statusPath } from "./paths.js";
import { loadStatus, nowStamp, saveStatus, type WorkerStatus } from "./status.js";
import { makeColor, renderTable } from "./render.js";

const dir = mkdtempSync(join(tmpdir(), "pai-resume-test-"));
const repo = join(dir, "repo");
const logDir = join(dir, "logdir");
const DAY = 24 * 3_600_000;

beforeAll(() => {
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "resume test"]);
  writeFileSync(join(repo, "base.txt"), "base\n", "utf8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
});

function status(id: string, over: Partial<WorkerStatus> = {}): WorkerStatus {
  const s: WorkerStatus = {
    id,
    pid: process.pid,
    label: `label ${id}`,
    cwd: repo,
    term: "",
    provider: "testprov",
    model: "test-1",
    state: "done",
    started: "2026-09-17 10:00:00",
    updated: "2026-09-17 10:00:00",
    turns: 0,
    tools: 0,
    last: "",
    rc: 0,
    secs: 1,
    ...over,
  };
  saveStatus(logDir, s);
  return s;
}

/** old worker with a committed file in its tree, then a resume `next` that adopts it (as executeRun does). */
function chain(oldId: string, nextId: string, file: string) {
  const info = addWorktree(logDir, oldId, repo);
  writeFileSync(join(info.dir, file), `${file}\n`, "utf8");
  git(info.dir, ["add", "."]);
  git(info.dir, ["commit", "-q", "-m", `work ${oldId}`]);
  recordWorktree(logDir, status(oldId), info, true);
  const adopted = adoptTree(logDir, oldId)!;
  expect(adopted.dir).toBe(info.dir);
  const next = status(nextId, {
    worktreeDir: adopted.dir,
    branch: adopted.branch,
    worktreeBase: adopted.base,
    worktreeSnapshot: adopted.snapshot,
    resumedFrom: oldId,
  });
  markResumed(logDir, oldId, nextId);
  return { info, next };
}

describe("resume chain ownership", () => {
  it("moves the tree to the resuming id", () => {
    const { info } = chain("r1", "r1b", "r1.txt");
    const old = loadStatus(logDir, "r1")!;
    expect(old.resumedBy).toBe("r1b");
    expect(ownedTree(old)).toBeNull();
    expect(ownedTree(loadStatus(logDir, "r1b")!)).toEqual({ dir: info.dir, branch: "worker/r1" });
  });

  it("discard on the last id removes the old tree and branch", () => {
    const { info } = chain("d1", "d1b", "d1.txt");
    const msg = discardWorker(logDir, "d1b");
    expect(msg).toMatch(/discarded worker d1b/);
    expect(existsSync(info.dir)).toBe(false);
    expect(git(repo, ["branch", "--list", "worker/d1"])).toBe("");
  });

  it("merge on the last id merges worker/<old>", () => {
    chain("m1", "m1b", "m1.txt");
    expect(mergeWorker(logDir, "m1b")).toMatch(/merged worker\/m1 /);
    expect(existsSync(join(repo, "m1.txt"))).toBe(true);
    expect(git(repo, ["branch", "--list", "worker/m1"])).toBe("");
  });

  it("refuses discard and merge on the superseded id", () => {
    const { info } = chain("s1", "s1b", "s1.txt");
    expect(() => discardWorker(logDir, "s1")).toThrow(/superseded by s1b, use that id/);
    expect(() => mergeWorker(logDir, "s1")).toThrow(/superseded by s1b, use that id/);
    expect(existsSync(info.dir)).toBe(true);
  });

  it("a chain of three: the last id owns the tree", () => {
    const { info } = chain("c1", "c2", "c.txt");
    const adopted = adoptTree(logDir, "c2")!;
    status("c3", { worktreeDir: adopted.dir, branch: adopted.branch, resumedFrom: "c2" });
    markResumed(logDir, "c2", "c3");
    expect(ownedTree(loadStatus(logDir, "c1")!)).toBeNull();
    expect(ownedTree(loadStatus(logDir, "c2")!)).toBeNull();
    expect(ownedTree(loadStatus(logDir, "c3")!)?.dir).toBe(info.dir);
  });
});

describe("gc of resume chains", () => {
  const age = (id: string, ms: number) => {
    const t = new Date(Date.now() - ms);
    utimesSync(statusPath(logDir, id), t, t);
  };

  it("reclaims an orphaned chain tree once, via the last id", () => {
    const { info } = chain("g1", "g1b", "g1.txt");
    age("g1", 3 * DAY);
    age("g1b", 3 * DAY);
    const res = gcWorktrees(logDir, 24, true).filter((r) => r.id.startsWith("g1"));
    expect(res).toEqual([{ id: "g1b", archive: "refs/pai-archive/g1b" }]);
    expect(existsSync(info.dir)).toBe(true);
    gcWorktrees(logDir, 24);
    expect(existsSync(info.dir)).toBe(false);
    expect(git(repo, ["branch", "--list", "worker/g1"])).toBe("");
    expect(git(repo, ["show", "refs/pai-archive/g1b:g1.txt"])).toBe("g1.txt");
  });

  it("spares the tree while the last id runs", () => {
    const { info } = chain("g2", "g2b", "g2.txt");
    saveStatus(logDir, { ...loadStatus(logDir, "g2b")!, state: "running", started: nowStamp() });
    age("g2", 3 * DAY);
    age("g2b", 3 * DAY);
    expect(gcWorktrees(logDir, 24).filter((r) => r.id.startsWith("g2"))).toEqual([]);
    expect(existsSync(info.dir)).toBe(true);
  });

  it("reclaims a tree whose owner chain lost its successor status", () => {
    const { info } = chain("g3", "g3b", "g3.txt");
    rmSync(statusPath(logDir, "g3b"));
    age("g3", 3 * DAY);
    const t = new Date(Date.now() - 3 * DAY);
    utimesSync(info.dir, t, t);
    expect(gcWorktrees(logDir, 24).map((r) => r.id)).toContain("g3");
    expect(existsSync(info.dir)).toBe(false);
  });
});

describe("ps", () => {
  it("shows the tree path and resume links", () => {
    chain("p1", "p1b", "p1.txt");
    const sts = [loadStatus(logDir, "p1")!, loadStatus(logDir, "p1b")!];
    const out = renderTable(makeColor(false), sts, "scope");
    expect(out).toMatch(/p1b .*tree p1 {2}resumed from p1/);
    expect(out).toMatch(/p1 .*resumed by p1b/);
    expect(out.split("\n").find((l) => /resumed by p1b/.test(l))).not.toMatch(/tree p1/);
  });
});
