import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardWorker, gcWorktrees, git } from "./worktree.js";
import { poolStatePath, writePoolState } from "./pool.js";
import { saveStatus } from "./status.js";

const dir = mkdtempSync(join(tmpdir(), "pai-orphan-test-"));
const repo = join(dir, "repo");
const logDir = join(dir, "logdir");
mkdirSync(repo, { recursive: true });
mkdirSync(logDir, { recursive: true });
git(repo, ["init", "-q", "-b", "main"]);
git(repo, ["config", "user.email", "t@example.invalid"]);
git(repo, ["config", "user.name", "t"]);
writeFileSync(join(repo, "base.txt"), "base\n");
git(repo, ["add", "."]);
git(repo, ["commit", "-q", "-m", "init"]);

const has = (b: string) => git(repo, ["branch", "--list", b]) !== "";

function branchWithCommit(name: string): string {
  git(repo, ["checkout", "-q", "-b", name, "main"]);
  writeFileSync(join(repo, `${name.replace("/", "_")}.txt`), name);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", name]);
  const sha = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["checkout", "-q", "main"]);
  return sha;
}

describe("orphan branch gc", () => {
  it("dry-run lists, gc archives merged/archived branches and keeps unarchived ones", () => {
    git(repo, ["branch", "worker/merged", "main"]);
    const sha = branchWithCommit("worker/archived");
    git(repo, ["update-ref", "refs/pai-archive/old-one", sha]);
    branchWithCommit("worker/fresh");
    branchWithCommit("other/untouched");

    const dry = gcWorktrees(logDir, 0, true, Date.now(), false, undefined, repo).filter((e) => e.branch);
    expect(dry.map((e) => e.id).sort()).toEqual(["worker/archived", "worker/fresh", "worker/merged"]);
    expect(dry.find((e) => e.id === "worker/fresh")!.skipped).toBe("kept: unarchived commits");
    expect(dry.find((e) => e.id === "worker/merged")!.archive).toMatch(/^refs\/pai-archive\//);
    expect(has("worker/merged")).toBe(true);

    gcWorktrees(logDir, 0, false, Date.now(), false, undefined, repo);
    expect(has("worker/merged")).toBe(false);
    expect(has("worker/archived")).toBe(false);
    expect(has("worker/fresh")).toBe(true);
    expect(has("other/untouched")).toBe(true);
    expect(git(repo, ["rev-parse", "refs/pai-archive/old-one"])).toBe(sha);
  });

  it("never touches a spare branch of the live pool host", () => {
    git(repo, ["branch", "spare/live-1", "main"]);
    git(repo, ["branch", "spare/dead-1", "main"]);
    mkdirSync(join(logDir, "pool"), { recursive: true });
    writePoolState(
      {
        hostPid: process.pid, port: 1, startedAt: "", updatedAt: "", slots: [], tasksServed: 0, tokensCarried: 0,
        spares: [{ id: "live-1", repo, provider: "p", model: "m", dir: "/x", branch: "spare/live-1", base: "b", pid: 1, createdAt: "", state: "ready" }],
      },
      poolStatePath(logDir)
    );
    gcWorktrees(logDir, 0, false, Date.now(), false, undefined, repo);
    expect(has("spare/live-1")).toBe(true);
    expect(has("spare/dead-1")).toBe(false);
  });

  it("does not delete a branch checked out in a worktree", () => {
    const wt = join(dir, "wt");
    git(repo, ["worktree", "add", "-q", "-b", "worker/inuse", wt, "main"]);
    writeFileSync(join(wt, "u.txt"), "u");
    git(wt, ["add", "."]);
    git(wt, ["commit", "-q", "-m", "u"]);
    gcWorktrees(logDir, 0, false, Date.now(), false, undefined, repo);
    expect(has("worker/inuse")).toBe(true);
    expect(existsSync(wt)).toBe(true);
  });

  it("discard works with only the branch left", () => {
    const sha = branchWithCommit("worker/solo");
    saveStatus(logDir, {
      id: "solo", pid: 1, label: "x", cwd: repo, term: "", provider: "p", model: "m", state: "done", started: "", updated: "",
      turns: 0, tools: 0, last: "", rc: 0, secs: 1, branch: null, worktreeDir: null,
    });
    const msg = discardWorker(logDir, "solo");
    expect(msg).toMatch(/only branch worker\/solo was left/);
    expect(has("worker/solo")).toBe(false);
    expect(git(repo, ["rev-parse", "refs/pai-archive/solo"])).toBe(sha);
  });
});
