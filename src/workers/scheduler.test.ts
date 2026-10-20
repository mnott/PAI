import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGING_MS, admitCap, capacityGate, liveQueue, providerCap } from "./capacity.js";
import { defaultWorkersConfig } from "./config.js";
import { activeText, beginBuildWait, buildWaitMs, endBuildWait } from "./active-time.js";
import { armDeadline, extendLimit, resolveLimit } from "./deadline.js";
import { buildRunEnv } from "./run-env.js";
import { schedulerLines, schedulerView } from "./scheduler.js";
import type { WorkerStatus } from "./status.js";

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "sched-"));
  dirs.push(d);
  return d;
};
const st = (id: string, session: string, state: WorkerStatus["state"] = "queued", over: Partial<WorkerStatus> = {}): WorkerStatus =>
  ({ id, pid: 100, provider: "loc", state, spawnerSession: session, turns: 0, origin: "spawn", started: "2026-10-20 10:00:00", label: id, cwd: "/x", ...over }) as WorkerStatus;
const enqueue = (logDir: string, id: string, since: number, extra = ""): void => {
  const dir = join(logDir, "queue", "loc");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, id), `100 ${extra}@${since}`);
};
const alive = (): boolean => true;

describe("fair share across sessions", () => {
  it("session A queues 5, B queues 1: B gets the 2nd slot", () => {
    const logDir = tmp();
    const all = ["a1", "a2", "a3", "a4", "a5"].map((id) => st(id, "A"));
    all.push(st("b1", "B"));
    all.forEach((s, i) => enqueue(logDir, s.id, 1000 + i));
    const order = liveQueue(logDir, "loc", alive, all, 2000);
    expect(order).toEqual(["a1", "b1", "a2", "a3", "a4", "a5"]);
  });

  it("a session already running a worker yields the next slot", () => {
    const logDir = tmp();
    const all = [st("run-a", "A", "running"), st("a2", "A"), st("b1", "B")];
    enqueue(logDir, "a2", 1000);
    enqueue(logDir, "b1", 1001);
    expect(liveQueue(logDir, "loc", alive, all, 2000)).toEqual(["b1", "a2"]);
  });

  it("three sessions take turns", () => {
    const logDir = tmp();
    const all = [st("a1", "A"), st("a2", "A"), st("b1", "B"), st("b2", "B"), st("c1", "C")];
    all.forEach((s, i) => enqueue(logDir, s.id, 1000 + i));
    expect(liveQueue(logDir, "loc", alive, all, 2000)).toEqual(["a1", "b1", "c1", "a2", "b2"]);
  });

  it("keeps the session's own pull-forward order", () => {
    const logDir = tmp();
    const all = [st("a1", "A"), st("a2", "A"), st("b1", "B")];
    enqueue(logDir, "a1", 1000);
    enqueue(logDir, "a2", 1001, "1 ");
    enqueue(logDir, "b1", 1002);
    // a2 pulled to the head of A's queue by rank
    writeFileSync(join(logDir, "queue", "loc", "a2"), "100 0 @1001");
    writeFileSync(join(logDir, "queue", "loc", "a1"), "100 1 @1000");
    expect(liveQueue(logDir, "loc", alive, all, 2000)).toEqual(["a2", "b1", "a1"]);
  });

  it("aging: a ticket waiting > 15 min jumps ahead of newer tickets of any session", () => {
    const logDir = tmp();
    const now = 10_000_000;
    // A's old ticket would be third by share (B and C are fresh and fewer), but it aged
    const all = [st("a1", "A", "running"), st("a2", "A"), st("b1", "B"), st("c1", "C")];
    enqueue(logDir, "a2", now - AGING_MS - 1);
    enqueue(logDir, "b1", now - 1000);
    enqueue(logDir, "c1", now - 500);
    expect(liveQueue(logDir, "loc", alive, all, now)).toEqual(["a2", "b1", "c1"]);
    expect(liveQueue(logDir, "loc", alive, all, now - AGING_MS)).toEqual(["b1", "c1", "a2"]);
  });

  it("the gate grants B the second slot (dry run, two sessions)", async () => {
    const logDir = tmp();
    const ids = ["a1", "a2", "a3", "a4", "a5", "b1"];
    const sess = (id: string): string => (id.startsWith("a") ? "A" : "B");
    const state: Record<string, WorkerStatus["state"]> = Object.fromEntries(ids.map((i) => [i, "queued" as const]));
    let t = 0;
    const granted: string[] = [];
    ids.forEach((id, i) => enqueue(logDir, id, i));
    const granted_at: Record<string, string> = {};
    const load = (): WorkerStatus[] => ids.map((id) => st(id, sess(id), state[id], granted_at[id] ? { started: granted_at[id] } : {}));
    const run = (id: string) =>
      capacityGate({
        logDir,
        self: { id, provider: "loc", pid: 100 },
        cap: 1,
        config: defaultWorkersConfig().capacity,
        now: () => t,
        sleep: async () => {
          t += 1000;
          // the running worker finishes after every poll round, freeing the slot
          for (const k of ids) if (state[k] === "running") state[k] = "done";
        },
        load,
        isAlive: alive,
      }).then(() => {
        granted.push(id);
        granted_at[id] = `2026-10-20 10:00:${String(granted.length).padStart(2, "0")}`;
        state[id] = "running";
      });
    // a1 is admitted into the empty slot; the other five poll concurrently, like five `pai worker run` processes
    await run("a1");
    await Promise.all(ids.slice(1).map(run));
    expect(granted).toEqual(["a1", "b1", "a2", "a3", "a4", "a5"]);
  });
});

describe("conversationSlots cap", () => {
  it("holds admission one below the engine's conversation slots, never below 1", () => {
    expect(admitCap(undefined, undefined, true)).toBe(1);
    expect(admitCap(4, undefined, true)).toBe(4);
    expect(admitCap(4, 4, true)).toBe(3);
    expect(admitCap(2, 8, true)).toBe(2);
    expect(admitCap(undefined, 1, true)).toBe(1);
    expect(admitCap(undefined, 3, false)).toBe(2);
  });

  it("providerCap applies it", () => {
    const c = { providers: { loc: { baseUrl: "http://127.0.0.1:8790", maxConcurrent: 4, conversationSlots: 4 } } };
    expect(providerCap(c, "loc")).toBe(3);
  });

  it("the gate admits at most the cap", async () => {
    const logDir = tmp();
    const holders = [st("h1", "A", "running"), st("h2", "B", "running")];
    const self = st("w", "C");
    let t = 0;
    const info: number[] = [];
    await expect(
      capacityGate({
        logDir,
        self: { id: "w", provider: "loc", pid: 100 },
        cap: admitCap(4, 3, true),
        config: defaultWorkersConfig().capacity,
        now: () => t,
        sleep: async () => {
          t += 1000;
          if (t > 3000) throw new Error("stop");
        },
        onWait: (w) => w && info.push(w.cap),
        load: () => [...holders, self],
        isAlive: alive,
      })
    ).rejects.toThrow("stop");
    expect(info[0]).toBe(2);
  });
});

describe("deadline counts active time", () => {
  it("queue wait moves a minutes limit, not a wall-clock one", () => {
    const l = resolveLimit({ maxMinutes: 60 }, 0, new Date(0))!;
    expect(extendLimit(l, 31 * 60_000).deadlineAt).toBe(91 * 60_000);
    const abs = resolveLimit({ deadline: "23:59" }, 0, new Date(2026, 9, 20, 10, 0))!;
    expect(extendLimit(abs, 31 * 60_000)).toBe(abs);
  });

  it("a build-gate wait pushes the kill out; the kill reports after the active budget", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const logDir = tmp();
    const limit = { deadlineAt: 10 * 60_000, minutes: 10 };
    const proc = { kill: vi.fn(() => true), exitCode: null, signalCode: null } as never;
    const fired = vi.fn();
    armDeadline(proc, limit, fired, 1000, () => buildWaitMs(logDir, "w1"));
    vi.advanceTimersByTime(2 * 60_000);
    beginBuildWait(logDir, "w1"); // blocked from minute 2 ...
    vi.advanceTimersByTime(20 * 60_000);
    expect(fired).not.toHaveBeenCalled(); // ... to minute 22: the old deadline (10) passed unharmed
    endBuildWait(logDir, "w1");
    expect(buildWaitMs(logDir, "w1")).toBe(20 * 60_000);
    vi.advanceTimersByTime(8 * 60_000 - 1000);
    expect(fired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000); // 10 active minutes used (2 + 8) at minute 30
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it("status text: active X of Y min, waited Z", () => {
    const started = "2026-10-20 10:00:00";
    const now = new Date(2026, 9, 20, 11, 0, 0).getTime();
    expect(activeText({ started, maxMinutes: 60, queueWaitedMs: 10 * 60_000, blockedMs: 20 * 60_000 }, now)).toBe("active 40 of 60 min, waited 30");
    expect(activeText({ started }, now)).toBeNull();
  });
});

describe("loopback timeouts", () => {
  it("a loopback provider's runs get 30 min request and stream-idle timeouts", () => {
    const p = {
      name: "loc",
      baseUrl: "http://127.0.0.1:8790",
      apiKey: "k",
      env: {},
      models: { default: "m" },
    } as never;
    const env = buildRunEnv(p, true, undefined, "loc");
    expect(env.API_TIMEOUT_MS).toBe("1800000");
    expect(env.CLAUDE_STREAM_IDLE_TIMEOUT_MS).toBe("1800000");
    expect(env.CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS).toBe("1800000");
  });
});

describe("visibility", () => {
  it("per session running/waiting and per engine slots", () => {
    const logDir = tmp();
    enqueue(logDir, "a2", 1000);
    enqueue(logDir, "b1", 1500);
    const statuses = [st("a1", "A", "running", { sessionKey: "job-a" }), st("a2", "A", "queued", { sessionKey: "job-a" }), st("b1", "B", "queued", { sessionKey: "job-b" })];
    const workers = { providers: { loc: { baseUrl: "http://127.0.0.1:8790", conversationSlots: 4, maxConcurrent: 4 } } } as never;
    const v = schedulerView(logDir, workers, 61_000 + 1000, statuses, () => true, () => true);
    const lines = schedulerLines(v);
    expect(lines[0]).toBe("engine loc: slots 1/3, conversation slots 4");
    expect(lines).toContain("session job-a: 1 running, 1 waiting (#2 a2 waited 61s)");
    expect(lines.some((l) => l.startsWith("session job-b: 0 running, 1 waiting (#1 b1"))).toBe(true);
  });
});
