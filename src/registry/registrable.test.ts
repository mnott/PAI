import { describe, it, expect } from "vitest";
import { unregistrableReason } from "./registrable.js";

/**
 * Directories that must never become projects.
 *
 * Measured on the real registry: two agent worktrees under `.claude/worktrees/`
 * carrying 8 sessions between them, and two `/private/tmp/` entries that are now
 * dead. All four were registered because a session started there — and a project
 * is supposed to be durable.
 */

describe("agent worktrees", () => {
  it("refuses a path inside .claude/worktrees", () => {
    const reason = unregistrableReason(
      "/Users/x/Cloud/08 - Others/MDF/Infrastruktur/.claude/worktrees/cool-haibt"
    );
    expect(reason).toBeDefined();
    expect(reason).toContain("worktree");
  });

  it("refuses a directory nested deeper inside a worktree", () => {
    expect(
      unregistrableReason("/Users/x/p/.claude/worktrees/wt/packages/thing")
    ).toBeDefined();
  });

  it("accepts an ordinary .claude directory that is not a worktree", () => {
    // Projects legitimately contain `.claude/`; only the worktrees subtree is
    // disposable.
    expect(unregistrableReason("/Users/x/p/.claude/skills/mine")).toBeUndefined();
  });
});

describe("temp directories", () => {
  it("refuses /private/tmp", () => {
    expect(unregistrableReason("/private/tmp/ops-webui")).toBeDefined();
  });

  it("refuses bare /tmp, which is the same place on macOS", () => {
    // /tmp is a symlink to /private/tmp, so only checking the "private" spelling
    // would let the same directory in under its other name.
    expect(unregistrableReason("/tmp/ops-webui")).toBeDefined();
  });

  it("refuses the macOS per-user temp directory", () => {
    expect(
      unregistrableReason("/var/folders/df/_w1gm/T/pai-scratch")
    ).toBeDefined();
  });
});

describe("not over-reaching", () => {
  it("accepts a normal project path", () => {
    expect(
      unregistrableReason("/Users/x/Daten/Cloud/Development/ai/PAI")
    ).toBeUndefined();
  });

  it("does not match a directory that merely starts with tmp", () => {
    // The guard compares whole path segments; `/tmpdir/` is not `/tmp/`.
    expect(unregistrableReason("/tmpdir/project")).toBeUndefined();
    expect(unregistrableReason("/Users/x/tmpwork/project")).toBeUndefined();
  });

  it("does not match a directory merely named worktrees", () => {
    expect(unregistrableReason("/Users/x/worktrees/project")).toBeUndefined();
  });

  it("handles a trailing separator", () => {
    expect(unregistrableReason("/private/tmp/thing/")).toBeDefined();
    expect(unregistrableReason("/Users/x/real/")).toBeUndefined();
  });

  it("refuses a worktree given as the path itself, with no trailing content", () => {
    // `.../worktrees/cool-haibt` — the fragment needs the padded comparison to
    // match when the worktree name is the final segment.
    expect(unregistrableReason("/Users/x/p/.claude/worktrees/cool-haibt")).toBeDefined();
  });
});
