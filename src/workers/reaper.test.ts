import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { REAP_TICK_MS, reapOrphansOnce, type ProcRow, type ReaperDeps, type ReaperState } from "./reaper.js";
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

function deps(rows: ProcRow[], logDir: string): ReaperDeps & { killed: number[] } {
  const killed: number[] = [];
  let tick = 0;
  const load = (id: string): { parent?: string; state?: string } | null => {
    try {
      return JSON.parse(readFileSync(join(logDir, `${id}.status`), "utf8")) as { parent?: string; state?: string };
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
  };
}

describe("reaper spares a child of a live parent", () => {
  it("does not reap the busy ppid-1 process of a worker whose recorded parent still runs", async () => {
    const logDir = fakeLogDir();
    try {
      putStatus(logDir, "l1-parent", {});
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
