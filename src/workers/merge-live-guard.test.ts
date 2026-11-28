import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadStatus, saveStatus, type WorkerStatus } from "./status.js";
import { addWorktree, assertWorkerEnded, mergeWorker, ownedTree, recordWorktree, worktreePath, WorkerRunningError } from "./worktree.js";
import { asMergeReverted, MergeRevertedError, mergeExitCode } from "./merge-reverted.js";

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

/** Every temp dir a test makes; removed after each test so nothing leaks into TMPDIR. */
const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

/** One repo + logDir pair per test (the in-process status cache keys on path). */
function fixture(): { repo: string; logDir: string } {
  const base = mkdtempSync(join(tmpdir(), "merge-live-"));
  tmpDirs.push(base);
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
  it("a live worker is refused and its worktree untouched", async () => {
    const { repo, logDir } = fixture();
    const id = "live-refuse";
    makeWorker(repo, logDir, id);
    saveStatus(logDir, { ...loadStatus(logDir, id)!, state: "running", pid: LIVE_PID, procStart: Date.now() - 5000 });
    let err: unknown;
    try {
      await mergeWorker(logDir, id, { verifyTests: false, rebuild: false, cliRoot: null });
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

  it("--force merges a live worker and keeps its worktree and branch", async () => {
    const { repo, logDir } = fixture();
    const id = "live-force";
    makeWorker(repo, logDir, id);
    saveStatus(logDir, { ...loadStatus(logDir, id)!, state: "running", pid: LIVE_PID, procStart: Date.now() - 5000 });
    // --force without an explicit verify must not run the configured merge.verify gate either way
    const out = await mergeWorker(logDir, id, { verifyTests: false, rebuild: false, cliRoot: null, force: true });
    expect(out).toContain(`merged worker/${id}`);
    expect(out).toContain("worker still running");
    expect(git(repo, ["rev-list", "--count", "HEAD"])).toBe("3"); // the merge commit landed
    expect(existsSync(worktreePath(logDir, id))).toBe(true); // worktree kept
    expect(git(repo, ["rev-parse", "--verify", "-q", `refs/heads/worker/${id}`])).toBeTruthy(); // branch kept
    const st = loadStatus(logDir, id)!;
    expect(st.merged).toBe(true);
    expect(ownedTree(st)).not.toBeNull(); // still owns the tree: gc reclaims it once it ends
  });

  it("an ended worker merges as before: worktree removed, branch deleted", async () => {
    const { repo, logDir } = fixture();
    const id = "ended";
    makeWorker(repo, logDir, id); // state done, pid owned by nothing
    expect(assertWorkerEnded(logDir, id)).toBeNull();
    const out = await mergeWorker(logDir, id, { verifyTests: false, rebuild: false, cliRoot: null });
    expect(out).toContain(`merged worker/${id}`);
    expect(out).toContain("worktree removed");
    expect(git(repo, ["rev-list", "--count", "HEAD"])).toBe("3");
    expect(existsSync(worktreePath(logDir, id))).toBe(false);
    expect(() => git(repo, ["rev-parse", "--verify", "-q", `refs/heads/worker/${id}`])).toThrow();
    expect(loadStatus(logDir, id)?.merged).toBe(true);
  });

  it("a running status whose pid belongs to no process is not refused (a dead runner never blocks a merge)", async () => {
    const { repo, logDir } = fixture();
    const id = "dead-pid";
    makeWorker(repo, logDir, id);
    saveStatus(logDir, { ...loadStatus(logDir, id)!, state: "running", pid: DEAD_PID });
    expect(() => assertWorkerEnded(logDir, id)).not.toThrow();
  });
});

describe("merge gate traps", () => {
  it("regenerates docs/commands when a branch changes a command definition without them", async () => {
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
    await mergeWorker(logDir, "docs-drift", { verifyTests: false, rebuild: false, cliRoot: null });
    expect(readFileSync(join(repo, "docs", "commands", "x.md"), "utf8")).toBe("doc of v2\n");
    expect(git(repo, ["status", "--porcelain"])).toBe("");
    expect(git(repo, ["log", "-1", "--format=%B"])).toContain("docs: regenerate command docs");
  });

  it("a failed gate then a fix on a resume branch lands the whole original change", async () => {
    const { repo, logDir } = fixture();
    makeWorker(repo, logDir, "first", { file: "first.txt" });
    await expect(mergeWorker(logDir, "first", { verifyTests: false, rebuild: false, cliRoot: null, verify: "exit 1" })).rejects.toThrow(/verify failed/);
    expect(existsSync(join(repo, "first.txt"))).toBe(false); // reverted on main
    // resume: a new worker branch on top of the kept one
    makeWorker(repo, logDir, "second", { from: "worker/first", file: "second.txt" });
    await mergeWorker(logDir, "second", { verifyTests: false, rebuild: false, cliRoot: null });
    expect(existsSync(join(repo, "first.txt"))).toBe(true);
    expect(existsSync(join(repo, "second.txt"))).toBe(true);
    expect(git(repo, ["log", "--format=%s"])).toContain("fix: reapply first (first) after a failed merge gate");
  });

  /** first merged then reverted by a failed gate; returns the revert commit */
  async function revertedFirst(repo: string, logDir: string): Promise<string> {
    makeWorker(repo, logDir, "first", { file: "first.txt" });
    await expect(mergeWorker(logDir, "first", { verifyTests: false, rebuild: false, cliRoot: null, verify: "exit 1" })).rejects.toThrow(/verify failed/);    return git(repo, ["rev-parse", "HEAD"]);
  }

  it("a branch forked after the revert merges normally, with no reapply", async () => {
    const { repo, logDir } = fixture();
    await revertedFirst(repo, logDir);
    makeWorker(repo, logDir, "later", { file: "later.txt" });
    await mergeWorker(logDir, "later", { verifyTests: false, rebuild: false, cliRoot: null });
    expect(existsSync(join(repo, "later.txt"))).toBe(true);
    expect(existsSync(join(repo, "first.txt"))).toBe(false);
    expect(git(repo, ["log", "--format=%s"])).not.toContain("reapply");
  });

  it("main that already reapplied by hand (amended subject, no revert line) gets no second reapply", async () => {
    const { repo, logDir } = fixture();
    const r = await revertedFirst(repo, logDir);
    makeWorker(repo, logDir, "second", { from: "worker/first", file: "second.txt" });
    git(repo, ["revert", "--no-edit", r]);
    git(repo, ["commit", "--amend", "-qm", "fix: reapply first by hand"]);
    const before = git(repo, ["rev-list", "--count", "HEAD"]);
    await mergeWorker(logDir, "second", { verifyTests: false, rebuild: false, cliRoot: null });
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

  it("a new dependency present in the worktree is cloned into main and npm is not run", async () => {
    const { repo, logDir, calls } = depFixture(true);
    await mergeWorker(logDir, "adds-dep", { verifyTests: false, rebuild: false, cliRoot: null, install: (_c, n) => void calls.push(n) });
    expect(JSON.parse(readFileSync(join(repo, "node_modules", "foo", "package.json"), "utf8")).version).toBe("1.0.0");
    expect(calls).toEqual([]);
  });

  it("a dependency the worktree lacks goes through the (mocked) low-priority install", async () => {
    const { repo, logDir, calls } = depFixture(false);
    await mergeWorker(logDir, "adds-dep", { verifyTests: false, rebuild: false, cliRoot: null, install: (_c, n) => void calls.push(n) });
    expect(existsSync(join(repo, "node_modules", "foo"))).toBe(false);
    expect(calls).toEqual([1]);
  });
});

describe("merge of an escalated continuation", () => {
  it("keeps its worktree until the merge completes, then removes both trees and reaches the build step", async () => {
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
    const out = await mergeWorker(logDir, "cont", {
      verifyTests: false,
      cliRoot: repo,
      build: () => ((built += 1), { ok: true, ms: 1, tail: "" }),
      restartVerify: () => ({ restarted: true, forced: false, detail: "t" }),
      // the gate is proven in .pai-scratch/restart-health.probe.test.ts; here nothing real may be health-checked or restarted
      restartGate: async () => null,
    });
    expect(built).toBe(1);
    expect(out).toContain("build: ok");
    expect(readFileSync(seen, "utf8")).toContain("merge in progress");
    expect(existsSync(worktreePath(logDir, "cont"))).toBe(false);
    // the origin branch is fully contained in main: its tree goes on its own merge, not before
    expect(existsSync(join(repo, "origin.txt"))).toBe(true);
  });

  it("a worktree already reclaimed does not fail a merge that landed", async () => {
    const { repo, logDir } = fixture();
    makeWorker(repo, logDir, "gone");
    const hook = join(repo, ".git", "hooks", "post-merge");
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, `#!/bin/sh\nrm -rf "${worktreePath(logDir, "gone")}"\nexit 0\n`);
    chmodSync(hook, 0o755);
    const out = await mergeWorker(logDir, "gone", { verifyTests: false, rebuild: false, cliRoot: null });
    expect(out).toContain("merged worker/gone");
    expect(git(repo, ["log", "--format=%s", "-1"])).toContain("merge worker gone");
  });
});

describe("restart health gate after a merge", () => {
  const base = (): { repo: string; logDir: string } => {
    const f = fixture();
    makeWorker(f.repo, f.logDir, "hc", { file: "hc.txt" });
    return f;
  };
  const opts = { verifyTests: false, build: () => ({ ok: true, ms: 1, tail: "" }), restartVerify: () => ({ restarted: true, forced: false, detail: "t" }) };

  // the rollback is a reverted gate: it throws MergeRevertedError (exit ≠ 0, MERGE REVERTED last), never returns ok text
  it("a failing health check reverts the merge and writes the rollback ledger line", async () => {
    const { repo, logDir } = base();
    const reverted: string[] = [];
    const e = await mergeWorker(logDir, "hc", {
      ...opts,
      cliRoot: repo,
      restartGate: async () => ({ ok: false, rolledBack: true, failures: ["router down"], line: "restart failed health check: router down; rolled back to 1.0.0" }),
      revertMergeCommits: (_cwd: string, oldHead: string) => (reverted.push(oldHead), "reverted"),
    }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MergeRevertedError);
    expect((e as Error).message).toContain("restart failed health check: router down; rolled back to 1.0.0");
    expect(reverted).toHaveLength(1);
    expect(readFileSync(join(logDir, "ledger.log"), "utf8")).toContain("WORKER-MERGE-RESTART-ROLLBACK");
  });

  it("a passing health check does not roll back or revert", async () => {
    const { repo, logDir } = base();
    let reverted = 0;
    const out = await mergeWorker(logDir, "hc", {
      ...opts,
      cliRoot: repo,
      restartGate: async () => ({ ok: true, line: "restart health: ok" }),
      revertMergeCommits: () => ((reverted += 1), "reverted"),
    });
    expect(out).toContain("restart health: ok");
    expect(reverted).toBe(0);
  });
});

describe("smoke start after a merge build", () => {
  const f = (): { repo: string; logDir: string } => {
    const x = fixture();
    makeWorker(x.repo, x.logDir, "sm", { file: "sm.txt" });
    return x;
  };
  // every step logs its name: the smoke start must run after the build and BEFORE anything restarts the daemon
  const rig = (smoke: () => Promise<{ ok: boolean; ms: number; error?: string }>) => {
    const events: string[] = [];
    return {
      events,
      opts: {
        verifyTests: false,
        build: () => (events.push("build"), { ok: true, ms: 1, tail: "" }),
        restartVerify: () => (events.push("restartVerify"), { restarted: true, forced: false, detail: "t" }),
        restartGate: async () => (events.push("restartGate"), { ok: true, line: "restart health: ok" }),
        smoke: async () => (events.push("smoke"), smoke()),
        revertMergeCommits: () => (events.push("revert"), "reverted"),
      },
    };
  };

  it("a smoke start that throws reverts and rebuilds BEFORE the daemon restart check", async () => {
    const { repo, logDir } = f();
    const r = rig(async () => {
      throw new Error("Cannot access 'toolFold' before initialization\n    at foo");
    });
    // a failed smoke reverts the merge: the gate throws (exit ≠ 0, MERGE REVERTED last), never returns ok text;
    // dist is rebuilt from the old tree and NOTHING restarts after — main runs the old code again
    const e = await mergeWorker(logDir, "sm", { ...r.opts, cliRoot: repo }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MergeRevertedError);
    expect((e as Error).message).toContain("smoke start failed: Cannot access 'toolFold' before initialization");
    expect((e as Error).message).not.toContain("at foo");
    expect(r.events).toEqual(["build", "smoke", "revert", "build"]);
  });

  it("a smoke start that exits non-zero reverts the merge", async () => {
    const { repo, logDir } = f();
    const r = rig(async () => ({ ok: false, ms: 5, error: "worker run exited 1" }));
    const e = await mergeWorker(logDir, "sm", { ...r.opts, cliRoot: repo }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MergeRevertedError);
    expect((e as Error).message).toContain("smoke start failed: worker run exited 1");
    // the revert follows the smoke failure and nothing restarts after it (the gate stopped at the revert)
    expect(r.events.indexOf("revert")).toBeGreaterThan(r.events.indexOf("smoke"));
    expect(r.events).not.toContain("restartVerify");
  });

  it("an ok smoke start keeps the merge and the restart follows it", async () => {
    const { repo, logDir } = f();
    const r = rig(async () => ({ ok: true, ms: 1200 }));
    const out = await mergeWorker(logDir, "sm", { ...r.opts, cliRoot: repo });
    expect(out).toContain("smoke start: ok (1.2 s)");
    expect(r.events).toEqual(["build", "smoke", "restartVerify", "restartGate"]);
  });

  // merge 2026-11-19 14:31: the smoke failed, the merge reverted — and the command still exited 0 printing
  // "build: ok … restart health: ok" after the failure line. A reverted gate exits non-zero and says so LAST.
  it("a reverted smoke gate throws MergeRevertedError whose last line is MERGE REVERTED", async () => {
    const { repo, logDir } = f();
    const r = rig(async () => ({ ok: false, ms: 5, error: "worker did not start within 30s" }));
    const e = await mergeWorker(logDir, "sm", { ...r.opts, cliRoot: repo }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MergeRevertedError);
    expect(mergeExitCode(e)).toBe(MergeRevertedError.EXIT_CODE); // ≠ 0; the CLI exits 4
    const lines = (e as Error).message.split("\n");
    expect(lines.at(-1)).toMatch(/^MERGE REVERTED: /); // the revert is the LAST line, never followed by ok-looking text
    expect((e as Error).message).toContain("smoke start failed: worker did not start within 30s");
    expect(r.events.indexOf("revert")).toBeGreaterThan(r.events.indexOf("smoke"));
  });

  it("a smoke failure whose revert itself failed still reads as a reverted merge", async () => {
    const { repo, logDir } = f();
    const r = rig(async () => ({ ok: false, ms: 5, error: "worker run exited 1" }));
    r.opts.revertMergeCommits = () => {
      throw new Error("git revert refused");
    };
    const e = await mergeWorker(logDir, "sm", { ...r.opts, cliRoot: repo }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MergeRevertedError);
    expect((e as Error).message).toContain("WARNING: the revert failed");
    expect((e as Error).message.split("\n").at(-1)).toMatch(/^MERGE REVERTED: /);
  });
});

describe("a reverted merge gate exits non-zero with MERGE REVERTED last", () => {
  const g = (): { repo: string; logDir: string } => {
    const x = fixture();
    makeWorker(x.repo, x.logDir, "rg", { file: "rg.txt" });
    return x;
  };

  it("a restart-health rollback throws MergeRevertedError, revert line last, exit ≠ 0", async () => {
    const { repo, logDir } = g();
    let reverted = 0;
    const e = await mergeWorker(logDir, "rg", {
      verifyTests: false,
      cliRoot: repo,
      build: () => ({ ok: true, ms: 1, tail: "" }),
      restartVerify: () => ({ restarted: true, forced: false, detail: "t" }),
      restartGate: async () => ({ ok: false, rolledBack: true, failures: ["router down"], line: "restart failed health check: router down; rolled back to 1.0.0" }),
      revertMergeCommits: () => ((reverted += 1), "reverted"),
    }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MergeRevertedError);
    expect(mergeExitCode(e)).not.toBe(0);
    const lines = (e as Error).message.split("\n");
    expect(lines.at(-1)).toMatch(/^MERGE REVERTED: restart failed health check/);
    expect(reverted).toBe(1);
  });

  it("a rolled-back gate whose git revert failed is NOT a reverted merge (main still has the change)", async () => {
    const { repo, logDir } = g();
    const out = await mergeWorker(logDir, "rg", {
      verifyTests: false,
      cliRoot: repo,
      build: () => ({ ok: true, ms: 1, tail: "" }),
      restartVerify: () => ({ restarted: true, forced: false, detail: "t" }),
      restartGate: async () => ({ ok: false, rolledBack: true, failures: ["router down"], line: "restart failed health check: router down; rolled back to 1.0.0" }),
      revertMergeCommits: () => {
        throw new Error("git revert refused");
      },
    });
    expect(out).toContain("WARNING: the rollback's git revert failed");
    expect(out).not.toContain("MERGE REVERTED"); // main still carries the merge: this is not a reverted merge
  });

  it("a failed verify gate reverts and exits non-zero with MERGE REVERTED last", async () => {
    const { repo, logDir } = g();
    const e = await mergeWorker(logDir, "rg", { verifyTests: false, cliRoot: null, verify: "exit 1" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MergeRevertedError);
    expect(mergeExitCode(e)).not.toBe(0);
    const lines = (e as Error).message.split("\n");
    expect(lines.at(-1)).toMatch(/^MERGE REVERTED: verify failed/);
  });

  it("a verify run that times out un-lands the merge without a revert commit and is no MERGE REVERTED", async () => {
    const { repo, logDir } = g();
    const before = git(repo, ["rev-parse", "HEAD"]);
    const merge = { generated: [], regenerate: "", union: [], verify: "sleep 20", verifyTimeoutSec: 1 };
    const e = (await mergeWorker(logDir, "rg", { cliRoot: null, merge }).catch((x: unknown) => x)) as Error;
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(MergeRevertedError);
    expect(e.message).toContain("verify timed out after 1s");
    expect(e.message).toContain("merge un-landed");
    expect(asMergeReverted(e)).toBeNull();
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(before);
    expect(git(repo, ["log", "--format=%s", "-5"])).not.toMatch(/^Revert/m);
  }, 60_000);

  it("a merge that stands ends with ok-looking lines and no MERGE REVERTED", async () => {
    const { repo, logDir } = g();
    const out = await mergeWorker(logDir, "rg", { verifyTests: false, cliRoot: null });
    expect(out).toContain("merged worker/rg");
    expect(out).not.toContain("MERGE REVERTED");
  });

  it("a related-tests revert classifies as a reverted merge; the keep-on-fail path stays exit 3", async () => {
    // the gate's own revert line ("…: reverted <sha>; branch kept…") is a reverted merge, exit ≠ 0;
    // the keep-on-fail path keeps the merge on main and throws RelatedTestsFailedError without that line: exit 3, no revert text
    const prev = process.env.PAI_MERGE_KEEP_ON_FAIL;
    process.env.PAI_MERGE_KEEP_ON_FAIL = "1";
    try {
      expect(asMergeReverted(new Error("related tests failed: x.test.ts: reverted deadbeef; branch kept"))).toBeInstanceOf(MergeRevertedError);
      expect(mergeExitCode(asMergeReverted(new Error("related tests failed: reverted deadbeef; branch kept")))).not.toBe(0);
      const msg = "merged worker/rg\nrelated tests failed: x.test.ts — merge kept, fix forward";
      expect(asMergeReverted(new Error(msg))).toBeNull(); // no revert happened: not a reverted merge
      expect(mergeExitCode(Object.assign(new Error(msg), { name: "RelatedTestsFailedError" }))).toBe(3);
    } finally {
      if (prev === undefined) delete process.env.PAI_MERGE_KEEP_ON_FAIL;
      else process.env.PAI_MERGE_KEEP_ON_FAIL = prev;
    }
  });
});

describe("merge targets the checkout the worker started in", () => {
  /** A worker started in a user's linked worktree of `repo`, recorded the way a real start leaves it. */
  function startInLinked(repo: string, logDir: string, id: string): { linked: string } {
    const linked = join(dirname(repo), "linked");
    git(repo, ["worktree", "add", "-q", "-b", "port/x", linked]);
    const info = addWorktree(logDir, id, linked);
    writeFileSync(join(info.dir, "w.txt"), "worker work\n");
    git(info.dir, ["add", "-A"]);
    git(info.dir, ["commit", "-qm", "worker commit"]);
    const st: WorkerStatus = {
      id, pid: DEAD_PID, label: id, cwd: linked, term: "", provider: "p", model: "m", state: "done",
      started: "2026-11-17 00:00:00", updated: "2026-11-17 00:00:00", turns: 1, tools: 0, last: "", rc: 0, secs: 1,
    };
    recordWorktree(logDir, st, info, true);
    return { linked };
  }

  it("a worker started in a linked worktree merges into it, not the main checkout", async () => {
    const { repo, logDir } = fixture();
    const { linked } = startInLinked(repo, logDir, "linked-ok");
    expect(loadStatus(logDir, "linked-ok")?.cwd).toBe(linked);
    await mergeWorker(logDir, "linked-ok", { verifyTests: false, rebuild: false, cliRoot: null });
    expect(existsSync(join(linked, "w.txt"))).toBe(true);
    expect(existsSync(join(repo, "w.txt"))).toBe(false);
    expect(git(repo, ["rev-list", "--count", "HEAD"])).toBe("1");
  });

  it("refuses when the start checkout has another branch checked out now", async () => {
    const { repo, logDir } = fixture();
    const { linked } = startInLinked(repo, logDir, "linked-moved");
    git(linked, ["checkout", "-q", "-b", "other"]);
    await expect(mergeWorker(logDir, "linked-moved", { verifyTests: false, rebuild: false, cliRoot: null })).rejects.toThrow(
      /had branch port\/x when the worker started but has other now/
    );
    expect(existsSync(join(linked, "w.txt"))).toBe(false);
  });

  it("a worker started in a subdirectory merges into the repo toplevel", async () => {
    const { repo, logDir } = fixture();
    mkdirSync(join(repo, "sub", "dir"), { recursive: true });
    writeFileSync(join(repo, "sub", "dir", "k.txt"), "k\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "sub"]);
    const sub = join(repo, "sub", "dir");
    const info = addWorktree(logDir, "sub-ok", sub);
    writeFileSync(join(info.dir, "w.txt"), "worker work\n");
    git(info.dir, ["add", "-A"]);
    git(info.dir, ["commit", "-qm", "worker commit"]);
    const st: WorkerStatus = {
      id: "sub-ok", pid: DEAD_PID, label: "sub-ok", cwd: sub, term: "", provider: "p", model: "m", state: "done",
      started: "2026-11-17 00:00:00", updated: "2026-11-17 00:00:00", turns: 1, tools: 0, last: "", rc: 0, secs: 1,
    };
    recordWorktree(logDir, st, info, true);
    expect(loadStatus(logDir, "sub-ok")?.cwd).toBe(realpathSync(repo));
    await mergeWorker(logDir, "sub-ok", { verifyTests: false, rebuild: false, cliRoot: null });
    expect(existsSync(join(repo, "w.txt"))).toBe(true);
  });
});

/** A worker started from a dirty checkout, recorded the way addWorktree leaves it: base is a snapshot commit. */
function makeSnapshotWorker(
  repo: string,
  logDir: string,
  id: string,
  ownCommits: { subject: string; body?: string }[]
): void {
  const dir = worktreePath(logDir, id);
  mkdirSync(dirname(dir), { recursive: true });
  // the merge salvages from the worktree dir itself: it must be a real repo checkout
  // the snapshot commit and the worker's own commits live in a throwaway repo
  // (the merge only reads them from `repo` via fetch; their content is irrelevant to the message)
  const snapRepo = mkdtempSync(join(tmpdir(), "snap-src-"));
  tmpDirs.push(snapRepo);
  git(snapRepo, ["init", "-q", "-b", "main"]);
  git(snapRepo, ["config", "user.email", "t@t"]);
  git(snapRepo, ["config", "user.name", "t"]);
  // the snapshot's content must match the checkout's HEAD: a snapshot merge
  // refuses when the checkout drifted in paths the branch touches
  writeFileSync(join(snapRepo, "f.txt"), "base\n");
  git(snapRepo, ["add", "-A"]);
  git(snapRepo, ["commit", "-qm", `worker ${id}: snapshot of uncommitted checkout`]);
  const snapshot = git(snapRepo, ["rev-parse", "HEAD"]);
  // the worker's own commits on top of the snapshot, in order
  for (const c of ownCommits) {
    writeFileSync(join(snapRepo, `${c.subject.replace(/[^a-z0-9]/gi, "-")}.txt`), c.subject + "\n");
    git(snapRepo, ["add", "-A"]);
    git(snapRepo, ["commit", "-qm", c.body ? `${c.subject}\n\n${c.body}` : c.subject]);
  }
  const branch = `worker/${id}`;
  // graft the snapshot + own commits into `repo` so the merge's diff can read them
  git(repo, ["fetch", "-q", snapRepo, `HEAD:${branch}`]);
  git(repo, ["worktree", "add", "-q", "--detach", dir, git(snapRepo, ["rev-parse", "HEAD"])]);
  const st: WorkerStatus = {
    id, pid: DEAD_PID, label: id, cwd: repo, term: "", provider: "p", model: "m", state: "done",
    started: "2026-11-17 00:00:00", updated: "2026-11-17 00:00:00", turns: 1, tools: 0, last: "", rc: 0, secs: 1,
    branch, worktreeDir: dir, worktreeBase: snapshot, worktreeSnapshot: true, commits: ownCommits.length,
  };
  saveStatus(logDir, st);
}

describe("snapshot merge keeps the worker's commit message", () => {
  it("one own commit lands as its subject plus the Worker trailer", async () => {
    const { repo, logDir } = fixture();
    makeSnapshotWorker(repo, logDir, "snap-one", [{ subject: "fix: IPC retries only read-only calls after an accepted request is dropped" }]);
    await mergeWorker(logDir, "snap-one", { verifyTests: false, rebuild: false, cliRoot: null });
    const msg = git(repo, ["log", "-1", "--format=%B"]);
    expect(msg).toContain("fix: IPC retries only read-only calls after an accepted request is dropped");
    expect(msg).toContain(`Worker: snap-one`);
    expect(msg).not.toContain("wip: uncommitted changes");
  });

  it("several own commits land as the first subject with the rest as bullets", async () => {
    const { repo, logDir } = fixture();
    makeSnapshotWorker(repo, logDir, "snap-two", [
      { subject: "fix: pace marker is one red tick on the ring" },
      { subject: "fix: IPC retries only read-only calls after an accepted request is dropped" },
    ]);
    await mergeWorker(logDir, "snap-two", { verifyTests: false, rebuild: false, cliRoot: null });
    const msg = git(repo, ["log", "-1", "--format=%B"]);
    expect(msg.split("\n")[0]).toBe("fix: pace marker is one red tick on the ring");
    expect(msg).toContain("- fix: IPC retries only read-only calls after an accepted request is dropped");
    expect(msg).toContain(`Worker: snap-two`);
    expect(msg).not.toContain("wip: uncommitted changes");
  });

  it("a pure-salvage branch (no own commits) falls back to the wip text", async () => {
    const { repo, logDir } = fixture();
    makeSnapshotWorker(repo, logDir, "snap-none", []);
    // only a salvage commit sits on top of the snapshot: no own work to keep
    const dir = worktreePath(logDir, "snap-none");
    // the salvage carries a real edit (its content differs from HEAD): only then does the merge commit anything
    writeFileSync(join(dir, "salvaged.txt"), "only salvage\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "salvaged: snap-none"]);
    // the branch tip is now snapshot + salvaged; no own commits remain
    git(repo, ["update-ref", "refs/heads/worker/snap-none", git(dir, ["rev-parse", "HEAD"])]);
    await mergeWorker(logDir, "snap-none", { verifyTests: false, rebuild: false, cliRoot: null });
    expect(git(repo, ["log", "-1", "--format=%s"])).toBe(`wip: uncommitted changes of snap-none at merge`);
  }, 30000);

  it("a snapshot commit's own subject is never kept as the merge title", async () => {
    const { repo, logDir } = fixture();
    makeSnapshotWorker(repo, logDir, "snap-subj", [{ subject: "feat: ring shows the pace marker" }]);
    await mergeWorker(logDir, "snap-subj", { verifyTests: false, rebuild: false, cliRoot: null });
    const msg = git(repo, ["log", "-1", "--format=%B"]);
    expect(msg).toContain("feat: ring shows the pace marker");
    expect(msg).not.toContain("snapshot of uncommitted checkout");
  });
});

describe("addWorktree snapshot content", () => {
  it("skips untracked build output, carries tracked edits and small untracked sources", () => {
    const { repo, logDir } = fixture();
    writeFileSync(join(repo, "f.txt"), "edited\n");
    mkdirSync(join(repo, "ui", "ios", "ephemeral"), { recursive: true });
    writeFileSync(join(repo, "ui", "ios", "ephemeral", "junk.txt"), "x\n");
    mkdirSync(join(repo, "lib"), { recursive: true });
    writeFileSync(join(repo, "lib", "new.dart"), "src\n");
    const info = addWorktree(logDir, "snap-1", repo);
    expect(info.snapshot).toBe(true);
    expect(readFileSync(join(info.dir, "f.txt"), "utf8")).toBe("edited\n");
    expect(existsSync(join(info.dir, "lib", "new.dart"))).toBe(true);
    expect(existsSync(join(info.dir, "ui", "ios", "ephemeral", "junk.txt"))).toBe(false);
    expect(info.snapshotOmitted?.join(";")).toContain("ui/ios/ephemeral/");
  });

  it("branches from HEAD when only build output is untracked", () => {
    const { repo, logDir } = fixture();
    mkdirSync(join(repo, "build"), { recursive: true });
    writeFileSync(join(repo, "build", "o.bin"), "x\n");
    const info = addWorktree(logDir, "snap-2", repo);
    expect(info.snapshot).toBe(false);
    expect(info.base).toBe(git(repo, ["rev-parse", "HEAD"]));
  });
});

describe("L2 stranded by a merged L1", () => {
  /** repo with an L1 and an L2 whose start branch is the L1's; the L1 is merged (branch deleted) when asked. */
  async function stranded(l1Merged: boolean): Promise<{ repo: string; logDir: string }> {
    const { repo, logDir } = fixture();
    makeWorker(repo, logDir, "l1", { file: "l1.txt" });
    makeWorker(repo, logDir, "l2", { file: "l2.txt", from: "worker/l1" });
    saveStatus(logDir, { ...loadStatus(logDir, "l2")!, parent: "l1", startBranch: "worker/l1" });
    if (l1Merged) {
      const out = await mergeWorker(logDir, "l1", { verifyTests: false, rebuild: false, cliRoot: null });
      expect(out).toContain("merged worker/l1");
    }
    return { repo, logDir };
  }
  const capture = () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => void lines.push(String(m)));
    return { lines, done: () => spy.mockRestore() };
  };

  it("retargets to the branch the L1 landed on and says so", async () => {
    const { repo, logDir } = await stranded(true);
    expect(() => git(repo, ["rev-parse", "--verify", "-q", "refs/heads/worker/l1"])).toThrow();
    const c = capture();
    try {
      expect(await mergeWorker(logDir, "l2", { verifyTests: false, rebuild: false, cliRoot: null })).toContain("merged worker/l2");
    } finally {
      c.done();
    }
    expect(c.lines.join("\n")).toContain("merging into main");
    expect(existsSync(join(repo, "l2.txt"))).toBe(true);
  });

  it("retargets when the L1 ended unmerged and its branch is gone", async () => {
    const { repo, logDir } = await stranded(false);
    git(repo, ["worktree", "remove", "--force", join(logDir, "worktrees", "l1")]);
    git(repo, ["branch", "-D", "worker/l1"]);
    const c = capture();
    try {
      expect(await mergeWorker(logDir, "l2", { verifyTests: false, rebuild: false, cliRoot: null })).toContain("merged worker/l2");
    } finally {
      c.done();
    }
    expect(c.lines.join("\n")).toContain("ended without merging and its branch is gone; merging into main");
  });

  it("an L1 whose only dirty entry is its deleted .pai-keep marker merges, is marked merged and its child retargets", async () => {
    const { repo, logDir } = fixture();
    makeWorker(repo, logDir, "l1", { file: "l1.txt", extra: { ".pai-keep": "kept\n" } });
    makeWorker(repo, logDir, "l2", { file: "l2.txt", from: "worker/l1" });
    saveStatus(logDir, { ...loadStatus(logDir, "l2")!, parent: "l1", startBranch: "worker/l1" });
    rmSync(join(worktreePath(logDir, "l1"), ".pai-keep"));
    expect(git(worktreePath(logDir, "l1"), ["status", "--porcelain"])).toMatch(/D \.pai-keep/);
    expect(await mergeWorker(logDir, "l1", { verifyTests: false, rebuild: false, cliRoot: null })).toContain("merged worker/l1");
    expect(loadStatus(logDir, "l1")?.merged).toBe(true);
    expect(() => git(repo, ["rev-parse", "--verify", "-q", "refs/heads/worker/l1"])).toThrow();
    expect(existsSync(worktreePath(logDir, "l1"))).toBe(false);
    const c = capture();
    try {
      expect(await mergeWorker(logDir, "l2", { verifyTests: false, rebuild: false, cliRoot: null })).toContain("merged worker/l2");
    } finally {
      c.done();
    }
    expect(c.lines.join("\n")).toContain("merging into main");
  });

  it("refuses while the recorded branch still exists", async () => {
    const { repo, logDir } = await stranded(false);
    git(repo, ["checkout", "-q", "-b", "other"]);
    await expect(mergeWorker(logDir, "l2", { verifyTests: false, rebuild: false, cliRoot: null })).rejects.toThrow(/wrong branch/);
  });

  it("refuses and names the L1 when it landed elsewhere", async () => {
    const { repo, logDir } = await stranded(true);
    git(repo, ["checkout", "-q", "-b", "elsewhere", "HEAD^1"]);
    await expect(mergeWorker(logDir, "l2", { verifyTests: false, rebuild: false, cliRoot: null })).rejects.toThrow(/merge worker l1/);
  });

  it("an L1 merged with an unmerged L2 lists the child", async () => {
    const { repo, logDir } = fixture();
    makeWorker(repo, logDir, "l1", { file: "l1.txt" });
    makeWorker(repo, logDir, "l2", { file: "l2.txt", from: "worker/l1" });
    saveStatus(logDir, { ...loadStatus(logDir, "l2")!, parent: "l1" });
    const c = capture();
    try {
      await mergeWorker(logDir, "l1", { verifyTests: false, rebuild: false, cliRoot: null });
    } finally {
      c.done();
    }
    expect(c.lines.join("\n")).toContain("1 children not merged: l2");
  });
});
