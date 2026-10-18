import { describe, it, expect } from "vitest";
import { mainSessionBashReason, SLOT_GIT_REASON, AD_HOC_REMOVAL_REASON } from "./main-session-git-gate.js";

const SLOT = "/Users/x/.claude/pai/logs/workers/slots/slot-1";

describe("mainSessionBashReason", () => {
  for (const sub of ["checkout main", "switch -c x", "reset --hard", "clean -fd", "stash"]) {
    it(`denies git -C slot ${sub}`, () => expect(mainSessionBashReason(`git -C ${SLOT} ${sub}`, "/repo")).toBe(SLOT_GIT_REASON));
  }
  it("denies after cd into a slot", () => expect(mainSessionBashReason(`cd ${SLOT} && git checkout -q main`, "/repo")).toBe(SLOT_GIT_REASON));
  it("denies relative cd from the slots dir", () =>
    expect(mainSessionBashReason("cd slot-1; git reset --hard", "/Users/x/.claude/pai/logs/workers/slots")).toBe(SLOT_GIT_REASON));
  it("allows read-only git in a slot", () => {
    expect(mainSessionBashReason(`git -C ${SLOT} diff --stat`, "/repo")).toBeNull();
    expect(mainSessionBashReason(`cd ${SLOT} && git status`, "/repo")).toBeNull();
  });
  it("allows checkout in a normal repo", () => expect(mainSessionBashReason("git checkout -b feature", "/repo")).toBeNull());
  it("a later cd out of the slot clears it", () => expect(mainSessionBashReason(`cd ${SLOT} && cd /repo && git checkout x`, "/x")).toBeNull());

  for (const c of ["git worktree remove /tmp/wt", "git worktree remove --force x", "git worktree prune", "git branch -D worker/abc", "git branch -d worker/abc", "git -C /r branch -D worker/abc", "git branch --delete worker/abc"]) {
    it(`denies ${c}`, () => expect(mainSessionBashReason(c, "/repo")).toBe(AD_HOC_REMOVAL_REASON));
  }
  it("allows other branch deletes and worktree add/list", () => {
    expect(mainSessionBashReason("git branch -D feature", "/repo")).toBeNull();
    expect(mainSessionBashReason("git branch --list 'worker/*'", "/repo")).toBeNull();
    expect(mainSessionBashReason("git worktree list", "/repo")).toBeNull();
    expect(mainSessionBashReason("git worktree add ../x", "/repo")).toBeNull();
  });
  it("ignores heredoc text", () => expect(mainSessionBashReason("cat <<'EOF'\ngit worktree prune\nEOF", "/repo")).toBeNull());
});
