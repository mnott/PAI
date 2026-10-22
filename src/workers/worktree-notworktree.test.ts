import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorktree, gcWorktrees, git, worktreesDir } from "./worktree.js";

const dir = mkdtempSync(join(tmpdir(), "pai-notwt-test-"));
// the log dir lives inside an enclosing repository with uncommitted changes
const repo = join(dir, "config");
const logDir = join(repo, "logs");
mkdirSync(logDir, { recursive: true });
git(repo, ["init", "-q", "-b", "main"]);
git(repo, ["config", "user.email", "t@example.invalid"]);
git(repo, ["config", "user.name", "t"]);
writeFileSync(join(repo, "config.yaml"), "a: 1\n");
git(repo, ["add", "."]);
git(repo, ["commit", "-q", "-m", "init"]);
writeFileSync(join(repo, "config.yaml"), "a: 2\n");
writeFileSync(join(repo, "workers.yaml"), "new\n");

const old = (p: string): void => utimesSync(p, new Date(2020, 0, 1), new Date(2020, 0, 1));

describe("gc only touches real worktrees", () => {
  it("a leftover dir with only node_modules is not a worktree and the enclosing repo is untouched", () => {
    const leftover = join(worktreesDir(logDir), "w-left");
    mkdirSync(join(leftover, "node_modules"), { recursive: true });
    old(leftover);
    const before = git(repo, ["status", "--porcelain"]);
    const stashes = git(repo, ["stash", "list"]);

    for (const dry of [true, false]) {
      const res = gcWorktrees(logDir, 0, dry, Date.now(), true).filter((r) => r.id === "w-left");
      expect(res).toEqual([{ id: "w-left", skipped: "not a worktree" }]);
    }
    expect(existsSync(join(leftover, "node_modules"))).toBe(true);
    expect(git(repo, ["status", "--porcelain"])).toBe(before);
    expect(git(repo, ["stash", "list"])).toBe(stashes);
    expect(readFileSync(join(repo, "config.yaml"), "utf8")).toBe("a: 2\n");
    expect(git(repo, ["for-each-ref", "refs/pai-archive"])).toBe("");
  });

  it("a real worktree still archives", () => {
    const real = join(dir, "real");
    mkdirSync(real);
    git(real, ["init", "-q", "-b", "main"]);
    git(real, ["config", "user.email", "t@example.invalid"]);
    git(real, ["config", "user.name", "t"]);
    writeFileSync(join(real, "b.txt"), "b\n");
    git(real, ["add", "."]);
    git(real, ["commit", "-q", "-m", "base"]);
    const wt = addWorktree(logDir, "w-real", real);
    writeFileSync(join(wt.dir, "x.txt"), "x\n");
    old(wt.dir);
    const res = gcWorktrees(logDir, 0, false, Date.now(), true).filter((r) => r.id === "w-real");
    expect(res[0]?.archive).toBe("refs/pai-archive/w-real");
  });
});
