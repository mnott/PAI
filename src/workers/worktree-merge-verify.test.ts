import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, mergeWorker, runVerify } from "./worktree.js";
import { saveStatus, type WorkerStatus } from "./status.js";

const dir = mkdtempSync(join(tmpdir(), "pai-mergeverify-test-"));
const repo = join(dir, "repo");
const logDir = join(dir, "logdir");
mkdirSync(repo, { recursive: true });
git(repo, ["init", "-q"]);
git(repo, ["config", "user.email", "test@example.invalid"]);
git(repo, ["config", "user.name", "worker test"]);
writeFileSync(join(repo, "base.txt"), "base\n", "utf8");
git(repo, ["add", "."]);
git(repo, ["commit", "-q", "-m", "init"]);

function task(id: string): void {
  const base = git(repo, ["rev-parse", "HEAD"]);
  const wt = join(dir, `wt-${id}`);
  git(repo, ["worktree", "add", "-q", "-b", `worker/${id}`, wt, base]);
  writeFileSync(join(wt, `${id}.txt`), `${id}\n`, "utf8");
  git(wt, ["add", "-A"]);
  git(wt, ["commit", "-q", "-m", `${id} work`]);
  const s: WorkerStatus = {
    id, pid: process.pid, label: `label ${id}`, cwd: repo, term: "", provider: "p", model: "m",
    state: "done", started: "2026-09-17 10:00:00", updated: "2026-09-17 10:00:00",
    turns: 0, tools: 0, last: "", rc: 0, secs: 1,
    branch: `worker/${id}`, worktreeDir: wt, worktreeBase: base, worktreeSnapshot: false,
  };
  saveStatus(logDir, s);
}

const tree = () => git(repo, ["rev-parse", "HEAD^{tree}"]);

describe("merge --verify", () => {
  it("passing verify merges as usual", () => {
    task("v1");
    const msg = mergeWorker(logDir, "v1", { verify: "test -f v1.txt" });
    expect(msg).toContain("verify passed: test -f v1.txt");
    expect(msg).toContain("branch deleted");
    expect(existsSync(join(repo, "v1.txt"))).toBe(true);
  });

  it("failing verify reverts the merge and keeps the branch", () => {
    const before = tree();
    task("v2");
    expect(() => mergeWorker(logDir, "v2", { verify: "exit 3" })).toThrow(/verify failed \(exit 3\): reverted [0-9a-f]+; the worker branch is kept/);
    expect(git(repo, ["log", "-1", "--format=%s"])).toMatch(/^Revert/);
    expect(tree()).toBe(before);
    expect(existsSync(join(repo, "v2.txt"))).toBe(false);
    expect(git(repo, ["rev-parse", "--verify", "worker/v2"])).toBeTruthy();
  });

  it("re-merging a branch whose merge the gate reverted re-applies it", () => {
    task("v2b");
    expect(() => mergeWorker(logDir, "v2b", { verify: "exit 3" })).toThrow(/verify failed/);
    expect(existsSync(join(repo, "v2b.txt"))).toBe(false);
    expect(mergeWorker(logDir, "v2b")).toContain("merged");
    expect(existsSync(join(repo, "v2b.txt"))).toBe(true);
  });

  it("a fast-forward is reverted by range", () => {
    const old = git(repo, ["rev-parse", "HEAD"]);
    const before = tree();
    git(repo, ["checkout", "-q", "-b", "side"]);
    writeFileSync(join(repo, "ff.txt"), "ff\n", "utf8");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "ff work"]);
    expect(() => runVerify(repo, "false", old)).toThrow(/verify failed \(exit 1\)/);
    expect(tree()).toBe(before);
    expect(existsSync(join(repo, "ff.txt"))).toBe(false);
  });
});
