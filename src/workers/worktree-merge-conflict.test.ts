import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, mergeWorker } from "./worktree.js";
import { saveStatus, type WorkerStatus } from "./status.js";

const dir = mkdtempSync(join(tmpdir(), "pai-mergeconflict-test-"));
const repo = join(dir, "repo");
const logDir = join(dir, "logdir");
mkdirSync(repo, { recursive: true });
git(repo, ["init", "-q"]);
git(repo, ["config", "user.email", "test@example.invalid"]);
git(repo, ["config", "user.name", "worker test"]);
writeFileSync(join(repo, "clash.txt"), "base\n", "utf8");
git(repo, ["add", "."]);
git(repo, ["commit", "-q", "-m", "init"]);

describe("merge conflict", () => {
  it("aborts the merge, leaves the target clean, names the files", () => {
    const base = git(repo, ["rev-parse", "HEAD"]);
    const wt = join(dir, "wt-c1");
    git(repo, ["worktree", "add", "-q", "-b", "worker/c1", wt, base]);
    writeFileSync(join(wt, "clash.txt"), "worker\n", "utf8");
    git(wt, ["add", "-A"]);
    git(wt, ["commit", "-q", "-m", "worker change"]);
    writeFileSync(join(repo, "clash.txt"), "main\n", "utf8");
    git(repo, ["commit", "-q", "-am", "main change"]);
    const head = git(repo, ["rev-parse", "HEAD"]);
    const s: WorkerStatus = {
      id: "c1", pid: process.pid, label: "clash", cwd: repo, term: "", provider: "p", model: "m",
      state: "done", started: "2026-09-17 10:00:00", updated: "2026-09-17 10:00:00",
      turns: 0, tools: 0, last: "", rc: 0, secs: 1,
      branch: "worker/c1", worktreeDir: wt, worktreeBase: base, worktreeSnapshot: false,
    };
    saveStatus(logDir, s);
    expect(() => mergeWorker(logDir, "c1")).toThrow(/conflict in clash\.txt: merge main into the worker branch in its kept worktree .*re-run pai worker merge c1/);
    expect(git(repo, ["status", "--porcelain"])).toBe("");
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(false);
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(head);
    expect(existsSync(wt)).toBe(true);
    expect(git(repo, ["rev-parse", "--verify", "worker/c1"])).toBeTruthy();
  });
});
