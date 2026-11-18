import { afterAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
function makeWorker(repo: string, logDir: string, id: string, o: { from?: string; file?: string; extra?: Record<string, string> } = {}): void {
  const dir = worktreePath(logDir, id);
  const branch = `worker/${id}`;
  const base = git(repo, ["rev-parse", o.from ?? "HEAD"]);
  mkdirSync(join(logDir, "worktrees"), { recursive: true });
  git(repo, ["worktree", "add", "-q", "-B", branch, dir, base]);
  for (const [f, c] of Object.entries({ [o.file ?? "w.txt"]: "worker work\n", ...o.extra })) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), c);
  }
  git(dir, ["add", "-A"]);
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

describe("merge gate traps", () => {
  it("regenerates docs/commands when a branch changes a command definition without them", () => {
    const { repo, logDir } = fixture();
    // the tree's own generator: docs/commands/x.md is a pure function of src/cli/def.txt
    writeFileSync(join(repo, "def.txt"), "v1\n");
    mkdirSync(join(repo, "scripts"));
    writeFileSync(
      join(repo, "scripts", "regen-docs.ts"),
      'const fs = require("node:fs"); fs.mkdirSync("docs/commands", { recursive: true }); fs.writeFileSync("docs/commands/x.md", "doc of " + fs.readFileSync("src/cli/def.txt", "utf8"));\n'
    );
    mkdirSync(join(repo, "src", "cli"), { recursive: true });
    writeFileSync(join(repo, "src", "cli", "def.txt"), "v1\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "defs"]);
    makeWorker(repo, logDir, "docs-drift", { file: "src/cli/def.txt", extra: { "src/cli/def.txt": "v2\n" } });
    mergeWorker(logDir, "docs-drift", { verifyTests: false, rebuild: false, cliRoot: null });
    expect(readFileSync(join(repo, "docs", "commands", "x.md"), "utf8")).toBe("doc of v2\n");
    expect(git(repo, ["status", "--porcelain"])).toBe("");
    expect(git(repo, ["log", "-1", "--format=%B"])).toContain("docs: regenerate command docs");
  });

  it("a failed gate then a fix on a resume branch lands the whole original change", () => {
    const { repo, logDir } = fixture();
    makeWorker(repo, logDir, "first", { file: "first.txt" });
    expect(() => mergeWorker(logDir, "first", { verifyTests: false, rebuild: false, cliRoot: null, verify: "exit 1" })).toThrow(/verify failed/);
    expect(existsSync(join(repo, "first.txt"))).toBe(false); // reverted on main
    // resume: a new worker branch on top of the kept one
    makeWorker(repo, logDir, "second", { from: "worker/first", file: "second.txt" });
    mergeWorker(logDir, "second", { verifyTests: false, rebuild: false, cliRoot: null });
    expect(existsSync(join(repo, "first.txt"))).toBe(true);
    expect(existsSync(join(repo, "second.txt"))).toBe(true);
    expect(git(repo, ["log", "--format=%s"])).toContain("fix: reapply first (first) after a failed merge gate");
  });

  /** first merged then reverted by a failed gate; returns the revert commit */
  function revertedFirst(repo: string, logDir: string): string {
    makeWorker(repo, logDir, "first", { file: "first.txt" });
    expect(() => mergeWorker(logDir, "first", { verifyTests: false, rebuild: false, cliRoot: null, verify: "exit 1" })).toThrow(/verify failed/);
    return git(repo, ["rev-parse", "HEAD"]);
  }

  it("a branch forked after the revert merges normally, with no reapply", () => {
    const { repo, logDir } = fixture();
    revertedFirst(repo, logDir);
    makeWorker(repo, logDir, "later", { file: "later.txt" });
    mergeWorker(logDir, "later", { verifyTests: false, rebuild: false, cliRoot: null });
    expect(existsSync(join(repo, "later.txt"))).toBe(true);
    expect(existsSync(join(repo, "first.txt"))).toBe(false);
    expect(git(repo, ["log", "--format=%s"])).not.toContain("reapply");
  });

  it("main that already reapplied by hand (amended subject, no revert line) gets no second reapply", () => {
    const { repo, logDir } = fixture();
    const r = revertedFirst(repo, logDir);
    makeWorker(repo, logDir, "second", { from: "worker/first", file: "second.txt" });
    git(repo, ["revert", "--no-edit", r]);
    git(repo, ["commit", "--amend", "-qm", "fix: reapply first by hand"]);
    const before = git(repo, ["rev-list", "--count", "HEAD"]);
    mergeWorker(logDir, "second", { verifyTests: false, rebuild: false, cliRoot: null });
    expect(git(repo, ["rev-list", "--count", "HEAD"])).toBe(String(Number(before) + 2)); // second's commit + merge only
    expect(git(repo, ["log", "--format=%s"]).split("\n").filter((l) => l.startsWith("fix: reapply first (first)"))).toHaveLength(0);
    expect(existsSync(join(repo, "first.txt"))).toBe(true);
  });
});

describe("merge gate dependencies", () => {
  const lock = (pkgs: Record<string, string>): string =>
    JSON.stringify({ lockfileVersion: 3, packages: { "": {}, ...Object.fromEntries(Object.entries(pkgs).map(([k, v]) => [`node_modules/${k}`, { version: v }])) } });
  const pkgJson = (v: string): string => JSON.stringify({ name: "x", version: v });

  function depFixture(inWorktree: boolean): { repo: string; logDir: string; calls: number[] } {
    const { repo, logDir } = fixture();
    writeFileSync(join(repo, ".gitignore"), "node_modules\n");
    writeFileSync(join(repo, "package-lock.json"), lock({}));
    mkdirSync(join(repo, "node_modules"));
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "lock"]);
    makeWorker(repo, logDir, "adds-dep", { extra: { "package-lock.json": lock({ foo: "1.0.0" }) } });
    if (inWorktree) {
      const d = join(worktreePath(logDir, "adds-dep"), "node_modules", "foo");
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "package.json"), pkgJson("1.0.0"));
    }
    return { repo, logDir, calls: [] };
  }

  it("a new dependency present in the worktree is cloned into main and npm is not run", () => {
    const { repo, logDir, calls } = depFixture(true);
    mergeWorker(logDir, "adds-dep", { verifyTests: false, rebuild: false, cliRoot: null, install: (_c, n) => void calls.push(n) });
    expect(JSON.parse(readFileSync(join(repo, "node_modules", "foo", "package.json"), "utf8")).version).toBe("1.0.0");
    expect(calls).toEqual([]);
  });

  it("a dependency the worktree lacks goes through the (mocked) low-priority install", () => {
    const { repo, logDir, calls } = depFixture(false);
    mergeWorker(logDir, "adds-dep", { verifyTests: false, rebuild: false, cliRoot: null, install: (_c, n) => void calls.push(n) });
    expect(existsSync(join(repo, "node_modules", "foo"))).toBe(false);
    expect(calls).toEqual([1]);
  });
});

describe("merge of an escalated continuation", () => {
  it("keeps its worktree until the merge completes, then removes both trees and reaches the build step", () => {
    const { repo, logDir } = fixture();
    makeWorker(repo, logDir, "origin", { file: "origin.txt" });
    makeWorker(repo, logDir, "cont", { from: "worker/origin", file: "cont.txt" });
    // a gc running right after the merge commit would find the branch landed: record what it would see
    const seen = join(logDir, "hook-saw-keep");
    const hook = join(repo, ".git", "hooks", "post-merge");
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, `#!/bin/sh\ncat "${worktreePath(logDir, "cont")}/.pai-keep" > "${seen}" 2>/dev/null\nexit 0\n`);
    chmodSync(hook, 0o755);
    let built = 0;
    const out = mergeWorker(logDir, "cont", {
      verifyTests: false,
      cliRoot: repo,
      build: () => ((built += 1), { ok: true, ms: 1, tail: "" }),
      restartVerify: () => ({ restarted: true, forced: false, detail: "t" }),
    });
    expect(built).toBe(1);
    expect(out).toContain("build: ok");
    expect(readFileSync(seen, "utf8")).toContain("merge in progress");
    expect(existsSync(worktreePath(logDir, "cont"))).toBe(false);
    // the origin branch is fully contained in main: its tree goes on its own merge, not before
    expect(existsSync(join(repo, "origin.txt"))).toBe(true);
  });

  it("a worktree already reclaimed does not fail a merge that landed", () => {
    const { repo, logDir } = fixture();
    makeWorker(repo, logDir, "gone");
    const hook = join(repo, ".git", "hooks", "post-merge");
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, `#!/bin/sh\nrm -rf "${worktreePath(logDir, "gone")}"\nexit 0\n`);
    chmodSync(hook, 0o755);
    const out = mergeWorker(logDir, "gone", { verifyTests: false, rebuild: false, cliRoot: null });
    expect(out).toContain("merged worker/gone");
    expect(git(repo, ["log", "--format=%s", "-1"])).toContain("merge worker gone");
  });
});
