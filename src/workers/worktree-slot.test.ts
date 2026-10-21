import { describe, it, expect, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardWorker, gcWorktrees, git, isSlotWorktree, mergeWorker, worktreePath } from "./worktree.js";
import { statusPath } from "./paths.js";
import { loadStatus, nowStamp, saveStatus, type WorkerStatus } from "./status.js";

const dir = mkdtempSync(join(tmpdir(), "pai-wtslot-test-"));
const repo = join(dir, "repo");
const logDir = join(dir, "logdir");

// Create the repo exactly like worktree.test.ts does
mkdirSync(repo, { recursive: true });
git(repo, ["init", "-q"]);
git(repo, ["config", "user.email", "test@example.invalid"]);
git(repo, ["config", "user.name", "worker test"]);
writeFileSync(join(repo, "base.txt"), "base\n", "utf8");
git(repo, ["add", "."]);
git(repo, ["commit", "-q", "-m", "init"]);

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

function makeTask(id: string, detach: boolean): { slotDir: string; base: string } {
  const slotDir = join(logDir, "slots", "prov-1");
  if (!existsSync(slotDir)) {
    mkdirSync(join(logDir, "slots"), { recursive: true });
    git(repo, ["worktree", "add", "--detach", slotDir, "HEAD"]);
  }
  const base = git(repo, ["rev-parse", "HEAD"]);
  git(slotDir, ["checkout", "-q", "-b", `worker/${id}`, base]);
  writeFileSync(join(slotDir, `${id}.txt`), `${id}\n`, "utf8");
  git(slotDir, ["add", "-A"]);
  git(slotDir, ["commit", "-q", "-m", `${id} work`]);
  if (detach) git(slotDir, ["checkout", "-q", "--detach"]);
  saveStatus(logDir, status(id, { branch: `worker/${id}`, worktreeDir: slotDir, worktreeBase: base, worktreeSnapshot: false, state: "done" }));
  return { slotDir, base };
}

describe("slot worktrees", () => {
  // a) "isSlotWorktree": expect(isSlotWorktree(join(logDir, "slots", "prov-1"))).toBe(true); expect(isSlotWorktree(worktreePath(logDir, "x"))).toBe(false).
  it("isSlotWorktree", () => {
    expect(isSlotWorktree(join(logDir, "slots", "prov-1"))).toBe(true);
    expect(isSlotWorktree(worktreePath(logDir, "x"))).toBe(false);
  });

  // b) "merge keeps the slot worktree": const { slotDir } = makeTask("s1", true); const msg = mergeWorker(logDir, "s1"); expect(msg).toContain("slot worktree kept"); expect(existsSync(slotDir)).toBe(true); expect(existsSync(join(repo, "s1.txt"))).toBe(true); expect(() => git(repo, ["rev-parse", "--verify", "worker/s1"])).toThrow().
  it("merge keeps the slot worktree", () => {
    const { slotDir } = makeTask("s1", true);
    const msg = mergeWorker(logDir, "s1");
    expect(msg).toContain("slot worktree kept");
    expect(existsSync(slotDir)).toBe(true);
    expect(existsSync(join(repo, "s1.txt"))).toBe(true);
    expect(() => git(repo, ["rev-parse", "--verify", "worker/s1"])).toThrow();
  });

  // c) "merge while the slot is still on the branch": const { slotDir } = makeTask("s2", false); mergeWorker(logDir, "s2"); expect(existsSync(slotDir)).toBe(true); expect(() => git(repo, ["rev-parse", "--verify", "worker/s2"])).toThrow().  (Before makeTask the slot must be detached — it is, from test b.)
  it("merge while the slot is still on the branch", () => {
    const { slotDir } = makeTask("s2", false);
    mergeWorker(logDir, "s2");
    expect(existsSync(slotDir)).toBe(true);
    expect(() => git(repo, ["rev-parse", "--verify", "worker/s2"])).toThrow();
  });

  // d) "discard keeps the slot worktree": const { slotDir } = makeTask("s3", true); const msg = discardWorker(logDir, "s3"); expect(msg).toContain("slot worktree kept"); expect(existsSync(slotDir)).toBe(true); expect(() => git(repo, ["rev-parse", "--verify", "worker/s3"])).toThrow().
  it("discard keeps the slot worktree", () => {
    const { slotDir } = makeTask("s3", true);
    const msg = discardWorker(logDir, "s3");
    expect(msg).toContain("slot worktree kept");
    expect(existsSync(slotDir)).toBe(true);
    expect(() => git(repo, ["rev-parse", "--verify", "worker/s3"])).toThrow();
  });

  it("discard with the slot gone archives and deletes the branch in the repo that holds it", () => {
    const { slotDir } = makeTask("dg5", true);
    const missing = join(dir, "gone-cwd");
    saveStatus(logDir, { ...loadStatus(logDir, "dg5")!, cwd: missing });
    git(repo, ["worktree", "remove", "--force", slotDir]);
    const spy = vi.spyOn(process, "cwd").mockReturnValue(repo);
    try {
      const tip = git(repo, ["rev-parse", "worker/dg5"]);
      const msg = discardWorker(logDir, "dg5");
      expect(msg).toContain("deleted");
      expect(() => git(repo, ["rev-parse", "--verify", "worker/dg5"])).toThrow();
      expect(git(repo, ["rev-parse", "refs/pai-archive/dg5"])).toBe(tip);
    } finally {
      spy.mockRestore();
    }
  });

  it("discard where no repo has the branch fails and says nothing deleted", () => {
    const { slotDir } = makeTask("dg6", true);
    const other = join(dir, "other");
    mkdirSync(other, { recursive: true });
    git(other, ["init", "-q"]);
    saveStatus(logDir, { ...loadStatus(logDir, "dg6")!, cwd: join(dir, "gone-cwd"), worktreeDir: join(logDir, "slots", "gone-9") });
    git(repo, ["worktree", "remove", "--force", slotDir]);
    const spy = vi.spyOn(process, "cwd").mockReturnValue(other);
    try {
      expect(() => discardWorker(logDir, "dg6")).toThrow(/nothing discarded/);
      expect(git(repo, ["rev-parse", "--verify", "worker/dg6"])).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });

  // e) "gc never removes a slot worktree": const { slotDir } = makeTask("s4", true); gcWorktrees(logDir, 0); expect(existsSync(slotDir)).toBe(true).
  it("gc never removes a slot worktree", () => {
    const { slotDir } = makeTask("s4", true);
    gcWorktrees(logDir, 0);
    expect(existsSync(slotDir)).toBe(true);
  });

  it("gc archives finished slot branches (dry run first) and adopts a detached HEAD", () => {
    const { slotDir } = makeTask("s5", true);
    // detached commit past the branch tip
    writeFileSync(join(slotDir, "s5-extra.txt"), "x\n", "utf8");
    git(slotDir, ["add", "-A"]);
    git(slotDir, ["commit", "-q", "-m", "detached work"]);
    const head = git(slotDir, ["rev-parse", "HEAD"]);
    const old = new Date(Date.now() - 3 * 24 * 3_600_000);
    utimesSync(statusPath(logDir, "s5"), old, old);
    const dry = gcWorktrees(logDir, 24, true).filter((r) => r.id === "s5");
    expect(dry).toEqual([{ id: "s5", archive: "refs/pai-archive/s5" }]);
    expect(git(repo, ["rev-parse", "--verify", "worker/s5"])).toBeTruthy();
    const res = gcWorktrees(logDir, 24).filter((r) => r.id === "s5");
    expect(res).toEqual([{ id: "s5", archive: "refs/pai-archive/s5", adopted: head }]);
    expect(() => git(repo, ["rev-parse", "--verify", "worker/s5"])).toThrow();
    expect(git(repo, ["rev-parse", "refs/pai-archive/s5"])).toBe(head);
    expect(existsSync(slotDir)).toBe(true);
    expect(loadStatus(logDir, "s5")?.archived).toBe("refs/pai-archive/s5");
  });

  it("mergeWorker adopts a detached HEAD descended from the branch tip", () => {
    const { slotDir } = makeTask("s6", true);
    writeFileSync(join(slotDir, "s6-extra.txt"), "x\n", "utf8");
    git(slotDir, ["add", "-A"]);
    git(slotDir, ["commit", "-q", "-m", "detached work"]);
    mergeWorker(logDir, "s6");
    expect(existsSync(join(repo, "s6-extra.txt"))).toBe(true);
  });
});
