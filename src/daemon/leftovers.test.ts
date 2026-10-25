import { describe, expect, it } from "vitest";
import { collectLeftovers, formatLeftovers, parsePs, type LeftoverInput } from "./leftovers.js";
import type { WorkerStatus } from "../workers/status.js";
import type { PoolState } from "../workers/pool.js";

const ps = [
  "11274     1 4-02:10:05 node /x/pai/dist/cli.js worker pool-host --port 8798",
  "11300 11274 4-02:09:00 claude --model m --spare",
  "812   1  10:00 node /x/pai/dist/daemon.js serve",
  "900   812 15:30 claude --model glm-5.3-flash -p --no-session-persistence",
  "901   500 01:00 claude --model glm-5.3-flash -p --no-session-persistence",
  "2000  100 03:00:00 claude --model m --worker-done",
  "2100  100 00:30 claude --model m --worker-live",
  "3000  1 4-00:00:00 node /usr/bin/tsx .scratch/harness.ts",
  "3100  1 1-00:00:00 node /usr/bin/tsx .scratch/ok.ts",
  "4000  1 00:10 vim notes.md",
].join("\n");

const st = (id: string, pid: number, state: WorkerStatus["state"]) => ({ id, pid, state, label: "l" }) as WorkerStatus;
const pool = { hostPid: 11274, port: 8798, spares: [{ pid: 11300, state: "ready", provider: "p", model: "m", dir: "/d" }] } as unknown as PoolState;

const input = (over: Partial<LeftoverInput> = {}): LeftoverInput => ({
  ps,
  poolState: pool,
  statuses: [st("w-done", 2000, "done"), st("w-live", 2100, "running")],
  daemonPid: 812,
  cwdOf: (pid) => (pid === 3000 ? "/r/worktrees/gone" : pid === 3100 ? "/r/worktrees/here" : ""),
  dirExists: (p) => p === "/r/worktrees/here",
  pidAlive: () => true,
  owns: () => true,
  ...over,
});

describe("collectLeftovers", () => {
  it("recognises every kind and leaves a live worker alone", () => {
    const l = collectLeftovers(input());
    const by = Object.fromEntries(l.map((x) => [x.pid, x]));
    expect(by[11274]).toMatchObject({ kind: "pool-host", ppid: 1, ageSecs: 4 * 86400 + 2 * 3600 + 10 * 60 + 5 });
    expect(by[11300]).toMatchObject({ kind: "pool-spare", owner: "host 11274 (alive)" });
    expect(by[900]).toMatchObject({ kind: "llm-helper", owner: "daemon 812", ageSecs: 930 });
    expect(by[2000]).toMatchObject({ kind: "finished-worker", owner: "worker w-done (done)" });
    expect(by[3000]).toMatchObject({ kind: "dead-worktree" });
    for (const pid of [901, 2100, 3100, 4000, 812]) expect(by[pid]).toBeUndefined();
    expect(formatLeftovers(l)).toHaveLength(5);
  });
  it("marks spares of a dead host", () => {
    const l = collectLeftovers(input({ ps: ps.split("\n").filter((r) => !r.startsWith("11274")).join("\n"), pidAlive: (p) => p !== 11274 }));
    expect(l.find((x) => x.pid === 11300)?.owner).toBe("host 11274 (dead)");
  });
  it("does not list a finished worker whose pid was reused", () => {
    expect(collectLeftovers(input({ owns: () => false })).some((x) => x.kind === "finished-worker")).toBe(false);
  });
  it("is empty for an ordinary process table", () => {
    expect(collectLeftovers(input({ ps: "4000 1 00:10 vim a", poolState: null, statuses: [] }))).toEqual([]);
    expect(parsePs("garbage")).toEqual([]);
  });
});
