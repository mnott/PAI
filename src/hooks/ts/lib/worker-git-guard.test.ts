import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideWorkerGitGuard, workerGitGuardMessage, PRIVATE_CLONE_MARKER } from "./worker-git-guard.js";

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

  it("allows read-only git plumbing that shares a verb prefix", () => {
    const cmd = 'git merge-base --is-ancestor 1e9d57ed HEAD && echo "IN HEAD" || echo no';
    expect(decideWorkerGitGuard(cmd, true, "/repo", "/wt").blocked).toBe(false);
    expect(decideWorkerGitGuard("git merge main", true, "/repo", "/wt").blocked).toBe(true);
  });
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

describe("private clone marker", () => {
  const mk = (marked: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), "pcg-"));
    execFileSync("git", ["init", "-q", dir]);
    if (marked) writeFileSync(join(dir, ".git", PRIVATE_CLONE_MARKER), "");
    return dir;
  };
  const marked = mk(true);
  const unmarked = mk(false);
  const plain = mkdtempSync(join(tmpdir(), "pcg-plain-"));

  it("allows tree-rewriting git in a marked clone", () => {
    expect(decideWorkerGitGuard("git merge x", true, marked, WORKTREES_ROOT).blocked).toBe(false);
    expect(decideWorkerGitGuard("git stash", true, marked, null).blocked).toBe(false);
  });
  it("blocks in an unmarked git dir and in a non-git dir", () => {
    expect(decideWorkerGitGuard("git merge x", true, unmarked, WORKTREES_ROOT).blocked).toBe(true);
    expect(decideWorkerGitGuard("git merge x", true, plain, WORKTREES_ROOT).blocked).toBe(true);
  });
  it("blocks with a null worktrees root unless marked", () => {
    expect(decideWorkerGitGuard("git reset --hard", true, unmarked, null).blocked).toBe(true);
    expect(decideWorkerGitGuard("git reset --hard", true, marked, null).blocked).toBe(false);
  });
  it("does not let git -C or cd borrow the marker of cwd", () => {
    expect(decideWorkerGitGuard("git -C /some/shared/checkout merge x", true, marked, null).blocked).toBe(true);
    expect(decideWorkerGitGuard("cd /some/shared/checkout && git merge x", true, marked, null).blocked).toBe(true);
  });
});

describe("worktree escape", () => {
  const deny = (c: string) => decideWorkerGitGuard(c, true, WORKTREE_CWD, WORKTREES_ROOT).blocked;
  it("blocks git writes aimed at the main checkout", () => {
    expect(deny("cd /Users/x/dev/PAI && git commit -m x")).toBe(true);
    expect(deny("git -C /Users/x/dev/PAI add -A")).toBe(true);
  });
  it("allows relative work, scratch and own-worktree targets", () => {
    expect(deny("git add -A && git commit -m x")).toBe(false);
    expect(deny("cd /var/folders/ab/cd/T/pai-scratch/abc123/s && git add f")).toBe(false);
    expect(deny("cd /var/folders/ab/cd/T/pai-scratch/other/s && git add f")).toBe(true);
    expect(deny("cd ../other && git commit -m x")).toBe(true);
    expect(deny(`cd ${WORKTREE_CWD}/src && git commit -m x`)).toBe(false);
    expect(deny("cd /Users/x/dev/PAI && npx tsc --noEmit")).toBe(false);
    expect(deny("cd /Users/x/dev/PAI && git log --oneline -1")).toBe(false);
  });
  it("blocks relative and env/flag retargeting", () => {
    expect(deny("git -C ../../main commit -am x")).toBe(true);
    expect(deny("cd ../../main && git commit -am x")).toBe(true);
    expect(deny("GIT_DIR=/main/.git git commit -am x")).toBe(true);
    expect(deny("git --git-dir=/main/.git commit -am x")).toBe(true);
    expect(deny("git --work-tree=/main commit -am x")).toBe(true);
    expect(deny("export GIT_DIR=/main/.git; git commit -am x")).toBe(true);
    expect(deny("cd /main; git push")).toBe(true);
  });
  it("judges each command segment on its own", () => {
    expect(deny("git push && cd /main")).toBe(false);
    expect(deny("git commit -m 'a && cd /main'")).toBe(false);
    expect(deny("cd src && git commit -am x")).toBe(false);
    expect(deny("git -C . add f")).toBe(false);
    expect(deny("cd /main && git log; git commit -m x")).toBe(true);
  });
});
