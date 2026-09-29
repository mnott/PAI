/**
 * verifyWorker and `merge --no-commit` against throwaway git repos in tmp dirs.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorktree, git, mergeWorker, recordWorktree, verifyWorker } from "./worktree.js";
import { saveStatus, type WorkerStatus } from "./status.js";

function setup(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `pai-verify-${name}-`));
  const repo = join(dir, "repo");
  const logDir = join(dir, "logdir");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "worker test"]);
  writeFileSync(join(repo, "a.txt"), "a\n");
  writeFileSync(join(repo, "gone.txt"), "gone\n");
  writeFileSync(join(repo, "c.txt"), "c\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return { dir, repo, logDir };
}

function worker(logDir: string, repo: string, id: string, edit: (wt: string) => void) {
  const info = addWorktree(logDir, id, repo);
  const st: WorkerStatus = {
    id, pid: process.pid, label: `label ${id}`, cwd: repo, term: "", provider: "p", model: "m",
    state: "done", started: "2026-09-17 10:00:00", updated: "2026-09-17 10:00:00",
    turns: 0, tools: 0, last: "", rc: 0, secs: 1,
  };
  saveStatus(logDir, st);
  edit(info.dir);
  git(info.dir, ["add", "-A"]);
  git(info.dir, ["commit", "-q", "-m", "work"]);
  recordWorktree(logDir, st, info, true);
  return info;
}

const edits = (wt: string) => {
  writeFileSync(join(wt, "a.txt"), "a changed\n");
  writeFileSync(join(wt, "new.txt"), "new\n");
  rmSync(join(wt, "gone.txt"));
};

describe("verifyWorker", () => {
  it("reports differs / missing / deleted, then identical once applied; exit-style ok flag", () => {
    const { repo, logDir } = setup("v");
    worker(logDir, repo, "v1", edits);
    let r = verifyWorker(logDir, "v1");
    expect(r.ok).toBe(false);
    expect(Object.fromEntries(r.files.map((f) => [f.path, f.state]))).toEqual({
      "a.txt": "differs",
      "new.txt": "missing",
      "gone.txt": "deleted",
    });
    writeFileSync(join(repo, "a.txt"), "a changed\n");
    writeFileSync(join(repo, "new.txt"), "new\n");
    r = verifyWorker(logDir, "v1");
    expect(r.files.find((f) => f.path === "a.txt")?.state).toBe("identical");
    expect(r.files.find((f) => f.path === "new.txt")?.state).toBe("identical");
    expect(r.ok).toBe(false); // gone.txt still present
    rmSync(join(repo, "gone.txt"));
    r = verifyWorker(logDir, "v1");
    expect(r.ok).toBe(true);
  });

  it("--against compares with a ref, not the working tree", () => {
    const { repo, logDir } = setup("ag");
    worker(logDir, repo, "ag1", edits);
    const r = verifyWorker(logDir, "ag1", { against: "worker/ag1" });
    expect(r.ok).toBe(true);
    expect(verifyWorker(logDir, "ag1", { against: "HEAD" }).ok).toBe(false);
  });

  it("falls back to refs/pai-archive/<id> when the branch is gone", () => {
    const { repo, logDir } = setup("ar");
    worker(logDir, repo, "ar1", edits);
    git(repo, ["update-ref", "refs/pai-archive/ar1", "worker/ar1"]);
    git(repo, ["worktree", "remove", "--force", join(logDir, "worktrees", "ar1")]);
    git(repo, ["branch", "-D", "worker/ar1"]);
    const r = verifyWorker(logDir, "ar1");
    expect(r.ref).toBe("refs/pai-archive/ar1");
    expect(r.files.length).toBe(3);
  });

  it("errors when neither branch nor archive exists", () => {
    const { repo, logDir } = setup("no");
    worker(logDir, repo, "no1", edits);
    git(repo, ["worktree", "remove", "--force", join(logDir, "worktrees", "no1")]);
    git(repo, ["branch", "-D", "worker/no1"]);
    expect(() => verifyWorker(logDir, "no1")).toThrow(/neither/);
  });
});

describe("mergeWorker --no-commit", () => {
  it("applies uncommitted, keeps branch and worktree, moves no HEAD", () => {
    const { repo, logDir } = setup("nc");
    const info = worker(logDir, repo, "nc1", edits);
    const head = git(repo, ["rev-parse", "HEAD"]);
    const msg = mergeWorker(logDir, "nc1", { noCommit: true });
    expect(msg).toMatch(/pai worker gc/);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("a changed\n");
    expect(readFileSync(join(repo, "new.txt"), "utf8")).toBe("new\n");
    expect(existsSync(join(repo, "gone.txt"))).toBe(false);
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(head);
    expect(git(repo, ["status", "--porcelain"])).not.toBe("");
    expect(existsSync(info.dir)).toBe(true);
    expect(git(repo, ["branch", "--list", "worker/nc1"])).not.toBe("");
    expect(verifyWorker(logDir, "nc1").ok).toBe(true);
  });

  it("stops on conflict, lists paths, leaves the tree", () => {
    const { repo, logDir } = setup("cf");
    const info = worker(logDir, repo, "cf1", (wt) => writeFileSync(join(wt, "c.txt"), "worker c\n"));
    // main moves on with a conflicting committed change
    writeFileSync(join(repo, "c.txt"), "main c\n");
    git(repo, ["commit", "-q", "-am", "main edit"]);
    expect(() => mergeWorker(logDir, "cf1", { noCommit: true })).toThrow(/conflicted in c\.txt/);
    expect(readFileSync(join(repo, "c.txt"), "utf8")).toMatch(/<<<<<<</);
    expect(existsSync(info.dir)).toBe(true);
    expect(git(repo, ["branch", "--list", "worker/cf1"])).not.toBe("");
  });

  it("default merge is unchanged: commits, removes worktree and branch", () => {
    const { repo, logDir } = setup("df");
    const info = worker(logDir, repo, "df1", edits);
    expect(mergeWorker(logDir, "df1")).toMatch(/^merged worker\/df1/);
    expect(existsSync(info.dir)).toBe(false);
    expect(git(repo, ["branch", "--list", "worker/df1"])).toBe("");
    expect(git(repo, ["status", "--porcelain"])).toBe("");
  });
});
