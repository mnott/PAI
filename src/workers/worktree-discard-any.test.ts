import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ledgerPath } from "./paths.js";
import { discardWorktree, git } from "./worktree.js";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "pai-discard-any-")));
const logDir = join(dir, "logdir");
mkdirSync(logDir, { recursive: true });

function makeRepo(name: string): string {
  const repo = join(dir, name);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "discard test"]);
  writeFileSync(join(repo, "base.txt"), "base\n", "utf8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

function tree(repo: string, branch: string): string {
  const wt = join(dir, `wt-${branch}`);
  git(repo, ["worktree", "add", "-q", "-b", branch, wt]);
  writeFileSync(join(wt, `${branch}.txt`), "work\n", "utf8");
  git(wt, ["add", "-A"]);
  git(wt, ["commit", "-q", "-m", "work"]);
  return wt;
}

const hasRef = (repo: string, ref: string): boolean => {
  try {
    git(repo, ["rev-parse", "--verify", "-q", ref]);
    return true;
  } catch {
    return false;
  }
};

describe("discardWorktree", () => {
  it("removes an ad-hoc worktree, archives its commits, deletes the branch", () => {
    const repo = makeRepo("repo-a");
    const wt = tree(repo, "port-1");
    const tip = git(wt, ["rev-parse", "HEAD"]);
    const msg = discardWorktree(logDir, wt);
    expect(msg).toContain("refs/pai-archive/port-1");
    expect(existsSync(wt)).toBe(false);
    expect(git(repo, ["rev-parse", "refs/pai-archive/port-1"])).toBe(tip);
    expect(hasRef(repo, "refs/heads/port-1")).toBe(false);
    expect(readFileSync(ledgerPath(logDir), "utf8").length).toBeGreaterThan(0);
  });

  it("refuses a dirty tree without --force, archives the dirty state with it", () => {
    const repo = makeRepo("repo-b");
    const wt = tree(repo, "port-2");
    writeFileSync(join(wt, "dirty.txt"), "uncommitted\n", "utf8");
    expect(() => discardWorktree(logDir, wt)).toThrow(/uncommitted/);
    expect(existsSync(wt)).toBe(true);
    discardWorktree(logDir, wt, true);
    expect(existsSync(wt)).toBe(false);
    expect(git(repo, ["show", "refs/pai-archive/port-2:dirty.txt"])).toBe("uncommitted");
    expect(hasRef(repo, "refs/heads/port-2")).toBe(false);
  });

  it("refuses the main working tree", () => {
    const repo = makeRepo("repo-c");
    tree(repo, "port-3");
    expect(() => discardWorktree(logDir, repo, true)).toThrow(/main working tree/);
    expect(existsSync(repo)).toBe(true);
  });

  it("handles a worktree of another repo than the process cwd", () => {
    const other = makeRepo("repo-d");
    const wt = tree(other, "port-4");
    expect(process.cwd()).not.toBe(other);
    discardWorktree(logDir, wt);
    expect(existsSync(wt)).toBe(false);
    expect(hasRef(other, "refs/pai-archive/port-4")).toBe(true);
  });
});
