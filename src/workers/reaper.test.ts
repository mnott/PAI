import { describe, expect, it } from "vitest";
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
      return !!fresh && (fresh.state === "running" || fresh.state === "queued") && fresh.pid === 4242;
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
