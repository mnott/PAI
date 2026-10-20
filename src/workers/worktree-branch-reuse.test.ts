/** addWorktree never fails on an existing branch; an editing worker never starts in place. */

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorktree, git, worktreeRefusesStart } from "./worktree.js";
import { ledgerPath } from "./paths.js";
import { nowStamp, saveStatus, type WorkerStatus } from "./status.js";

const dir = mkdtempSync(join(tmpdir(), "pai-branch-reuse-"));
const repo = join(dir, "repo");
const logDir = join(dir, "logdir");

beforeAll(() => {
  mkdirSync(repo, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "branch test"]);
  writeFileSync(join(repo, "base.txt"), "base\n", "utf8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
});

describe("addWorktree with an existing branch", () => {
  it("reuses a branch of the same id that has no commits and is checked out nowhere", () => {
    git(repo, ["branch", "worker/r1"]);
    const info = addWorktree(logDir, "r1", repo);
    expect(info.branch).toBe("worker/r1");
    expect(git(info.dir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("worker/r1");
  });

  it("picks a new unique name when the branch has commits", () => {
    git(repo, ["branch", "worker/r2"]);
    const tmp = join(dir, "tmp-r2");
    git(repo, ["worktree", "add", tmp, "worker/r2"]);
    writeFileSync(join(tmp, "x.txt"), "x\n", "utf8");
    git(tmp, ["add", "."]);
    git(tmp, ["commit", "-q", "-m", "work"]);
    git(repo, ["worktree", "remove", "--force", tmp]);
    const info = addWorktree(logDir, "r2", repo);
    expect(info.branch).toBe("worker/r2-2");
    expect(git(repo, ["rev-parse", "worker/r2"])).not.toBe(git(repo, ["rev-parse", "worker/r2-2"]));
  });

  it("picks a new name when the branch is checked out in another worktree", () => {
    const first = addWorktree(logDir, "r3", repo);
    git(repo, ["worktree", "remove", "--force", first.dir]);
    git(repo, ["worktree", "add", join(dir, "tmp-r3"), "worker/r3"]);
    const info = addWorktree(logDir, "r3", repo);
    expect(info.branch).toBe("worker/r3-2");
  });
});

describe("snapshot while an in-place worker is running", () => {
  it("skips the snapshot and says so", () => {
    const s: WorkerStatus = {
      id: "inplace1", pid: process.pid, label: "l", cwd: repo, term: "", provider: "p", model: "m",
      state: "running", started: nowStamp(), updated: nowStamp(),
      turns: 0, tools: 0, last: "", rc: null, secs: null,
    };
    saveStatus(logDir, s);
    writeFileSync(join(repo, "half-done.txt"), "wip\n", "utf8");
    const info = addWorktree(logDir, "snapskip", repo);
    expect(info.snapshot).toBe(false);
    expect(info.snapshotSkipped).toContain("inplace1");
    expect(git(info.dir, ["ls-files", "--others", "--exclude-standard"])).toBe("");
    saveStatus(logDir, { ...s, state: "done", rc: 0 });
    const info2 = addWorktree(logDir, "snapkeep", repo);
    expect(info2.snapshot).toBe(true);
  });
});

describe("worktreeRefusesStart", () => {
  it("refuses a writing class and ledgers WORKER-NO-WORKTREE", () => {
    expect(worktreeRefusesStart(logDir, "e1", "boom", ["Read", "Edit", "Bash"])).toBe(true);
    expect(worktreeRefusesStart(logDir, "e2", "boom", [])).toBe(true);
    const led = readFileSync(ledgerPath(logDir), "utf8");
    expect(led).toContain("WORKER-NO-WORKTREE");
    expect(led).toContain("boom");
  });

  it("lets a read-only class run in place", () => {
    expect(worktreeRefusesStart(logDir, "e3", "boom", ["Read", "Grep", "Glob"])).toBe(false);
  });
});
