import { afterAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadStatus, saveStatus, type WorkerStatus } from "./status.js";
import { assertWorkerEnded, mergeWorker, ownedTree, worktreePath, WorkerRunningError } from "./worktree.js";

/** A sleep alive for the whole suite: its pid is the fake worker's live pid. */
const LIVE_PID = Number(spawnSync("/bin/sh", ["-c", "sleep 600 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" }).stdout.trim());
/** A pid no process holds (in macOS's range, so `ps` answers rather than erroring). */
const DEAD_PID = 99999;
afterAll(() => {
  try {
    process.kill(LIVE_PID, "SIGKILL");
  } catch {
    // already gone
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

/** One repo + logDir pair per test (the in-process status cache keys on path). */
function fixture(): { repo: string; logDir: string } {
  const base = mkdtempSync(join(tmpdir(), "merge-live-"));
  const repo = join(base, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t"]);
  git(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "f.txt"), "base\n");
  git(repo, ["add", "f.txt"]);
  git(repo, ["commit", "-qm", "base"]);
  const logDir = join(base, "logs");
  mkdirSync(logDir, { recursive: true });
  return { repo, logDir };
}

/** A worker with a committed branch and its worktree, written the way recordWorktree leaves it. */
function makeWorker(repo: string, logDir: string, id: string): void {
  const dir = worktreePath(logDir, id);
  const branch = `worker/${id}`;
  const base = git(repo, ["rev-parse", "HEAD"]);
  mkdirSync(join(logDir, "worktrees"), { recursive: true });
  git(repo, ["worktree", "add", "-q", "-B", branch, dir, base]);
  writeFileSync(join(dir, "w.txt"), "worker work\n");
  git(dir, ["add", "w.txt"]);
  git(dir, ["commit", "-qm", "worker commit"]);
  const st: WorkerStatus = {
    id,
    pid: DEAD_PID, // an ended worker: no process owns this pid
    label: id,
    cwd: repo,
    term: "",
    provider: "p",
    model: "m",
    state: "done",
    started: "2026-11-17 00:00:00",
    updated: "2026-11-17 00:00:00",
    turns: 1,
    tools: 0,
    last: "",
    rc: 0,
    secs: 1,
    branch,
    worktreeDir: dir,
    worktreeBase: base,
    commits: 1,
  };
  saveStatus(logDir, st);
}

describe("merge refuses a running worker", () => {
  it("a live worker is refused and its worktree untouched", () => {
    const { repo, logDir } = fixture();
    const id = "live-refuse";
    makeWorker(repo, logDir, id);
    saveStatus(logDir, { ...loadStatus(logDir, id)!, state: "running", pid: LIVE_PID, procStart: Date.now() - 5000 });
    let err: unknown;
    try {
      mergeWorker(logDir, id, { verifyTests: false, rebuild: false, cliRoot: null });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WorkerRunningError);
    const msg = (err as Error).message;
    expect(msg).toContain(`worker ${id} is still running (pid ${LIVE_PID})`);
    expect(msg).toContain("wait with `pai worker wait");
    expect(msg).toContain("--force merges anyway and leaves the worktree in place");
    // nothing happened: no merge commit, branch and worktree stand
    expect(git(repo, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(existsSync(worktreePath(logDir, id))).toBe(true);
    expect(loadStatus(logDir, id)?.merged).toBeUndefined();
  });

  it("--force merges a live worker and keeps its worktree and branch", () => {
    const { repo, logDir } = fixture();
    const id = "live-force";
    makeWorker(repo, logDir, id);
    saveStatus(logDir, { ...loadStatus(logDir, id)!, state: "running", pid: LIVE_PID, procStart: Date.now() - 5000 });
    // --force without an explicit verify must not run the configured merge.verify gate either way
    const out = mergeWorker(logDir, id, { verifyTests: false, rebuild: false, cliRoot: null, force: true });
    expect(out).toContain(`merged worker/${id}`);
    expect(out).toContain("worker still running");
    expect(git(repo, ["rev-list", "--count", "HEAD"])).toBe("3"); // the merge commit landed
    expect(existsSync(worktreePath(logDir, id))).toBe(true); // worktree kept
    expect(git(repo, ["rev-parse", "--verify", "-q", `refs/heads/worker/${id}`])).toBeTruthy(); // branch kept
    const st = loadStatus(logDir, id)!;
    expect(st.merged).toBe(true);
    expect(ownedTree(st)).not.toBeNull(); // still owns the tree: gc reclaims it once it ends
  });

  it("an ended worker merges as before: worktree removed, branch deleted", () => {
    const { repo, logDir } = fixture();
    const id = "ended";
    makeWorker(repo, logDir, id); // state done, pid owned by nothing
    expect(assertWorkerEnded(logDir, id)).toBeNull();
    const out = mergeWorker(logDir, id, { verifyTests: false, rebuild: false, cliRoot: null });
    expect(out).toContain(`merged worker/${id}`);
    expect(out).toContain("worktree removed");
    expect(git(repo, ["rev-list", "--count", "HEAD"])).toBe("3");
    expect(existsSync(worktreePath(logDir, id))).toBe(false);
    expect(() => git(repo, ["rev-parse", "--verify", "-q", `refs/heads/worker/${id}`])).toThrow();
    expect(loadStatus(logDir, id)?.merged).toBe(true);
  });

  it("a running status whose pid belongs to no process is not refused (a dead runner never blocks a merge)", () => {
    const { repo, logDir } = fixture();
    const id = "dead-pid";
    makeWorker(repo, logDir, id);
    saveStatus(logDir, { ...loadStatus(logDir, id)!, state: "running", pid: DEAD_PID });
    expect(() => assertWorkerEnded(logDir, id)).not.toThrow();
  });
});
