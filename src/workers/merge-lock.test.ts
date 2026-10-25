import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, revertMerge, withMergeLock } from "./worktree.js";

function mkRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "pai-mergelock-"));
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "worker test"]);
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

describe("withMergeLock", () => {
  it("holds <git-dir>/pai-merge.lock with our pid and releases it", () => {
    const repo = mkRepo();
    const lock = join(repo, ".git", "pai-merge.lock");
    withMergeLock(repo, () => expect(readFileSync(lock, "utf8")).toBe(String(process.pid)));
    expect(existsSync(lock)).toBe(false);
  });

  it("a second merge waits for the lock, says so, then runs", () => {
    const repo = mkRepo();
    const lock = join(repo, ".git", "pai-merge.lock");
    writeFileSync(lock, String(process.ppid)); // a live other process
    const rm = spawn("sh", ["-c", `sleep 0.6; rm -f '${lock}'`], { stdio: "ignore", detached: true });
    rm.unref();
    const lines: string[] = [];
    const t0 = Date.now();
    const out = withMergeLock(repo, () => "ran", { pollMs: 50, log: (l) => lines.push(l) });
    expect(out).toBe("ran");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("waiting");
  });

  it("gives up after the wait limit and leaves the holder's lock alone", () => {
    const repo = mkRepo();
    const lock = join(repo, ".git", "pai-merge.lock");
    writeFileSync(lock, String(process.ppid));
    expect(() => withMergeLock(repo, () => 1, { waitMs: 200, pollMs: 50 })).toThrow(/holds/);
    expect(existsSync(lock)).toBe(true);
  });

  it("takes over a lock whose holder is gone", () => {
    const repo = mkRepo();
    writeFileSync(join(repo, ".git", "pai-merge.lock"), "2147483000");
    expect(withMergeLock(repo, () => "ran", { waitMs: 500 })).toBe("ran");
  });
});

describe("revertMerge", () => {
  it("reverts the recorded merge commit even when HEAD moved on", () => {
    const repo = mkRepo();
    git(repo, ["checkout", "-q", "-b", "side"]);
    writeFileSync(join(repo, "side.txt"), "side\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "side"]);
    git(repo, ["checkout", "-q", "main"]);
    git(repo, ["merge", "--no-ff", "-q", "side", "-m", "merge side"]);
    const merged = git(repo, ["rev-parse", "HEAD"]);
    writeFileSync(join(repo, "later.txt"), "later\n"); // another merge landed after ours
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "later"]);

    expect(revertMerge(repo, merged)).toBe(merged);
    expect(existsSync(join(repo, "side.txt"))).toBe(false);
    expect(existsSync(join(repo, "later.txt"))).toBe(true);
  });
});
