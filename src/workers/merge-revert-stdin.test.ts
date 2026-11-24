import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveStatus, type WorkerStatus } from "./status.js";
import { mergeWorker, worktreePath } from "./worktree.js";

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A repo whose HEAD is a revert of a merge whose parent is unreachable (a rewritten history). */
function fixture(): { repo: string; logDir: string } {
  const base = mkdtempSync(join(tmpdir(), "merge-stdin-"));
  const repo = join(base, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t"]);
  git(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "f.txt"), "base\n");
  git(repo, ["add", "f.txt"]);
  git(repo, ["commit", "-qm", "base"]);
  // a merge commit with two parents, then its revert
  git(repo, ["checkout", "-q", "-b", "side"]);
  writeFileSync(join(repo, "s.txt"), "side\n");
  git(repo, ["add", "s.txt"]);
  git(repo, ["commit", "-qm", "side work"]);
  git(repo, ["checkout", "-q", "main"]);
  git(repo, ["merge", "--no-ff", "-q", "side", "-m", "merge worker old (old)"]);
  git(repo, ["revert", "--no-edit", "-q", "HEAD^0"]);
  // rewrite history: the merge's first parent is gone, so `revert^` cannot be read
  git(repo, ["checkout", "-q", "-b", "orphan"]);
  writeFileSync(join(repo, "o.txt"), "orphan\n");
  git(repo, ["add", "o.txt"]);
  git(repo, ["commit", "-qm", "orphan"]);
  git(repo, ["checkout", "-q", "main"]);
  git(repo, ["reset", "-q", "--hard", "orphan"]);
  const logDir = join(base, "logs");
  mkdirSync(logDir, { recursive: true });
  return { repo, logDir };
}

/** A worker whose branch is exactly the merge a failed gate reverted (incoming == 0): the reapply path. */
function makeResumeWorker(repo: string, logDir: string, id: string, merge: string): void {
  const dir = worktreePath(logDir, id);
  mkdirSync(join(logDir, "worktrees"), { recursive: true });
  git(repo, ["worktree", "add", "-q", "-B", `worker/${id}`, dir, merge]);
  const st: WorkerStatus = {
    id, pid: 99999, label: id, cwd: repo, term: "", provider: "p", model: "m", state: "done",
    started: "2026-11-24 00:00:00", updated: "2026-11-24 00:00:00", turns: 1, tools: 0, last: "", rc: 0, secs: 1,
    branch: `worker/${id}`, worktreeDir: dir, worktreeBase: merge, commits: 1,
  };
  saveStatus(logDir, st);
}

describe("merge never hangs on git apply reading an inherited stdin", () => {
  it("a revert whose diff cannot be read is skipped, not fed to apply with inherited stdin", async () => {
    const { repo, logDir } = fixture();
    const merge = git(repo, ["rev-parse", "HEAD~1"]); // the merge commit the revert undoes
    makeResumeWorker(repo, logDir, "resume", merge);
    // the merge must finish (throwing the no-commits refusal) instead of blocking on apply's stdin
    let err: unknown;
    try {
      await mergeWorker(logDir, "resume", { verifyTests: false, rebuild: false, cliRoot: null });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("has no commits to merge");
    expect(git(repo, ["log", "--format=%s"])).not.toContain("reapply");
    expect(existsSync(join(repo, "s.txt"))).toBe(false); // the revert stands: nothing was reapplied
  }, 30000);

  it("a normal reverted-merge resume still reapplies (the guard does not break the happy path)", async () => {
    const { repo, logDir } = fixture();
    // rebuild a readable revert: revert the revert so main carries the change, then revert it again
    git(repo, ["revert", "--no-edit", "-q", "HEAD^0"]); // reapply side work
    git(repo, ["checkout", "-q", "-b", "side2"]);
    writeFileSync(join(repo, "s2.txt"), "side2\n");
    git(repo, ["add", "s2.txt"]);
    git(repo, ["commit", "-qm", "side2 work"]);
    git(repo, ["checkout", "-q", "main"]);
    git(repo, ["merge", "--no-ff", "-q", "side2", "-m", "merge worker two (two)"]);
    git(repo, ["revert", "--no-edit", "-q", "HEAD^0"]);
    const merge2 = git(repo, ["rev-parse", "HEAD~1"]);
    makeResumeWorker(repo, logDir, "resume2", merge2);
    const out = await mergeWorker(logDir, "resume2", { verifyTests: false, rebuild: false, cliRoot: null });
    expect(out).toContain("merged worker/two (two) after a failed merge gate");
    expect(existsSync(join(repo, "s2.txt"))).toBe(true);
  }, 30000);
});
