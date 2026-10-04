/**
 * Tests for worktrees: the default decision, and add/record/merge/discard
 * against a real throwaway git repository in a tmp dir. Nothing here touches
 * any repository of the operator's.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, utimesSync, symlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addWorktree,
  assertWorktreeClean,
  commitsSince,
  discardWorker,
  gcWorktrees,
  gcWorktreesThrottled,
  git,
  isGitRepo,
  mergeWorker,
  recordWorktree,
  salvageOnExit,
  salvageUncommitted,
  uncommittedPaths,
  worktreeBranch,
  worktreePath,
  worktreeWanted,
  worktreeSystemPrompt,
  inPlaceSystemPrompt,
} from "./worktree.js";
import { statusPath } from "./paths.js";
import { loadStatus, nowStamp, saveStatus, type WorkerStatus } from "./status.js";

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

describe("isGitRepo / worktreeWanted", () => {
  it("knows a git repo from a plain dir", () => {
    expect(isGitRepo(repo)).toBe(true);
    expect(isGitRepo(join(dir, "not-a-repo"))).toBe(false);
  });

  it("decides by tools, not class: any writing tool or no restriction -> worktree", () => {
    expect(worktreeWanted(undefined, { cwd: repo, allowedTools: ["Read,Edit"] })).toBe(true);
    expect(worktreeWanted(undefined, { cwd: repo, allowedTools: ["Read,Edit,Write,Bash"] })).toBe(true);
    expect(worktreeWanted(undefined, { cwd: repo, allowedTools: ["Bash(git *)"] })).toBe(true);
    expect(worktreeWanted(undefined, { cwd: repo, allowedTools: ["Bash", "mcp__clickr__click"] })).toBe(true);
    expect(worktreeWanted(undefined, { cwd: repo, allowedTools: [] })).toBe(true);
  });

  it("read-only tool sets get none; neither does a non-git cwd", () => {
    expect(worktreeWanted(undefined, { cwd: repo, allowedTools: ["Read,Grep,Glob"] })).toBe(false);
    expect(worktreeWanted(undefined, { cwd: repo, allowedTools: ["Read", "WebFetch,WebSearch", "mcp__pai__memory_search"] })).toBe(false);
    expect(worktreeWanted(undefined, { cwd: join(dir, "not-a-repo"), allowedTools: [] })).toBe(false);
  });

  it("lets --worktree force one on and --no-worktree force one off", () => {
    expect(worktreeWanted(true, { cwd: repo, allowedTools: ["Read"] })).toBe(true);
    expect(worktreeWanted(false, { cwd: repo, allowedTools: ["Edit"] })).toBe(false);
    expect(worktreeWanted(false, { cwd: repo, allowedTools: [] })).toBe(false);
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

describe("addWorktree snapshot: dirty parent checkout", () => {
  const repoSnap = join(dir, "repo-snap");

  beforeAll(() => {
    mkdirSync(repoSnap, { recursive: true });
    git(repoSnap, ["init", "-q"]);
    git(repoSnap, ["config", "user.email", "test@example.invalid"]);
    git(repoSnap, ["config", "user.name", "worker test"]);
    writeFileSync(join(repoSnap, "base.txt"), "base\n", "utf8");
    git(repoSnap, ["add", "."]);
    git(repoSnap, ["commit", "-q", "-m", "init"]);
  });

  // returns repoSnap to its just-committed state: no dirt left by a prior test
  function resetRepoSnap(): void {
    git(repoSnap, ["checkout", "--", "."]);
    git(repoSnap, ["clean", "-fdq"]);
  }

  it("gives the worktree the checkout's uncommitted content, and leaves the checkout byte-identical", () => {
    resetRepoSnap();
    writeFileSync(join(repoSnap, "base.txt"), "dirty tracked edit\n", "utf8"); // modified tracked file
    writeFileSync(join(repoSnap, "scratch.txt"), "untracked scratch\n", "utf8"); // untracked file

    const beforeStatus = git(repoSnap, ["status", "--porcelain"]);
    const beforeDiff = git(repoSnap, ["diff"]);
    const beforeDiffCached = git(repoSnap, ["diff", "--cached"]);
    const beforeHead = git(repoSnap, ["rev-parse", "HEAD"]);

    const info = addWorktree(logDir, "snap1", repoSnap);
    expect(info.snapshot).toBe(true);
    expect(readFileSync(join(info.dir, "base.txt"), "utf8")).toBe("dirty tracked edit\n");
    expect(readFileSync(join(info.dir, "scratch.txt"), "utf8")).toBe("untracked scratch\n");

    expect(git(repoSnap, ["status", "--porcelain"])).toBe(beforeStatus);
    expect(git(repoSnap, ["diff"])).toBe(beforeDiff);
    expect(git(repoSnap, ["diff", "--cached"])).toBe(beforeDiffCached);
    expect(git(repoSnap, ["rev-parse", "HEAD"])).toBe(beforeHead);

    status("snap1", { cwd: repoSnap, branch: info.branch, worktreeDir: info.dir });
    discardWorker(logDir, "snap1");
  });

  it("takes the old, non-snapshot path on a clean checkout even in this repo", () => {
    resetRepoSnap();
    const info = addWorktree(logDir, "snap-clean", repoSnap);
    expect(info.snapshot).toBe(false);
    expect(info.base).toBe(git(repoSnap, ["rev-parse", "HEAD"]));
    status("snap-clean", { cwd: repoSnap, branch: info.branch, worktreeDir: info.dir });
    discardWorker(logDir, "snap-clean");
  });

  it("merge applies the worker's own changes to the checkout as uncommitted edits, without touching HEAD or committing the snapshot on main", () => {
    resetRepoSnap();
    writeFileSync(join(repoSnap, "base.txt"), "dirty tracked edit\n", "utf8");
    writeFileSync(join(repoSnap, "scratch.txt"), "untracked scratch\n", "utf8");
    const beforeHead = git(repoSnap, ["rev-parse", "HEAD"]);

    const info = addWorktree(logDir, "snap2", repoSnap);
    const st = status("snap2", { cwd: repoSnap });
    recordWorktree(logDir, st, info, true);

    writeFileSync(join(info.dir, "new-feature.txt"), "brand new\n", "utf8"); // a new file
    writeFileSync(join(info.dir, "scratch.txt"), "scratch edited by worker\n", "utf8"); // edit to the untracked-turned-snapshotted file
    git(info.dir, ["add", "-A"]);
    git(info.dir, ["commit", "-q", "-m", "worker work"]);

    const msg = mergeWorker(logDir, "snap2");
    expect(msg).toMatch(/applied worker snap2's changes/);
    expect(msg).toMatch(/new-feature\.txt/);
    expect(msg).toMatch(/scratch\.txt/);

    // the branch's changes landed as uncommitted edits in the checkout
    expect(readFileSync(join(repoSnap, "new-feature.txt"), "utf8")).toBe("brand new\n");
    expect(readFileSync(join(repoSnap, "scratch.txt"), "utf8")).toBe("scratch edited by worker\n");
    // base.txt was dirty before the worker ran and untouched by its branch — still dirty, unchanged
    expect(readFileSync(join(repoSnap, "base.txt"), "utf8")).toBe("dirty tracked edit\n");

    // worktree and branch gone
    expect(existsSync(info.dir)).toBe(false);
    expect(git(repoSnap, ["branch", "--list", "worker/snap2"])).toBe("");
    // HEAD never moved: no merge commit, no commit on main at all
    expect(git(repoSnap, ["rev-parse", "HEAD"])).toBe(beforeHead);
    // the snapshot commit is not reachable from any ref left in the repo
    expect(git(repoSnap, ["log", "--all", "--oneline"])).not.toMatch(/snapshot of uncommitted checkout/);
    expect(loadStatus(logDir, "snap2")?.merged).toBe(true);
  });

  it("refuses the merge when the operator edited a touched path after the snapshot, and changes nothing", () => {
    resetRepoSnap();
    writeFileSync(join(repoSnap, "base.txt"), "dirty tracked edit\n", "utf8");
    const beforeHead = git(repoSnap, ["rev-parse", "HEAD"]);

    const info = addWorktree(logDir, "snap3", repoSnap);
    const st = status("snap3", { cwd: repoSnap });
    recordWorktree(logDir, st, info, true);

    writeFileSync(join(info.dir, "base.txt"), "edited by worker\n", "utf8");
    git(info.dir, ["add", "-A"]);
    git(info.dir, ["commit", "-q", "-m", "worker work"]);

    // the operator keeps editing the checkout after the snapshot was taken
    writeFileSync(join(repoSnap, "base.txt"), "operator edit after snapshot\n", "utf8");

    expect(() => mergeWorker(logDir, "snap3")).toThrow(/base\.txt/);
    expect(() => mergeWorker(logDir, "snap3")).toThrow(/changed since the worktree's snapshot/);

    // nothing changed: checkout keeps the operator's edit, worktree and branch survive
    expect(readFileSync(join(repoSnap, "base.txt"), "utf8")).toBe("operator edit after snapshot\n");
    expect(existsSync(info.dir)).toBe(true);
    expect(readFileSync(join(info.dir, "base.txt"), "utf8")).toBe("edited by worker\n"); // worker's work intact
    expect(git(repoSnap, ["branch", "--list", "worker/snap3"])).not.toBe("");
    expect(git(repoSnap, ["rev-parse", "HEAD"])).toBe(beforeHead);
    expect(loadStatus(logDir, "snap3")?.merged).toBeFalsy();

    // cleanup: the operator resolves it by hand, then merge succeeds
    writeFileSync(join(repoSnap, "base.txt"), "dirty tracked edit\n", "utf8");
    const msg = mergeWorker(logDir, "snap3");
    expect(msg).toMatch(/applied worker snap3's changes/);
    expect(readFileSync(join(repoSnap, "base.txt"), "utf8")).toBe("edited by worker\n");
  });
});

describe("uncommittedPaths / salvageUncommitted / assertWorktreeClean", () => {
  it("lists tracked edits and untracked files, and salvage commits them under the label", () => {
    const info = addWorktree(logDir, "s1", repo);
    status("s1", { branch: worktreeBranch("s1"), worktreeDir: info.dir });
    writeFileSync(join(info.dir, "s1.txt"), "committed\n", "utf8");
    git(info.dir, ["add", "."]);
    git(info.dir, ["commit", "-q", "-m", "work"]);
    writeFileSync(join(info.dir, "base.txt"), "salvage edit\n", "utf8"); // tracked, uncommitted
    writeFileSync(join(info.dir, "salvaged.txt"), "untracked\n", "utf8"); // never added
    expect(uncommittedPaths(info.dir).sort()).toEqual(["base.txt", "salvaged.txt"]);

    const salvage = salvageUncommitted(info.dir, "label s1");
    expect(salvage.committed.sort()).toEqual(["base.txt", "salvaged.txt"]);
    expect(salvage.skipped).toEqual([]);
    expect(git(info.dir, ["log", "-1", "--format=%s"])).toBe("salvaged: label s1");
    expect(uncommittedPaths(info.dir)).toEqual([]);

    discardWorker(logDir, "s1");
  });

  it("salvages nothing from a clean worktree", () => {
    const info = addWorktree(logDir, "s2", repo);
    status("s2", { branch: worktreeBranch("s2"), worktreeDir: info.dir });
    expect(salvageUncommitted(info.dir, "label s2")).toEqual({ committed: [], skipped: [] });
    discardWorker(logDir, "s2");
  });

  it("skips a symlink whose target resolves outside the worktree, and reports it", () => {
    // the bug this guards against: a repo whose .gitignore uses `node_modules/`
    // (directories only) does not ignore a *symlink* named node_modules, so a
    // worker's convenience link to the main checkout's real node_modules
    // turns up as untracked and would otherwise be salvaged, merged, and
    // checked out over the real directory on the other side.
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n", "utf8");
    git(repo, ["add", ".gitignore"]);
    git(repo, ["commit", "-q", "-m", "ignore node_modules dirs"]);
    mkdirSync(join(repo, "node_modules"));
    writeFileSync(join(repo, "node_modules", "marker.txt"), "real node_modules\n", "utf8");

    const info = addWorktree(logDir, "s4", repo);
    status("s4", { branch: worktreeBranch("s4"), worktreeDir: info.dir });
    writeFileSync(join(info.dir, "real.txt"), "real uncommitted work\n", "utf8");
    rmSync(join(info.dir, "node_modules"), { recursive: true, force: true }); // provisioned clone
    symlinkSync(join(repo, "node_modules"), join(info.dir, "node_modules"));

    const salvage = salvageUncommitted(info.dir, "label s4");
    expect(salvage.committed).toEqual(["real.txt"]);
    expect(salvage.skipped).toHaveLength(1);
    expect(salvage.skipped[0]).toMatch(/^symlink node_modules -> .*\(points outside the worktree\)$/);
    expect(git(info.dir, ["log", "-1", "--name-only", "--format=%s"])).not.toMatch(/node_modules/);
    expect(lstatSync(join(info.dir, "node_modules")).isSymbolicLink()).toBe(true);

    const msg = mergeWorker(logDir, "s4");
    expect(msg).toMatch(/skipped symlink node_modules ->/);
    // the merge-level assertion: the main checkout's real node_modules
    // directory is untouched, not replaced by a symlink
    expect(lstatSync(join(repo, "node_modules")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(repo, "node_modules", "marker.txt"), "utf8")).toBe("real node_modules\n");
    expect(existsSync(join(repo, "real.txt"))).toBe(true);
  });

  it("salvages a staged deletion together with edits and untracked files in one commit", () => {
    const info = addWorktree(logDir, "s5", repo);
    status("s5", { branch: worktreeBranch("s5"), worktreeDir: info.dir });
    writeFileSync(join(info.dir, "gone.txt"), "x\n", "utf8");
    git(info.dir, ["add", "."]);
    git(info.dir, ["commit", "-q", "-m", "add gone"]);
    git(info.dir, ["rm", "-q", "gone.txt"]); // staged deletion: "D  gone.txt"
    writeFileSync(join(info.dir, "base.txt"), "edited\n", "utf8");
    writeFileSync(join(info.dir, "new.txt"), "new\n", "utf8");

    const salvage = salvageUncommitted(info.dir, "label s5");
    expect(salvage.committed.sort()).toEqual(["base.txt", "gone.txt", "new.txt"]);
    expect(git(info.dir, ["log", "-1", "--name-status", "--format=%s"])).toMatch(/D\tgone\.txt/);
    expect(uncommittedPaths(info.dir)).toEqual([]);
    discardWorker(logDir, "s5");
  });

  it("does not salvage an unstaged deletion, it reports it as missing", () => {
    const info = addWorktree(logDir, "s6", repo);
    status("s6", { branch: worktreeBranch("s6"), worktreeDir: info.dir });
    rmSync(join(info.dir, "base.txt"));
    const r = salvageUncommitted(info.dir, "label s6");
    expect(r.committed).toEqual([]);
    expect(r.skipped).toEqual(["base.txt (missing, not committed)"]);
    expect(commitsSince(info.dir, info.base)).toBe(0);
    discardWorker(logDir, "s6");
  });

  it("still skips an outside symlink alongside a staged deletion", () => {
    const info = addWorktree(logDir, "s7", repo);
    status("s7", { branch: worktreeBranch("s7"), worktreeDir: info.dir });
    git(info.dir, ["rm", "-q", "base.txt"]);
    symlinkSync(repo, join(info.dir, "outside-link"));
    const salvage = salvageUncommitted(info.dir, "label s7");
    expect(salvage.committed).toEqual(["base.txt"]);
    expect(salvage.skipped).toHaveLength(1);
    expect(git(info.dir, ["log", "-1", "--name-only", "--format=%s"])).not.toMatch(/outside-link/);
    expect(lstatSync(join(info.dir, "outside-link")).isSymbolicLink()).toBe(true);
    discardWorker(logDir, "s7");
  });

  it("assertWorktreeClean throws on dirt, passes on a clean worktree", () => {
    const info = addWorktree(logDir, "s3", repo);
    status("s3", { branch: worktreeBranch("s3"), worktreeDir: info.dir });
    assertWorktreeClean(info.dir, "s3"); // clean: no throw
    writeFileSync(join(info.dir, "dirt.txt"), "dirt\n", "utf8");
    expect(() => assertWorktreeClean(info.dir, "s3")).toThrow(/dirt\.txt/);
    expect(() => assertWorktreeClean(info.dir, "s3")).toThrow(/NOT removed/);
    discardWorker(logDir, "s3");
  });
});

describe("mergeWorker", () => {
  it("merges --no-ff into the original checkout, removes the worktree, deletes the branch", () => {
    const info = addWorktree(logDir, "w4", repo);
    writeFileSync(join(info.dir, "merged.txt"), "from worker\n", "utf8");
    git(info.dir, ["add", "."]);
    git(info.dir, ["commit", "-q", "-m", "work"]);
    const st = status("w4");
    recordWorktree(logDir, st, info, true);

    const msg = mergeWorker(logDir, "w4");
    expect(msg).toMatch(/merged worker\/w4/);
    expect(msg).toMatch(/branch deleted/);
    expect(readFileSync(join(repo, "merged.txt"), "utf8")).toBe("from worker\n");
    expect(existsSync(info.dir)).toBe(false);
    expect(git(repo, ["branch", "--list", "worker/w4"])).toBe("");
    expect(git(repo, ["log", "-1", "--format=%s"])).toMatch(/merge worker w4/);
    expect(loadStatus(logDir, "w4")?.merged).toBe(true);

    // a second merge is a no-op that says so
    expect(mergeWorker(logDir, "w4")).toMatch(/already merged/);
  });

  it("salvages uncommitted edits and untracked files onto the branch before merging", () => {
    const info = addWorktree(logDir, "w7", repo);
    writeFileSync(join(info.dir, "carried-commit.txt"), "committed\n", "utf8");
    git(info.dir, ["add", "."]);
    git(info.dir, ["commit", "-q", "-m", "work"]);
    writeFileSync(join(info.dir, "base.txt"), "edited by worker\n", "utf8"); // tracked, uncommitted
    writeFileSync(join(info.dir, "carried.txt"), "untracked\n", "utf8"); // never added
    const st = status("w7");
    recordWorktree(logDir, st, info, true);

    const msg = mergeWorker(logDir, "w7");
    expect(readFileSync(join(repo, "base.txt"), "utf8")).toBe("edited by worker\n");
    expect(readFileSync(join(repo, "carried.txt"), "utf8")).toBe("untracked\n");
    expect(existsSync(info.dir)).toBe(false);
    expect(git(repo, ["branch", "--list", "worker/w7"])).toBe("");
    expect(msg).toMatch(/salvaged 2 uncommitted change\(s\): base\.txt, carried\.txt/);
    // the branch history carries the salvage commit as an ancestor of the merge
    expect(git(repo, ["log", "--format=%s"])).toContain("salvaged: label w7");
    expect(loadStatus(logDir, "w7")?.merged).toBe(true);
  });

  it("refuses a clean branch with no commits and keeps the worktree", () => {
    const info = addWorktree(logDir, "w9", repo);
    const st = status("w9");
    recordWorktree(logDir, st, info, true);

    expect(() => mergeWorker(logDir, "w9")).toThrow(/no commits to merge/);
    expect(() => mergeWorker(logDir, "w9")).toThrow(/NOT removed/);
    expect(existsSync(info.dir)).toBe(true);
    expect(loadStatus(logDir, "w9")?.merged ?? false).toBeFalsy();

    // cleanup for the next tests: discard is the documented way out
    discardWorker(logDir, "w9");
  });

  it("refuses the merge when the checkout is dirty in a path the branch touches (tracked edit)", () => {
    const info = addWorktree(logDir, "w8", repo);
    writeFileSync(join(info.dir, "w8-commit.txt"), "committed\n", "utf8");
    git(info.dir, ["add", "."]);
    git(info.dir, ["commit", "-q", "-m", "work"]);
    writeFileSync(join(info.dir, "base.txt"), "worker edit\n", "utf8"); // salvage lands it on the branch
    const st = status("w8");
    recordWorktree(logDir, st, info, true);
    const before = readFileSync(join(repo, "base.txt"), "utf8");
    writeFileSync(join(repo, "base.txt"), "operator edit\n", "utf8"); // dirty in the checkout

    expect(() => mergeWorker(logDir, "w8")).toThrow(/base\.txt/);
    expect(() => mergeWorker(logDir, "w8")).toThrow(/Commit or stash/);
    expect(readFileSync(join(repo, "base.txt"), "utf8")).toBe("operator edit\n"); // untouched
    expect(git(repo, ["log", "-1", "--format=%s"])).not.toMatch(/merge worker w8/); // no merge commit
    expect(existsSync(info.dir)).toBe(true); // worktree kept
    expect(readFileSync(join(info.dir, "base.txt"), "utf8")).toBe("worker edit\n"); // work intact
    expect(loadStatus(logDir, "w8")?.merged).toBeFalsy();

    // cleanup: restore the checkout to its committed content, then merge
    writeFileSync(join(repo, "base.txt"), before, "utf8");
    const msg = mergeWorker(logDir, "w8");
    expect(msg).toMatch(/merged worker\/w8/);
    expect(readFileSync(join(repo, "base.txt"), "utf8")).toBe("worker edit\n");
  });

  it("refuses the merge when the checkout holds an untracked file the branch adds", () => {
    const info = addWorktree(logDir, "w10", repo);
    writeFileSync(join(info.dir, "new-file.txt"), "from worker\n", "utf8");
    git(info.dir, ["add", "."]);
    git(info.dir, ["commit", "-q", "-m", "work"]);
    const st = status("w10");
    recordWorktree(logDir, st, info, true);
    writeFileSync(join(repo, "new-file.txt"), "operator version\n", "utf8"); // untracked dirt

    expect(() => mergeWorker(logDir, "w10")).toThrow(/new-file\.txt/);
    expect(readFileSync(join(repo, "new-file.txt"), "utf8")).toBe("operator version\n");
    expect(existsSync(info.dir)).toBe(true);
    expect(loadStatus(logDir, "w10")?.merged).toBeFalsy();

    // cleanup: drop the untracked file, then merge
    rmSync(join(repo, "new-file.txt"));
    expect(mergeWorker(logDir, "w10")).toMatch(/merged worker\/w10/);
  });

  it("lets non-overlapping dirt in the checkout pass", () => {
    const info = addWorktree(logDir, "w11", repo);
    writeFileSync(join(info.dir, "w11.txt"), "from worker\n", "utf8");
    git(info.dir, ["add", "."]);
    git(info.dir, ["commit", "-q", "-m", "work"]);
    const st = status("w11");
    recordWorktree(logDir, st, info, true);
    writeFileSync(join(repo, "unrelated-dirt.txt"), "operator scratch\n", "utf8"); // untouched by the branch

    const msg = mergeWorker(logDir, "w11");
    expect(msg).toMatch(/merged worker\/w11/);
    expect(readFileSync(join(repo, "w11.txt"), "utf8")).toBe("from worker\n");
    expect(readFileSync(join(repo, "unrelated-dirt.txt"), "utf8")).toBe("operator scratch\n");
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

  it("demands relative paths only inside the worktree", () => {
    const p = worktreeSystemPrompt("w6", "worker/w6", "/tmp/dir");
    expect(p).toMatch(/ONLY relative paths/);
    expect(p).toMatch(/never absolute worktree paths/);
  });
});

describe("inPlaceSystemPrompt", () => {
  it("tells the worker it shares the checkout and names the blocked git commands", () => {
    const p = inPlaceSystemPrompt();
    expect(p).toMatch(/shared git checkout/);
    expect(p).toMatch(/git stash \(except list\/show\), reset, clean, checkout\/restore of files, switch, rebase and merge/);
    expect(p).toMatch(/baselines from measurements taken before you edit/);
    expect(p).toMatch(/Read-only git \(status, diff, log, show, stash list\) is fine/);
  });
});

describe("worktreeBranch", () => {
  it("names the branch after the worker id", () => {
    expect(worktreeBranch("20260917-101010-123")).toBe("worker/20260917-101010-123");
  });
});


describe("gcWorktrees", () => {
  const gcLog = join(dir, "gclog");
  const DAY = 24 * 3_600_000;
  function mk(id: string, over: Partial<WorkerStatus> = {}, ageMs = 0): string {
    const wt = addWorktree(gcLog, id, repo);
    saveStatus(gcLog, { ...status(id), cwd: repo, worktreeDir: wt.dir, branch: wt.branch, ...over });
    writeFileSync(join(wt.dir, `${id}.txt`), "leftover\n", "utf8");
    const t = new Date(Date.now() - ageMs);
    utimesSync(statusPath(gcLog, id), t, t);
    return wt.dir;
  }
  const refs = () => git(repo, ["for-each-ref", "--format=%(refname)"]);

  it("archives old finished, spares running and young, dry run changes nothing", () => {
    const old = mk("gc-old", {}, 3 * DAY);
    const live = mk("gc-live", { state: "running", started: nowStamp() }, 3 * DAY);
    const young = mk("gc-young", {}, 1000);

    const dry = gcWorktrees(gcLog, 24, true);
    expect(dry.map((r) => r.id)).toEqual(["gc-old"]);
    expect(existsSync(old)).toBe(true);
    expect(refs()).toContain("refs/heads/worker/gc-old");

    const res = gcWorktrees(gcLog, 24);
    expect(res).toEqual([{ id: "gc-old", archive: "refs/pai-archive/gc-old" }]);
    expect(existsSync(old)).toBe(false);
    expect(refs()).not.toContain("refs/heads/worker/gc-old");
    expect(git(repo, ["show", "refs/pai-archive/gc-old:gc-old.txt"])).toBe("leftover");
    expect(git(repo, ["log", "-1", "--format=%s", "refs/pai-archive/gc-old"])).toBe(
      "archive: leftover state of worker gc-old"
    );
    expect(loadStatus(gcLog, "gc-old")?.archived).toBe("refs/pai-archive/gc-old");
    expect(existsSync(live) && existsSync(young)).toBe(true);
    expect(refs()).toContain("refs/heads/worker/gc-live");
    expect(refs()).toContain("refs/heads/worker/gc-young");
  });

  it("archives a status-less orphan directory", () => {
    const wt = addWorktree(gcLog, "gc-orphan", repo);
    writeFileSync(join(wt.dir, "o.txt"), "orphan\n", "utf8");
    const t = new Date(Date.now() - 3 * DAY);
    utimesSync(wt.dir, t, t);
    const res = gcWorktrees(gcLog, 24);
    expect(res.map((r) => r.id)).toEqual(["gc-orphan"]);
    expect(existsSync(wt.dir)).toBe(false);
    expect(git(repo, ["show", "refs/pai-archive/gc-orphan:o.txt"])).toBe("orphan");
    expect(refs()).not.toContain("refs/heads/worker/gc-orphan");
  });

  it("archives a child whose recorded cwd is a parent worktree gc removed first", () => {
    const parent = mk("gc-aparent", {}, 3 * DAY);
    const cdir = addWorktree(gcLog, "gc-bchild", parent);
    saveStatus(gcLog, { ...status("gc-bchild"), cwd: parent, worktreeDir: cdir.dir, branch: cdir.branch });
    const t = new Date(Date.now() - 3 * DAY);
    utimesSync(statusPath(gcLog, "gc-bchild"), t, t);
    const res = gcWorktrees(gcLog, 24);
    expect(res.filter((r) => r.skipped)).toEqual([]);
    expect(res.map((r) => r.id).sort()).toEqual(["gc-aparent", "gc-bchild"]);
    expect(existsSync(parent) || existsSync(cdir.dir)).toBe(false);
    expect(refs()).toContain("refs/pai-archive/gc-aparent");
    expect(refs()).toContain("refs/pai-archive/gc-bchild");
    expect(refs()).not.toContain("refs/heads/worker/gc-aparent");
    expect(refs()).not.toContain("refs/heads/worker/gc-bchild");
    expect(git(repo, ["fsck", "--no-dangling"])).not.toMatch(/error/i);
  });

  it("throttles to once per interval", () => {
    const tl =join(dir, "gclog-throttle");
    mkdirSync(tl, { recursive: true });
    expect(gcWorktreesThrottled(tl, 60)).toEqual([]);
    expect(gcWorktreesThrottled(tl, 60)).toBeNull();
    expect(gcWorktreesThrottled(tl, 60, Date.now() + 2 * 3_600_000)).toEqual([]);
  });
});

describe("provisioned dependencies and exit salvage", () => {
  // own repo: node_modules must be gitignored, like the real one
  const r2 = join(dir, "repo2");
  const log2 = join(dir, "logdir2");
  beforeAll(() => {
    mkdirSync(join(r2, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(r2, "node_modules", "pkg", "index.js"), "x\n", "utf8");
    writeFileSync(join(r2, ".gitignore"), "node_modules\n", "utf8");
    git(r2, ["init", "-q"]);
    git(r2, ["config", "user.email", "test@example.invalid"]);
    git(r2, ["config", "user.name", "worker test"]);
    git(r2, ["add", "."]);
    git(r2, ["commit", "-q", "-m", "init"]);
  });

  it("gives the worktree its own real node_modules directory, never a symlink", () => {
    const wt = addWorktree(log2, "deps1", r2);
    const nm = join(wt.dir, "node_modules");
    expect(lstatSync(nm).isSymbolicLink()).toBe(false);
    expect(lstatSync(nm).isDirectory()).toBe(true);
    expect(readFileSync(join(nm, "pkg", "index.js"), "utf8")).toBe("x\n");
    expect(uncommittedPaths(wt.dir)).toEqual([]);
  });

  it("salvageOnExit (the kill-signal path) commits leftovers, logs WORKER-SALVAGE, and the branch survives a failed record", () => {
    const wt = addWorktree(log2, "sig1", r2);
    writeFileSync(join(wt.dir, "fix.txt"), "work\n", "utf8");
    const ledger = join(dir, "sig1-ledger.log");
    expect(salvageOnExit(ledger, "sig1", "sig test", wt.dir, 5_000)).toEqual(["fix.txt"]);
    expect(readFileSync(ledger, "utf8")).toContain("WORKER-SALVAGE");
    const s = recordWorktree(log2, status("sig1", { cwd: r2, state: "killed" }), wt, false);
    expect(s.branch).toBe(wt.branch);
    expect(existsSync(join(wt.dir, "fix.txt"))).toBe(true);
  });

  it("a failed run with no commits still drops its worktree", () => {
    const wt = addWorktree(log2, "nowork", r2);
    recordWorktree(log2, status("nowork", { cwd: r2 }), wt, false);
    expect(existsSync(wt.dir)).toBe(false);
  });
});
