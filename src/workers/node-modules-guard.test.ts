/**
 * Regression: `.gitignore` with the directory-only rule `node_modules/` made
 * provisionDeps skip every worktree, and a worker's improvised node_modules
 * symlink then got committed. Throwaway repos in tmp dirs only.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, lstatSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorktree, assertNoNodeModules, git, provisionDeps, salvageUncommitted } from "./worktree.js";

function setup(): { repo: string; logDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "pai-nm-guard-"));
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "worker test"]);
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n", "utf8");
  writeFileSync(join(repo, "base.txt"), "base\n", "utf8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return { repo, logDir: join(dir, "logdir") };
}

describe("node_modules never reaches a worker branch", () => {
  it("provisionDeps provisions when .gitignore is the dir-only `node_modules/`", () => {
    const { repo, logDir } = setup();
    mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "pkg", "index.js"), "x\n", "utf8");
    const info = addWorktree(logDir, "w1", repo);
    expect(existsSync(join(info.dir, "node_modules", "pkg", "index.js"))).toBe(true);
    expect(lstatSync(join(info.dir, "node_modules")).isSymbolicLink()).toBe(false);
    // idempotent: a second call leaves the existing directory alone
    provisionDeps(logDir, "w1", repo, info.dir);
    expect(existsSync(join(info.dir, "node_modules", "pkg", "index.js"))).toBe(true);
  });

  it("salvage unstages a node_modules symlink and merge refuses a committed one", () => {
    const { repo, logDir } = setup();
    const info = addWorktree(logDir, "w2", repo);
    mkdirSync(join(info.dir, "real"));
    symlinkSync("real", join(info.dir, "node_modules")); // inside the worktree: not an escaping link
    writeFileSync(join(info.dir, "base.txt"), "changed\n", "utf8");
    const res = salvageUncommitted(info.dir, "t");
    expect(res.committed).toEqual(["base.txt"]);
    expect(res.skipped.join()).toContain("node_modules");
    expect(git(info.dir, ["ls-files", "node_modules"])).toBe("");

    // a worker's own `git add -f` + commit still cannot be merged
    git(info.dir, ["add", "-f", "node_modules"]);
    git(info.dir, ["commit", "-q", "-m", "oops"]);
    expect(() => assertNoNodeModules(repo, info.base, info.branch, "w2")).toThrow(/commits node_modules/);
  });
});
