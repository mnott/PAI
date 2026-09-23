import { describe, it, expect } from "vitest";
import { decideWorkerGitGuard, workerGitGuardMessage } from "./worker-git-guard.js";

const CWD = "/repo";
const WORKTREES_ROOT = "/repo/.workers/worktrees";
const WORKTREE_CWD = "/repo/.workers/worktrees/abc123";

const DENIED_COMMANDS = [
  "git stash",
  "git stash pop",
  "git stash push -m wip",
  "git stash apply",
  "git stash drop",
  "git stash clear",
  "git stash save wip",
  "git stash branch new-branch",
  "git stash create",
  "git stash store stash@{0}",
  "git reset --hard",
  "git reset --hard HEAD~1",
  "git reset HEAD",
  "git clean -fd",
  "git clean -fdx",
  "git checkout -- src/file.ts",
  "git checkout HEAD -- src/file.ts",
  "git checkout .",
  "git restore src/file.ts",
  "git restore --staged src/file.ts",
  "git switch main",
  "git switch -c feature",
  "git rebase main",
  "git rebase -i HEAD~3",
  "git merge feature-branch",
  "git merge --no-ff worker/abc",
];

const ALLOWED_COMMANDS = [
  "git status",
  "git diff",
  "git diff --name-only HEAD",
  "git log --oneline -5",
  "git show HEAD",
  "git rev-parse HEAD",
  "git ls-files --others --exclude-standard",
  "git blame src/file.ts",
  "git add -A",
  "git add src/file.ts",
  "git commit -m 'wip'",
  "git checkout main",
  "git checkout -b feature",
  "git stash list",
  "git stash list --oneline",
  "git stash show",
  "git stash show -p",
  "git stash show stash@{0}",
];

describe("decideWorkerGitGuard", () => {
  for (const cmd of DENIED_COMMANDS) {
    it(`denies "${cmd}" for an in-place worker`, () => {
      const r = decideWorkerGitGuard(cmd, true, CWD, WORKTREES_ROOT);
      expect(r.blocked).toBe(true);
    });
  }

  for (const cmd of ALLOWED_COMMANDS) {
    it(`allows "${cmd}" for an in-place worker`, () => {
      expect(decideWorkerGitGuard(cmd, true, CWD, WORKTREES_ROOT).blocked).toBe(false);
    });
  }

  it("detects a denied command inside a compound line (&&)", () => {
    expect(decideWorkerGitGuard("npm test && git stash", true, CWD, WORKTREES_ROOT).blocked).toBe(
      true
    );
  });

  it("detects a denied command inside a compound line (;)", () => {
    expect(decideWorkerGitGuard("cd /tmp; git reset --hard", true, CWD, WORKTREES_ROOT).blocked).toBe(
      true
    );
  });

  it("detects a denied command inside a compound line (|)", () => {
    expect(
      decideWorkerGitGuard("echo apply | git stash apply", true, CWD, WORKTREES_ROOT).blocked
    ).toBe(true);
  });

  it("detects a denied command behind a `git -C <dir>` prefix", () => {
    expect(
      decideWorkerGitGuard("git -C /repo stash", true, CWD, WORKTREES_ROOT).blocked
    ).toBe(true);
  });

  it("allows every denied command for a worker whose cwd is inside the worktrees root", () => {
    for (const cmd of DENIED_COMMANDS) {
      expect(decideWorkerGitGuard(cmd, true, WORKTREE_CWD, WORKTREES_ROOT).blocked).toBe(false);
    }
  });

  it("allows every denied command for a non-worker session", () => {
    for (const cmd of DENIED_COMMANDS) {
      expect(decideWorkerGitGuard(cmd, false, CWD, WORKTREES_ROOT).blocked).toBe(false);
    }
  });

  it("allows read-only git regardless of worker status or cwd", () => {
    for (const cmd of ALLOWED_COMMANDS) {
      expect(decideWorkerGitGuard(cmd, true, WORKTREE_CWD, WORKTREES_ROOT).blocked).toBe(false);
      expect(decideWorkerGitGuard(cmd, false, CWD, WORKTREES_ROOT).blocked).toBe(false);
    }
  });

  it("blocks when the worktrees root could not be resolved — cannot prove cwd is a worktree", () => {
    expect(decideWorkerGitGuard("git stash", true, CWD, null).blocked).toBe(true);
  });

  it("names the matched command in the result", () => {
    expect(decideWorkerGitGuard("git stash", true, CWD, WORKTREES_ROOT).cmd).toBe("git stash");
    expect(decideWorkerGitGuard("git checkout .", true, CWD, WORKTREES_ROOT).cmd).toBe(
      "git checkout"
    );
  });
});

describe("workerGitGuardMessage", () => {
  it("names the command and the --worktree escape hatch", () => {
    const msg = workerGitGuardMessage("git stash");
    expect(msg).toContain("git stash");
    expect(msg).toContain("rewrites the shared checkout and is blocked");
    expect(msg).toContain("--worktree");
  });
});
