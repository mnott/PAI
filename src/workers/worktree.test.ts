/**
 * Tests for worktrees: the default decision, and add/record/merge/discard
 * against a real throwaway git repository in a tmp dir. Nothing here touches
 * any repository of the operator's.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addWorktree,
  commitsSince,
  discardWorker,
  git,
  isGitRepo,
  mergeWorker,
  promptLooksReadonly,
  recordWorktree,
  worktreeBranch,
  worktreePath,
  worktreeWanted,
  worktreeSystemPrompt,
} from "./worktree.js";
import { loadStatus, saveStatus, type WorkerStatus } from "./status.js";

const dir = mkdtempSync(join(tmpdir(), "pai-worktree-test-"));
const repo = join(dir, "repo");
const logDir = join(dir, "logdir");

beforeAll(() => {
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "worker test"]);
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

describe("isGitRepo / promptLooksReadonly / worktreeWanted", () => {
  it("knows a git repo from a plain dir", () => {
    expect(isGitRepo(repo)).toBe(true);
    expect(isGitRepo(join(dir, "not-a-repo"))).toBe(false);
  });

  it("spots read-only prompts by marker and leading verb", () => {
    expect(promptLooksReadonly("Review the diff and report problems")).toBe(true);
    expect(promptLooksReadonly("read-only: check the build")).toBe(true);
    expect(promptLooksReadonly("Do not modify anything, just look")).toBe(true);
    expect(promptLooksReadonly("")).toBe(true);
    expect(promptLooksReadonly("Create three files")).toBe(false);
    expect(promptLooksReadonly("Fix the button styling")).toBe(false);
  });

  it("defaults to a worktree for writing classes in a git repo with a writing prompt", () => {
    const yes = { cwd: repo, className: "implement", prompt: "Create a file" };
    expect(worktreeWanted(undefined, yes)).toBe(true);
    expect(worktreeWanted(undefined, { ...yes, className: "complex" })).toBe(true);
    expect(worktreeWanted(undefined, { ...yes, className: "plan" })).toBe(true);
    expect(worktreeWanted(undefined, { ...yes, className: "review" })).toBe(false);
    expect(worktreeWanted(undefined, { ...yes, className: undefined })).toBe(false);
    expect(worktreeWanted(undefined, { ...yes, prompt: "Review the code" })).toBe(false);
    expect(worktreeWanted(undefined, { cwd: join(dir, "not-a-repo"), className: "implement", prompt: "Create" })).toBe(false);
  });

  it("lets --worktree force one on and --no-worktree force one off", () => {
    const ctx = { cwd: repo, className: "implement", prompt: "Create a file" };
    expect(worktreeWanted(true, { ...ctx, className: "review", prompt: "Review it" })).toBe(true);
    expect(worktreeWanted(false, ctx)).toBe(false);
  });
});

describe("addWorktree / commitsSince / recordWorktree", () => {
  it("creates <logDir>/worktrees/<id> on branch worker/<id> from HEAD", () => {
    const info = addWorktree(logDir, "w1", repo);
    expect(info.branch).toBe("worker/w1");
    expect(info.dir).toBe(worktreePath(logDir, "w1"));
    expect(existsSync(join(info.dir, "base.txt"))).toBe(true);
    expect(git(repo, ["branch", "--list", "worker/w1"])).toMatch(/^\+? ?worker\/w1$/); // + = checked out here
    expect(commitsSince(info.dir, info.base)).toBe(0);
  });

  it("counts the worker's commits and records them in its status", () => {
    const info = addWorktree(logDir, "w2", repo);
    writeFileSync(join(info.dir, "new.txt"), "new\n", "utf8");
    git(info.dir, ["add", "."]);
    git(info.dir, ["commit", "-q", "-m", "work"]);
    const st = status("w2");
    const saved = recordWorktree(logDir, st, info, true);
    expect(saved.branch).toBe("worker/w2");
    expect(saved.commits).toBe(1);
    expect(loadStatus(logDir, "w2")?.worktreeDir).toBe(info.dir);
  });

  it("cleans up a failed run's worktree and branch", () => {
    const info = addWorktree(logDir, "w3", repo);
    const st = status("w3");
    recordWorktree(logDir, st, info, false);
    expect(existsSync(info.dir)).toBe(false);
    expect(git(repo, ["branch", "--list", "worker/w3"])).toBe("");
    const after = loadStatus(logDir, "w3");
    expect(after?.branch ?? null).toBeNull();
  });
});

describe("mergeWorker", () => {
  it("merges --no-ff into the original checkout and removes the worktree", () => {
    const info = addWorktree(logDir, "w4", repo);
    writeFileSync(join(info.dir, "merged.txt"), "from worker\n", "utf8");
    git(info.dir, ["add", "."]);
    git(info.dir, ["commit", "-q", "-m", "work"]);
    const st = status("w4");
    recordWorktree(logDir, st, info, true);

    const msg = mergeWorker(logDir, "w4");
    expect(msg).toMatch(/merged worker\/w4/);
    expect(readFileSync(join(repo, "merged.txt"), "utf8")).toBe("from worker\n");
    expect(existsSync(info.dir)).toBe(false);
    expect(git(repo, ["log", "-1", "--format=%s"])).toMatch(/merge worker w4/);
    expect(loadStatus(logDir, "w4")?.merged).toBe(true);

    // a second merge is a no-op that says so
    expect(mergeWorker(logDir, "w4")).toMatch(/already merged/);
  });

  it("refuses workers without a worktree branch", () => {
    status("inplace");
    expect(() => mergeWorker(logDir, "inplace")).toThrow(/no worktree branch/);
    expect(() => mergeWorker(logDir, "nosuchworker")).toThrow(/no worker named/);
  });
});

describe("discardWorker", () => {
  it("drops worktree and branch, keeping nothing", () => {
    const info = addWorktree(logDir, "w5", repo);
    writeFileSync(join(info.dir, "gone.txt"), "gone\n", "utf8");
    git(info.dir, ["add", "."]);
    git(info.dir, ["commit", "-q", "-m", "work"]);
    const st = status("w5");
    recordWorktree(logDir, st, info, true);

    const msg = discardWorker(logDir, "w5");
    expect(msg).toMatch(/discarded worker w5/);
    expect(existsSync(info.dir)).toBe(false);
    expect(git(repo, ["branch", "--list", "worker/w5"])).toBe("");
    expect(existsSync(join(repo, "gone.txt"))).toBe(false);
    expect(loadStatus(logDir, "w5")?.branch ?? null).toBeNull();
  });
});

describe("worktreeSystemPrompt", () => {
  it("tells the worker it may commit its branch but not merge or push", () => {
    const p = worktreeSystemPrompt("w6", "worker/w6", "/tmp/dir");
    expect(p).toMatch(/own git worktree/);
    expect(p).toMatch(/worker\/w6/);
    expect(p).toMatch(/committing here is expected/);
    expect(p).toMatch(/Do not merge, rebase or push/);
    expect(p).toMatch(/pai worker merge/);
  });
});

describe("worktreeBranch", () => {
  it("names the branch after the worker id", () => {
    expect(worktreeBranch("20260917-101010-123")).toBe("worker/20260917-101010-123");
  });
});
