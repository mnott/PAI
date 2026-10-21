/** gc reclaims worktrees whose work is on main (by hash or by patch), at any age; keeps everything else with a reason. */

import { beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorktree, gcWorktrees, git, worktreesDir } from "./worktree.js";
import { nowStamp, saveStatus, type WorkerStatus } from "./status.js";

const dir = mkdtempSync(join(tmpdir(), "pai-landed-test-"));
const repo = join(dir, "repo");
const logDir = join(dir, "logdir");

vi.setConfig({ testTimeout: 60_000 });

function mk(id: string, over: Partial<WorkerStatus> = {}): string {
  const wt = addWorktree(logDir, id, repo);
  saveStatus(logDir, {
    id,
    pid: 999_999_999,
    label: id,
    cwd: repo,
    term: "",
    provider: "p",
    model: "m",
    state: "done",
    started: "2026-09-17 10:00:00",
    updated: "2026-09-17 10:00:00",
    turns: 0,
    tools: 0,
    last: "",
    rc: 0,
    secs: 1,
    worktreeDir: wt.dir,
    branch: wt.branch,
    worktreeBase: wt.base,
    ...over,
  });
  return wt.dir;
}

function commit(d: string, file: string): void {
  writeFileSync(join(d, file), `${file}\n`, "utf8");
  git(d, ["add", "."]);
  git(d, ["commit", "-q", "-m", `add ${file}`]);
}

const dirs: Record<string, string> = {};

beforeAll(() => {
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "worker test"]);
  commit(repo, "base.txt");

  dirs.hash = mk("l-hash");
  commit(dirs.hash, "hash.txt");
  dirs.patch = mk("l-patch");
  commit(dirs.patch, "patch.txt");
  dirs.dirty = mk("l-dirty");
  commit(dirs.dirty, "dirty.txt");
  writeFileSync(join(dirs.dirty, "scratch.txt"), "x\n", "utf8");
  dirs.open = mk("l-open");
  commit(dirs.open, "open.txt");
  dirs.running = mk("l-running", { pid: process.pid, state: "running", started: nowStamp() });
  commit(dirs.running, "running.txt");

  // the deleted-branch tree has no status: a detached tree in the worktrees dir
  dirs.gone = join(worktreesDir(logDir), "l-gone");
  git(repo, ["worktree", "add", "-q", "-b", "tmp-gone", dirs.gone]);
  commit(dirs.gone, "gone.txt");
  git(dirs.gone, ["checkout", "-q", "--detach"]);
  git(repo, ["branch", "-D", "tmp-gone"]);

  // land: fast-forward (hash), then cherry-pick on a moved main (patch)
  git(repo, ["merge", "-q", "--ff-only", "worker/l-hash"]);
  commit(repo, "moved.txt");
  for (const b of ["worker/l-patch", "worker/l-dirty", "worker/l-running"]) git(repo, ["cherry-pick", b]);
  git(repo, ["cherry-pick", git(dirs.gone, ["rev-parse", "HEAD"])]);
});

describe("gcWorktrees landed", () => {
  it("dry-run lists each tree with reclaim or the keep reason, removes nothing", () => {
    const res = gcWorktrees(logDir, 24, true, Date.now(), true);
    const by = (id: string) => res.find((r) => r.id === id);
    for (const id of ["l-hash", "l-patch", "l-gone"]) expect(by(id)?.archive).toBe(`refs/pai-archive/${id}`);
    expect(by("l-dirty")?.skipped).toBe("kept: uncommitted changes");
    expect(by("l-open")?.skipped).toBe("kept: commits not on main");
    expect(by("l-running")?.skipped).toBe("worker is running");
    expect(Object.values(dirs).every((d) => existsSync(d))).toBe(true);
  });

  it("reclaims hash-landed, patch-landed and deleted-branch trees, keeps the rest", () => {
    const res = gcWorktrees(logDir, 24, false, Date.now(), true);
    expect(res.filter((r) => r.archive).map((r) => r.id).sort()).toEqual(["l-gone", "l-hash", "l-patch"]);
    for (const k of ["hash", "patch", "gone"]) expect(existsSync(dirs[k]!)).toBe(false);
    for (const k of ["dirty", "open", "running"]) expect(existsSync(dirs[k]!)).toBe(true);
    const refs = git(repo, ["for-each-ref", "--format=%(refname)"]);
    expect(refs).toContain("refs/pai-archive/l-patch");
    expect(refs).not.toContain("refs/heads/worker/l-patch");
    expect(refs).toContain("refs/heads/worker/l-open");
    expect(refs).toContain("refs/heads/worker/l-dirty");
  });
});
