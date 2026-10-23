import { afterAll, describe, it, expect } from "vitest";
import { existsSync, readdirSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { busyPid, gcPoolWorktrees, git, worktreesDir } from "./worktree.js";
import { saveStatus, type WorkerStatus } from "./status.js";
import { poolSettings, poolStatePath, writePoolState, type PoolState } from "./pool.js";
import { defaultWorkersConfig } from "./config.js";

const dir = mkdtempSync(join(tmpdir(), "pai-gcpool-test-"));
const repo = join(dir, "repo");
const logDir = join(dir, "logdir");
mkdirSync(repo, { recursive: true });
mkdirSync(worktreesDir(logDir), { recursive: true });
git(repo, ["init", "-q", "-b", "main"]);
git(repo, ["config", "user.email", "t@example.invalid"]);
git(repo, ["config", "user.name", "t"]);
writeFileSync(join(repo, "base.txt"), "base\n");
git(repo, ["add", "."]);
git(repo, ["commit", "-q", "-m", "init"]);

// a live process whose command reads like a pool host stands in for one;
// the pid reuse case reuses THIS test process's pid (a command ps reports as
// `node .../vitest` is alive but no pool host)
const host = spawn("sh", ["-c", "exec -a 'node dist/hooks/worker-pool-host.mjs --port 1' sleep 300"], { stdio: "ignore" });
afterAll(() => {
  try {
    host.kill();
  } catch {
    /* gone */
  }
});
const stateFor = (hostPid: number, spareId: string, dir: string): PoolState =>
  ({
    hostPid,
    port: 1,
    startedAt: "",
    updatedAt: "",
    slots: [],
    tasksServed: 0,
    tokensCarried: 0,
    spares: [{ id: spareId, repo, provider: "p", model: "m", dir, branch: `spare/${spareId}`, base: "x", pid: -1, createdAt: "", state: "ready" }],
  }) as PoolState;

describe("no reserve worktrees", () => {
  it("the shipped default keeps no spares, so nothing is created before a worker starts", async () => {
    await new Promise((r) => setTimeout(r, 300)); // the stand-in host's command is in place before any gc
    expect(poolSettings(defaultWorkersConfig()).spares).toBe(0);
    expect(existsSync(worktreesDir(logDir)) && readdirSync(worktreesDir(logDir))).toEqual([]);
  });

  it("gc --pool removes an idle spare and a detached slot, keeps one with a process inside", async () => {
    const spare = join(worktreesDir(logDir), "spare-1-1");
    git(repo, ["worktree", "add", spare, "-b", "spare/spare-1-1", "main"]);
    const slot = join(logDir, "slots", "local-1");
    mkdirSync(join(logDir, "slots"), { recursive: true });
    git(repo, ["worktree", "add", "--detach", slot, "main"]);
    // a spare of a live host is kept even with a process inside (a claim can come at any moment)
    const busy = join(worktreesDir(logDir), "spare-1-2");
    git(repo, ["worktree", "add", busy, "-b", "spare/spare-1-2", "main"]);
    // the test process itself is exempt from busyPid, so hold the cwd from a child
    const child = spawn("sleep", ["30"], { cwd: busy, stdio: "ignore" });
    try {
      await new Promise<void>((ok, fail) => { child.once("spawn", ok); child.once("error", fail); });
      // under load the process scan can lag the spawn: wait until the product's own check sees it
      for (const until = Date.now() + 5000; Date.now() < until && !busyPid(busy); ) await new Promise((r) => setTimeout(r, 50));
      expect(busyPid(busy)).toBeGreaterThan(0);
      // the pool state names the live host's spare: it is kept even with a process inside
      writePoolState(stateFor(host.pid!, "spare-1-2", busy), poolStatePath(logDir));
      const dry = gcPoolWorktrees(logDir, true);
      expect(dry.filter((e) => e.archive).map((e) => e.id).sort()).toEqual(["slot-local-1", "spare-1-1"]);
      expect(dry.find((e) => e.id === "spare-1-2")?.skipped).toMatch(/pool spare of live host/);
      expect(existsSync(spare)).toBe(true);

      const res = gcPoolWorktrees(logDir, false);
      expect(res.filter((e) => e.archive).map((e) => e.id).sort()).toEqual(["slot-local-1", "spare-1-1"]);
      expect(res.find((e) => e.id === "spare-1-2")?.skipped).toMatch(/pool spare of live host/);
      expect(existsSync(spare)).toBe(false);
      expect(existsSync(slot)).toBe(false);
      expect(existsSync(busy)).toBe(true);
      expect(git(repo, ["branch", "--list", "spare/spare-1-1"])).toBe("");
    } finally {
      child.kill();
    }
  }, 30_000);

  it("gc --pool removes a detached slot a finished worker's status still names, archives its HEAD, keeps one a live worker owns", () => {
    const base = { cwd: repo, term: "", provider: "p", model: "m", started: "", updated: "", turns: 0, tools: 0, last: "", secs: null, label: "t" };
    const idle = join(logDir, "slots", "local-idle");
    const held = join(logDir, "slots", "local-held");
    git(repo, ["worktree", "add", "--detach", idle, "main"]);
    git(repo, ["worktree", "add", "--detach", held, "main"]);
    const st = (id: string, dir: string, extra: Partial<WorkerStatus>): WorkerStatus =>
      ({ ...base, id, pid: 0, rc: 0, state: "done", worktreeDir: dir, branch: `worker/${id}`, ...extra }) as WorkerStatus;
    saveStatus(logDir, st("fin-1", idle, {}));
    saveStatus(logDir, st("live-1", held, { state: "running", pid: process.pid, rc: null }));
    const res = gcPoolWorktrees(logDir, false);
    expect(res.find((e) => e.id === "slot-local-idle")?.archive).toBe("refs/pai-archive/slot-local-idle");
    expect(existsSync(idle)).toBe(false);
    expect(git(repo, ["rev-parse", "refs/pai-archive/slot-local-idle"])).toBe(git(repo, ["rev-parse", "main"]));
    expect(existsSync(held)).toBe(true);
  });

  // each case runs as its own phase: a gc archives every spare-* tree on disk that
  // no live state names, so the tree under test must be the only one present
  const sparePhase = async (spareId: string, hostPid: number, archive: string | undefined): Promise<void> => {
    const spare = join(worktreesDir(logDir), spareId);
    git(repo, ["worktree", "add", spare, "-b", `spare/${spareId}`, "main"]);
    writePoolState(stateFor(hostPid, spareId, spare), poolStatePath(logDir));
    const res = gcPoolWorktrees(logDir, false);
    expect(res.find((e) => e.id === spareId)?.archive).toBe(archive);
    expect(existsSync(spare)).toBe(archive === undefined);
  };

  it("gc --pool keeps a spare of a live pool host and removes one whose host pid is dead or reused", async () => {
    await new Promise((r) => setTimeout(r, 300));
    // a pid no process holds (above the system's max is never alive)
    const deadPid = 2 ** 22;

    // dead host pid: the spare stays an orphan
    await sparePhase("spare-9-2", deadPid, "refs/pai-archive/spare-9-2");

    // reused pid: alive, but its command is not a pool host
    await sparePhase("spare-9-3", process.pid, "refs/pai-archive/spare-9-3");

    // live host: the state's spare dir is kept, even in a real run
    const live = join(worktreesDir(logDir), "spare-9-1");
    git(repo, ["worktree", "add", live, "-b", "spare/spare-9-1", "main"]);
    writePoolState(stateFor(host.pid!, "spare-9-1", live), poolStatePath(logDir));
    const dry = gcPoolWorktrees(logDir, true);
    expect(dry.find((e) => e.id === "spare-9-1")?.skipped).toMatch(/pool spare of live host/);
    expect(dry.find((e) => e.id === "spare-9-1")?.archive).toBeUndefined();
    const kept = gcPoolWorktrees(logDir, false);
    expect(kept.find((e) => e.id === "spare-9-1")?.skipped).toMatch(/pool spare of live host/);
    expect(kept.find((e) => e.id === "spare-9-1")?.archive).toBeUndefined();
    expect(existsSync(live)).toBe(true);
  }, 30_000);

  it("gc --pool keeps a live host's spare the state does not list, and (torn state) protects a busy spare", async () => {
    await new Promise((r) => setTimeout(r, 300));
    // spare-<hostpid>-N, state file lists nothing of it
    const mine = join(worktreesDir(logDir), `spare-${host.pid}-1`);
    git(repo, ["worktree", "add", mine, "-b", `spare/spare-${host.pid}-1`, "main"]);
    writePoolState(stateFor(host.pid!, "spare-other", join(logDir, "nowhere")), poolStatePath(logDir));
    const res = gcPoolWorktrees(logDir, false);
    expect(res.find((e) => e.id === `spare-${host.pid}-1`)?.skipped).toMatch(/live pool host/);
    expect(existsSync(mine)).toBe(true);

    // torn state: unknown, so a spare with a process inside stays; an idle one goes
    const busy = join(worktreesDir(logDir), "spare-8-1");
    const idle = join(worktreesDir(logDir), "spare-8-2");
    git(repo, ["worktree", "add", busy, "-b", "spare/spare-8-1", "main"]);
    git(repo, ["worktree", "add", idle, "-b", "spare/spare-8-2", "main"]);
    writeFileSync(poolStatePath(logDir), '{"hostPid": 12');
    const child = spawn("sleep", ["30"], { cwd: busy, stdio: "ignore" });
    try {
      await new Promise<void>((ok, fail) => { child.once("spawn", ok); child.once("error", fail); });
      for (const until = Date.now() + 5000; Date.now() < until && !busyPid(busy); ) await new Promise((r) => setTimeout(r, 50));
      const torn = gcPoolWorktrees(logDir, false);
      expect(torn.find((e) => e.id === "spare-8-1")?.skipped).toMatch(/busy/);
      expect(existsSync(busy)).toBe(true);
      expect(torn.find((e) => e.id === "spare-8-2")?.archive).toBeDefined();
      expect(existsSync(idle)).toBe(false);
    } finally {
      child.kill();
    }
  }, 30_000);
});
