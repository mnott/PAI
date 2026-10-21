/** gc --foreign: merged clean worktrees PAI did not create are archived; unmerged ones are kept. */

import { beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gcWorktrees, git } from "./worktree.js";

const dir = mkdtempSync(join(tmpdir(), "pai-foreign-test-"));
const repo = join(dir, "repo");
const logDir = join(dir, "logdir");
const mergedDir = join(dir, "wt-merged");
const openDir = join(dir, "wt-open");

vi.setConfig({ testTimeout: 30_000 });

const refs = () => git(repo, ["for-each-ref", "--format=%(refname)"]);

beforeAll(() => {
  mkdirSync(repo, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "worker test"]);
  writeFileSync(join(repo, "base.txt"), "base\n", "utf8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
  git(repo, ["worktree", "add", "-q", "-b", "wip/merged-1510", mergedDir]);
  git(repo, ["worktree", "add", "-q", "-b", "wip/open", openDir]);
  writeFileSync(join(openDir, "new.txt"), "n\n", "utf8");
  git(openDir, ["add", "."]);
  git(openDir, ["commit", "-q", "-m", "open work"]);
});

describe("gcWorktrees foreign", () => {
  it("changes nothing without the flag", () => {
    gcWorktrees(logDir, 0, false, Date.now(), true);
    expect(existsSync(mergedDir)).toBe(true);
    expect(refs()).not.toContain("pai-archive");
  });

  it("dry-run lists, changes nothing", () => {
    const res = gcWorktrees(logDir, 0, true, Date.now(), true, undefined, repo);
    expect(res.find((r) => r.archive === "refs/pai-archive/wip-merged-1510")).toBeTruthy();
    expect(res.find((r) => r.id === "wip/open")?.skipped).toBe("kept: not merged");
    expect(existsSync(mergedDir)).toBe(true);
  });

  it("archives merged, keeps unmerged", () => {
    const tip = git(repo, ["rev-parse", "wip/merged-1510"]);
    const res = gcWorktrees(logDir, 0, false, Date.now(), true, undefined, repo);
    expect(res.find((r) => r.archive)?.archive).toBe("refs/pai-archive/wip-merged-1510");
    expect(existsSync(mergedDir)).toBe(false);
    expect(git(repo, ["rev-parse", "refs/pai-archive/wip-merged-1510"])).toBe(tip);
    expect(refs()).not.toContain("refs/heads/wip/merged-1510");
    expect(existsSync(openDir)).toBe(true);
    expect(refs()).toContain("refs/heads/wip/open");
    expect(res.find((r) => r.id === "wip/open")?.skipped).toBe("kept: not merged");
  });
});
