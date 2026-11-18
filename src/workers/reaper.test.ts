import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { backgroundArgv, capBashCommand, withCpuLimit } from "./priority.js";
import { killTree, killWorker } from "./kill-tree.js";
import { findOrphans, reapWorkerProcesses } from "./reap.js";
import { scratchDir } from "./scratch.js";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { REAP_TICK_MS, reapOrphansOnce, type ProcRow, type ReaperDeps, type ReaperState } from "./reaper.js";
import { loadStatusesCached } from "./status.js";
import { worktreesDir } from "./worktree.js";

const row = (over: Partial<ProcRow>): ProcRow => ({ pid: 100, ppid: 1, cpu: 80, ageSecs: 600, command: "node /usr/local/bin/pai worker run --class implement", cwd: "", ...over });

/** A status file written the way saveStatus writes it (json), minimal fields only. */
function putStatus(logDir: string, id: string, over: Record<string, unknown>): void {
  writeFileSync(join(logDir, `${id}.status`), JSON.stringify({ id, label: id, state: "running", pid: 4242, started: "2026-11-16 10:00:00", updated: "2026-11-16 10:00:00", ...over }));
}

function fakeLogDir(): string {
  const dir = join(tmpdir(), `reaper-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(worktreesDir(dir), { recursive: true });
  return dir;
}

/**
 * Advance the global status-cache clock past a fake reaper pass's fixed clock (which starts at
 * 1_700_000_000_000, far in the past): without this, a terminal status cached during the first pass
 * is trusted for TERMINAL_RECHECK_MS against that stale clock and never re-read on the second.
 */
function primeStatusCache(logDir: string): void {
  loadStatusesCached(logDir, 1_700_000_000_000 + 10 * 60_000);
}

function deps(rows: ProcRow[], logDir: string): ReaperDeps & { killed: number[] } {
  const killed: number[] = [];
  let tick = 0;
  const load = (id: string): { parent?: string; state?: string; pid?: number } | null => {
    try {
      return JSON.parse(readFileSync(join(logDir, `${id}.status`), "utf8")) as { parent?: string; state?: string; pid?: number };
    } catch {
      return null;
    }
  };
  return {
    killed,
    snapshot: () => rows.map((r) => ({ ...r, ageSecs: r.ageSecs + (tick * REAP_TICK_MS) / 1000 })), // ages grow with the clock: same process, same start
    // fixed clock: the two busy samples must sit REAP_TICK_MS apart (Date.now would be milliseconds apart)
    now: () => 1_700_000_000_000 + tick++ * REAP_TICK_MS,
    kill: async (pid) => void killed.push(pid),
    log: () => {},
    owner: (_dir, path) => (path.startsWith(worktreesDir(logDir) + "/") ? path.slice(worktreesDir(logDir).length + 1).split("/")[0] : undefined),
    annotate: () => {},
    parentLive: (_dir, id) => {
      const st = load(id);
      return !!st?.parent && load(st.parent)?.state === "running";
    },
    // a worker's own status is live when it runs and still owns its pid — read straight from the files
    // (the real default is loadStatusesCached + ownsPidCached). Pid 4242 = the worker's own running
    // process, which never appears in this ppid-1 snapshot; any other pid reads as already dead.
    selfLive: (s) => {
      const fresh = load(s.id);
      return !!fresh && (fresh.state === "running" || fresh.state === "queued") && fresh.pid === 5000;
    },
  };
}

describe("reaper spares a child of a live parent", () => {
  it("does not reap the busy ppid-1 process of a worker whose recorded parent still runs", async () => {
    const logDir = fakeLogDir();
    primeStatusCache(logDir);
    try {
      // the L1 runs as its own live process (pid 5000, outside this snapshot) and supervises the child
      putStatus(logDir, "l1-parent", { pid: 5000 });
      putStatus(logDir, "l2-child", { parent: "l1-parent" });
      // the child's runner reparented to launchd (the --detach case), busy past every reaper threshold
      const d = deps([row({ cwd: join(worktreesDir(logDir), "l2-child") })], logDir);
      const state: ReaperState = new Map();
      const first = await reapOrphansOnce(logDir, state, d);
      const second = await reapOrphansOnce(logDir, state, d); // the two-sample pass would kill a normal orphan here
      expect(first).toEqual([]);
      expect(second).toEqual([]);
      expect(d.killed).toEqual([]);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });
  it("reaps the same process once the parent is gone too", async () => {
    const logDir = fakeLogDir();
    primeStatusCache(logDir);
    try {
      putStatus(logDir, "l1-parent", { state: "done", rc: 0 });
      putStatus(logDir, "l2-child", { parent: "l1-parent" });
      const d = deps([row({ cwd: join(worktreesDir(logDir), "l2-child") })], logDir);
      const state: ReaperState = new Map();
      await reapOrphansOnce(logDir, state, d);
      const second = await reapOrphansOnce(logDir, state, d);
      expect(second).toEqual([100]);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});

describe("reaper spares the processes of a live worker's worktree", () => {
  // the 2026-11-16 case: a `pai worker run` launcher started from inside a live L1 runs with cwd in
  // the L1's worktree, so ownerOf names the L1 itself — and the L1 has no parent (the operator started
  // it). The process is the live worker's own child: spare it on the owner's liveness, not its parent.
  it("spares a busy ppid-1 launcher whose cwd sits in a running L1's worktree", async () => {
    const logDir = fakeLogDir();
    primeStatusCache(logDir);
    try {
      putStatus(logDir, "l1-live", { pid: 5000 }); // running, its own live process (selfLive owns it), no parent — the L1 has none: the operator started it
      const d = deps([row({ cwd: join(worktreesDir(logDir), "l1-live", "sub") })], logDir);
      const state: ReaperState = new Map();
      const first = await reapOrphansOnce(logDir, state, d);
      const second = await reapOrphansOnce(logDir, state, d); // the two-sample pass would kill a normal orphan here
      expect(first).toEqual([]);
      expect(second).toEqual([]);
      expect(d.killed).toEqual([]);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });
  it("reaps the same process when the worktree's worker finished and owns no live pid", async () => {
    const logDir = fakeLogDir();
    primeStatusCache(logDir);
    try {
      putStatus(logDir, "l1-done", { state: "done", rc: 0, pid: 9 }); // terminal, and not selfLive
      const d = deps([row({ cwd: join(worktreesDir(logDir), "l1-done") })], logDir);
      const state: ReaperState = new Map();
      await reapOrphansOnce(logDir, state, d);
      const second = await reapOrphansOnce(logDir, state, d);
      expect(second).toEqual([100]);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});

describe("reapWorkerProcesses ends the worker's whole process tree", () => {
  const MARK = `reapmark${process.pid}x${Date.now()}`;
  const psLines = (): string[] => execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n").filter((l) => l.includes(MARK));
  // perl alarm caps the spin without `timeout`, which moves its child into a group of its own
  const loop = (tag: string) => `perl -e 'alarm 20; exec @ARGV' sh -c 'while :; do :; done # ${MARK}-${tag}'`;
  const cleanup: number[] = [];
  afterEach(() => {
    for (const l of psLines()) {
      const pid = Number(l.trim().split(/\s+/)[0]);
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
    for (const p of cleanup.splice(0)) try { process.kill(-p, "SIGKILL"); } catch { /* gone */ }
  });
  const waitFor = async (cond: () => boolean): Promise<void> => {
    for (let i = 0; i < 50 && !cond(); i++) await new Promise((r) => setTimeout(r, 100));
  };

  /** A fake run: leads its own group, backgrounds a subshell loop and a setsid'd escapee carrying the worker's scratch dir. */
  async function startFake(id: string): Promise<number> {
    const script = `(${loop("group")}) & perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' ${loop("scratch")} ${scratchDir(id)} & wait`;
    // the scratch path rides in argv after the loop: `timeout` rejects it, so put it in the loop body instead
    const fixed = script.replace(` ${scratchDir(id)} &`, " &").replace(`${MARK}-scratch`, `${MARK}-scratch ${scratchDir(id)}`);
    const root = spawn("sh", ["-c", fixed], { detached: true, stdio: "ignore" });
    root.unref();
    cleanup.push(root.pid!);
    await waitFor(() => psLines().filter((l) => l.includes("while :")).length >= 2);
    expect(psLines().filter((l) => l.includes("while :")).length).toBeGreaterThanOrEqual(2);
    return root.pid!;
  }

  it("normal end: group child and setsid escapee are gone, an unrelated look-alike is untouched", async () => {
    const id = `reapt-${process.pid}-a`;
    const root = await startFake(id);
    const other = spawn("sh", ["-c", `${loop("unrelated")}`], { detached: true, stdio: "ignore" });
    other.unref();
    cleanup.push(other.pid!);
    await reapWorkerProcesses({ rootPid: root, id }, () => undefined, 300);
    await waitFor(() => !psLines().some((l) => /-group|-scratch/.test(l)));
    expect(psLines().filter((l) => /-group|-scratch/.test(l))).toEqual([]);
    expect(psLines().some((l) => l.includes("-unrelated"))).toBe(true);
  }, 20000);

  it("kill: the leader dies first, the sweep still ends its group and the escapee", async () => {
    const id = `reapt-${process.pid}-b`;
    const root = await startFake(id);
    process.kill(root, "SIGKILL");
    await new Promise((r) => setTimeout(r, 200));
    await reapWorkerProcesses({ rootPid: root, id }, () => undefined, 300);
    await waitFor(() => !psLines().some((l) => /-group|-scratch/.test(l)));
    expect(psLines().filter((l) => /-group|-scratch/.test(l))).toEqual([]);
  }, 20000);
});

describe("reapWorkerProcesses kills only the worker's own processes", () => {
  const spawned: number[] = [];
  const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const pidOf = (tag: string): number | undefined => {
    const l = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n").find((x) => x.includes(tag) && !x.includes("sh -c"));
    return l ? Number(l.trim().split(/\s+/)[0]) : undefined;
  };
  const waitPid = async (tag: string): Promise<number> => {
    for (let i = 0; i < 50 && !pidOf(tag); i++) await new Promise((r) => setTimeout(r, 100));
    const p = pidOf(tag)!;
    expect(p).toBeGreaterThan(1);
    spawned.push(p);
    return p;
  };
  afterEach(() => { for (const p of spawned.splice(0)) try { process.kill(p, "SIGKILL"); } catch { /* gone */ } });
  const noop = () => undefined;

  it("a non-descendant with cwd in the worktree and a live parent survives", async () => {
    const id = `reaps-${process.pid}-cwd`;
    const dir = join(tmpdir(), `${id}-wt`);
    mkdirSync(dir, { recursive: true });
    const child = spawn("sleep", ["19"], { cwd: dir, stdio: "ignore" }); // parent: this test process, live
    try {
      const pid = await waitPid("sleep 19");
      await reapWorkerProcesses({ dir, id }, noop, 200);
      expect(alive(pid)).toBe(true);
    } finally {
      child.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  it("an orphan sitting in the scratch dir is killed", async () => {
    const id = `reaps-${process.pid}-orph`;
    const sd = scratchDir(id);
    mkdirSync(sd, { recursive: true });
    try {
      execFileSync("sh", ["-c", `cd '${sd}' && (timeout 20 sleep 18 >/dev/null 2>&1 &)`]);
      const pid = await waitPid("sleep 18");
      const lines: string[] = [];
      await reapWorkerProcesses({ id }, (l) => lines.push(l), 200);
      for (let i = 0; i < 30 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
      expect(alive(pid)).toBe(false);
      expect(lines.join("\n")).toContain("orphan+scratch");
    } finally {
      rmSync(sd, { recursive: true, force: true });
    }
  }, 20000);

  it("PAI_WORKER_ID=<id>X (prefix collision) survives while PAI_WORKER_ID=<id> orphan dies", async () => {
    const id = `reaps-${process.pid}-env`;
    execFileSync("sh", ["-c", `(PAI_WORKER_ID=${id}X timeout 20 sleep 17 >/dev/null 2>&1 &); (PAI_WORKER_ID=${id} timeout 20 sleep 16 >/dev/null 2>&1 &)`]);
    const longer = await waitPid("sleep 17");
    const exact = await waitPid("sleep 16");
    await reapWorkerProcesses({ id }, noop, 200);
    for (let i = 0; i < 30 && alive(exact); i++) await new Promise((r) => setTimeout(r, 100));
    expect(alive(longer)).toBe(true);
    expect(alive(exact)).toBe(false);
  }, 20000);

  it("never signals its own ancestors", () => {
    // rootPid = our parent: its whole tree (us, siblings) is "descendant", yet the reaper's ancestors must stay out
    const pids = findOrphans({ rootPid: process.ppid, dir: process.cwd() }).map((p) => p.pid);
    expect(pids).not.toContain(process.pid);
    expect(pids).not.toContain(process.ppid);
  });
});

describe("worker priority and kill", () => {
  const MARK = `prio${process.pid}x${Date.now()}`;
  const psLines = (): string[] => execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n").filter((l) => l.includes(MARK));
  afterEach(() => {
    for (const l of psLines()) try { process.kill(Number(l.trim().split(/\s+/)[0]), "SIGKILL"); } catch { /* gone */ }
  });

  it("the worker's command line gets the background-priority wrapper, off when disabled", () => {
    expect(backgroundArgv(["claude", "-p"], undefined, "darwin")).toEqual(["taskpolicy", "-b", "claude", "-p"]);
    expect(backgroundArgv(["claude", "-p"], { background: true }, "linux")).toEqual(["nice", "-n", "10", "claude", "-p"]);
    expect(backgroundArgv(["claude", "-p"], { background: false }, "darwin")).toEqual(["claude", "-p"]);
  });

  it("a taskpolicy -b child really runs at background QoS", () => {
    if (process.platform !== "darwin") return;
    const [bin, ...args] = backgroundArgv(["sh", "-c", `ps -o pri= -p $$; : ${MARK}`], undefined, "darwin");
    const out = execFileSync(bin, args, { encoding: "utf8", timeout: 20_000 });
    expect(Number(out.trim())).toBeLessThan(10); // a normal process sits near 31, a background one at 4
  });

  it("a worker Bash command gets the ulimit prefix; test runs and build doors are uncapped", () => {
    expect(capBashCommand("ls -la", { cpuSecondsPerCommand: 300 })).toMatch(/^ulimit -S -t 300 /);
    expect(capBashCommand("ls -la")).toMatch(/^ulimit -S -t 300 /);
    expect(capBashCommand("npx vitest run src/x.test.ts")).toMatch(/^ulimit -S -t unlimited/);
    expect(capBashCommand("pai build run -- make")).toMatch(/^ulimit -S -t unlimited/);
    expect(capBashCommand("ls", { cpuSecondsPerCommand: 0 })).toMatch(/^ulimit -S -t unlimited/);
  });

  it("a command that burns its CPU budget dies with the CPU-time message", () => {
    const script = join(tmpdir(), `${MARK}.sh`);
    writeFileSync(script, withCpuLimit(`perl -e '1 while 1' ${MARK}`, 1) + "\n");
    const r = spawnSync("timeout", ["20", "bash", script], { encoding: "utf8" });
    expect(r.stderr).toContain("CPU time limit exceeded");
    expect(r.status).toBe(152);
    rmSync(script, { force: true });
  }, 25_000);

  it("kill of a running fake worker ends its whole tree and reports it; an unknown id fails", async () => {
    const logDir = fakeLogDir();
    try {
      const root = spawn("sh", ["-c", `perl -e 'alarm 20; sleep 20' ${MARK}-child & wait`], { detached: true, stdio: "ignore" });
      root.unref();
      for (let i = 0; i < 50 && !psLines().some((l) => l.includes("-child")); i++) await new Promise((r) => setTimeout(r, 100));
      expect(psLines().some((l) => l.includes("-child"))).toBe(true);
      putStatus(logDir, "kt-1", { pid: root.pid, state: "running" });
      const lines = await killTree(logDir, "kt-1", { deps: { owns: () => true, request: () => undefined, waitTerminal: async () => null, graceMs: 300 } });
      expect(lines.join("\n")).toMatch(/sent SIGTERM to worker kt-1 .*; ended \d+ process/);
      for (let i = 0; i < 30 && psLines().some((l) => l.includes("-child")); i++) await new Promise((r) => setTimeout(r, 100));
      expect(psLines().filter((l) => l.includes("-child"))).toEqual([]);
      await expect(killWorker(logDir, "no-such-worker", {})).rejects.toThrow(/no worker named/);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  }, 25_000);
});
