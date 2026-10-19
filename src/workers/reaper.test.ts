import { describe, expect, it } from "vitest";
import { parseEtime, reapOrphansOnce, type ProcRow, type ReaperDeps, type ReaperState } from "./reaper.js";

const LOG = "/logs/workers";
const row = (o: Partial<ProcRow> = {}): ProcRow => ({
  pid: 100,
  ppid: 1,
  cpu: 100,
  ageSecs: 300,
  command: "node /x/vitest/dist/workers/forks.js",
  cwd: `${LOG}/slots/glm-1`,
  ...o,
});

function setup(make: () => ProcRow[]) {
  let t = 1_000_000;
  const t0 = t;
  // a real process ages with the clock
  const rows = () => make().map((r) => ({ ...r, ageSecs: r.ageSecs + (t - t0) / 1000 }));
  const killed: number[] = [];
  const logs: string[] = [];
  const notes: string[] = [];
  const deps: ReaperDeps = {
    snapshot: rows,
    now: () => t,
    kill: async (pid) => void killed.push(pid),
    log: (l) => logs.push(l),
    owner: (_d, p) => (p.includes("/slots/glm-1") ? "job-1" : undefined),
    annotate: (_d, id, text) => notes.push(`${id}: ${text}`),
  };
  const state: ReaperState = new Map();
  const tick = async (advance = 30_000) => {
    t += advance;
    return reapOrphansOnce(LOG, state, deps);
  };
  return { tick, killed, logs, notes };
}

describe("reaper", () => {
  it("kills a busy orphan on the second sample 30 s later and annotates its job", async () => {
    const s = setup(() => [row()]);
    await s.tick(0);
    expect(s.killed).toEqual([]);
    await s.tick();
    expect(s.killed).toEqual([100]);
    expect(s.logs[0]).toContain("[job-1]");
    expect(s.notes[0]).toContain("job-1: reaped orphan pid 100");
  });
  it("keeps an orphan that went idle between samples", async () => {
    let cpu = 100;
    const s = setup(() => [row({ cpu })]);
    await s.tick(0);
    cpu = 2;
    await s.tick();
    cpu = 100;
    await s.tick();
    expect(s.killed).toEqual([]);
  });
  it("keeps an idle orphan, a young one, and one under a live parent", async () => {
    const s = setup(() => [row({ pid: 1, cpu: 0 }), row({ pid: 2, ageSecs: 30 }), row({ pid: 3, ppid: 4321 })]);
    await s.tick(0);
    await s.tick();
    expect(s.killed).toEqual([]);
  });
  it("keeps a process outside the worker dirs and a pool slot's claude", async () => {
    const s = setup(() => [
      row({ pid: 5, cwd: "/Users/x/project", command: "node /x/server.js" }),
      row({ pid: 6, command: "/usr/local/bin/claude --print" }),
    ]);
    await s.tick(0);
    await s.tick();
    expect(s.killed).toEqual([]);
  });
  it("matches by command line when the cwd is unknown", async () => {
    const s = setup(() => [row({ cwd: "", command: `node ${LOG}/worktrees/w1/node_modules/.bin/vitest` })]);
    await s.tick(0);
    await s.tick();
    expect(s.killed).toEqual([100]);
  });
  it("parses ps etime", () => {
    expect(parseEtime("02:05")).toBe(125);
    expect(parseEtime("1-02:03:04")).toBe(93784);
  });
});
