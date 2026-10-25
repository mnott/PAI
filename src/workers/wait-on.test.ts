import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { waitOn, statusMarker, statusQueue, realDeps, killProcessTree, type WaitOnDeps } from "./wait-on.js";
import { loadStatus, saveStatus, type WorkerStatus } from "./status.js";
import type { WaitingOn } from "./waiting.js";

/** Fake clock: sleep advances time; the process is alive until `diesAt` ms. */
function fake(o: { diesAt?: number; initial?: "alive" | "gone" | "foreign"; start?: number }) {
  let t = 1_000_000;
  const out: string[] = [];
  let first = true;
  const deps: WaitOnDeps = {
    probe: () => {
      if (first) {
        first = false;
        return o.initial ?? "alive";
      }
      return o.diesAt !== undefined && t >= 1_000_000 + o.diesAt ? "gone" : "alive";
    },
    startTime: () => o.start ?? 1_000_000 - 5000,
    now: () => t,
    sleep: async (ms) => void (t += ms),
    out: (l) => out.push(l),
  };
  return { deps, out };
}
const dir = mkdtempSync(join(tmpdir(), "waiton-"));

describe("waitOn", () => {
  it("returns 0 when the pid exits, with rc and log tail", async () => {
    const log = join(dir, "a.log");
    writeFileSync(log, "l1\nl2\nl3\n");
    writeFileSync(join(dir, "a.rc"), "7\n");
    const f = fake({ diesAt: 5000 });
    expect(await waitOn({ pid: 42, log, tail: 2 }, f.deps)).toBe(0);
    expect(f.out).toEqual(["pid 42 gone, exit code 7", "l2", "l3"]);
  });

  it("returns 3 at --max and caps at 590 s", async () => {
    const f = fake({});
    expect(await waitOn({ pid: 42, maxSecs: 1000 }, f.deps)).toBe(3);
    expect(f.out.at(-1)).toMatch(/still running after 59[01]s/);
  });

  it("prints a heartbeat about every 20 s", async () => {
    const log = join(dir, "h.log");
    writeFileSync(log, "x\n");
    const f = fake({ diesAt: 45_000 });
    await waitOn({ pid: 42, log, tail: 0 }, f.deps);
    expect(f.out.filter((l) => l.startsWith("running "))).toHaveLength(2);
    expect(f.out[0]).toBe("running 20s, log +0 lines");
  });

  it("returns 2 for a pid that never existed, a foreign pid and an invalid pid", async () => {
    expect(await waitOn({ pid: 42 }, fake({ initial: "gone" }).deps)).toBe(2);
    expect(await waitOn({ pid: 1 }, fake({ initial: "foreign" }).deps)).toBe(2);
    expect(await waitOn({ pid: -3 }, fake({}).deps)).toBe(2);
  });

  it("returns 0 for a pid already gone when its log exists", async () => {
    const log = join(dir, "done.log");
    writeFileSync(log, "ok\n");
    expect(await waitOn({ pid: 42, log }, fake({ initial: "gone" }).deps)).toBe(0);
  });

  it("treats a later process start time (pid reuse) as gone", async () => {
    const f = fake({ start: 1_000_000 + 10_000 });
    expect(await waitOn({ pid: 42, tail: 0 }, f.deps)).toBe(0);
    expect(f.out[0]).toBe("pid 42 gone");
  });
  it("records waitingOn while waiting and clears it on return, on both exits", async () => {
    const marks: (WaitingOn | null)[] = [];
    const proc = () => ({ cmd: "sleep 120", startedAt: 1_000_000 - 252_000 });
    const a = fake({ diesAt: 5000 });
    expect(await waitOn({ pid: 42, log: "/tmp/x.log", tail: 0 }, { ...a.deps, proc, mark: (w) => marks.push(w) })).toBe(0);
    expect(marks).toEqual([{ pid: 42, cmd: "sleep 120", startedAt: 1_000_000 - 252_000, log: "/tmp/x.log" }, null]);
    expect(a.out[0]).toBe("pid 42 gone after 4m18s");
    marks.length = 0;
    expect(await waitOn({ pid: 42, maxSecs: 1, tail: 0 }, { ...fake({}).deps, proc, mark: (w) => marks.push(w) })).toBe(3);
    expect(marks.at(-1)).toBeNull();
    expect(marks).toHaveLength(2);
  });

  it("statusMarker writes and clears waitingOn in the worker's status file", () => {
    const logDir = mkdtempSync(join(tmpdir(), "waiton-st-"));
    const st = { id: "w9", pid: 1, label: "l", cwd: "/", term: "", provider: "p", model: "m", state: "running", started: "", updated: "", turns: 0, tools: 0, last: "", rc: null, secs: null } as WorkerStatus;
    saveStatus(logDir, st);
    const mark = statusMarker(logDir, "w9");
    const w = { pid: 5, cmd: "sleep 9", startedAt: null, log: null };
    mark(w);
    expect(loadStatus(logDir, "w9")?.waitingOn).toEqual(w);
    // the runner's own periodic write (no waitingOn in memory) keeps it
    saveStatus(logDir, { ...st, turns: 1 });
    expect(loadStatus(logDir, "w9")?.waitingOn).toEqual(w);
    mark(null);
    expect(loadStatus(logDir, "w9")?.waitingOn).toBeNull();
    expect(() => statusMarker(logDir, "nope")(w)).not.toThrow();
  });
});

describe("waitOn ceiling and stall kill", () => {
  const spin = () => spawn(process.execPath, ["-e", "for(;;){}"], { stdio: "ignore" });
  const alive = (pid: number) => {
    try {
      return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z");
    } catch {
      return false;
    }
  };

  it("kills a spinning child at --max-minutes, prints the line, exits 4", async () => {
    const c = spin();
    const out: string[] = [];
    const log = join(dir, "spin.log");
    writeFileSync(log, "RUN v1\n");
    const rc = await waitOn({ pid: c.pid!, log, maxMinutes: 0.03, stallMinutes: 100 }, { ...realDeps, out: (l) => out.push(l) });
    expect(rc).toBe(4);
    expect(out[0]).toMatch(new RegExp(`wait-on: pid ${c.pid} still running after 0\\.03m, killed process tree; likely hang`));
    expect(out).toContain("RUN v1");
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(c.pid!)).toBe(false);
  }, 20_000);

  const idle = () => spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });

  it("kills a child whose log stays silent with no CPU and no I/O (stall rule)", async () => {
    const c = idle();
    const out: string[] = [];
    const log = join(dir, "stall.log");
    writeFileSync(log, "RUN v1\n");
    const rc = await waitOn({ pid: c.pid!, log, maxMinutes: 100, stallMinutes: 0.03 }, { ...realDeps, out: (l) => out.push(l) });
    expect(rc).toBe(4);
    expect(out[0]).toMatch(/no output for 0\.03m, killed process tree/);
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(c.pid!)).toBe(false);
  }, 20_000);

  it("does not kill a silent script whose tree holds a `pai worker run` client (idle by design)", async () => {
    const kid = `require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)","pai","worker","run"],{stdio:"ignore"});setInterval(()=>{},1000)`;
    const c = spawn(process.execPath, ["-e", kid], { stdio: "ignore" });
    const out: string[] = [];
    const log = join(dir, "wrun.log");
    writeFileSync(log, "RUN v1\n");
    const rc = await waitOn({ pid: c.pid!, log, maxSecs: 8, maxMinutes: 100, stallMinutes: 0.02, tail: 0 }, { ...realDeps, out: (l) => out.push(l) });
    expect(rc).toBe(3);
    expect(out.some((l) => l.includes("silent but busy (worker run in tree)"))).toBe(true);
    expect(alive(c.pid!)).toBe(true);
    await killProcessTree(c.pid!, 200);
  }, 30_000);

  it("does not kill a silent child that is burning CPU: silent but busy", async () => {
    const c = spin();
    const out: string[] = [];
    const log = join(dir, "busy.log");
    writeFileSync(log, "RUN v1\n");
    const rc = await waitOn({ pid: c.pid!, log, maxSecs: 8, maxMinutes: 100, stallMinutes: 0.02, tail: 0 }, { ...realDeps, out: (l) => out.push(l) });
    expect(rc).toBe(3);
    expect(out.some((l) => /silent but busy \(cpu \+/.test(l))).toBe(true);
    expect(alive(c.pid!)).toBe(true);
    c.kill("SIGKILL");
  }, 30_000);

  it("busy verdict spares the tree, idle verdict kills it (fake clock)", async () => {
    for (const busy of [true, false]) {
      const f = fake({});
      const killed: number[] = [];
      f.deps.logMtime = () => 1_000_000;
      f.deps.killTree = async (p) => void killed.push(p);
      f.deps.busy = async () => ({ busy, why: "open loopback connection" });
      const rc = await waitOn({ pid: 42, log: join(dir, "f.log"), maxSecs: 590, stallMinutes: 0.2, maxMinutes: 100, tail: 0 }, f.deps);
      expect(rc).toBe(busy ? 3 : 4);
      expect(killed).toEqual(busy ? [] : [42]);
      if (busy) expect(f.out.some((l) => l.includes("silent but busy (open loopback connection)"))).toBe(true);
    }
  });

  it("a busy sample counts as activity: one idle sample does not kill, a full idle stall window does", async () => {
    const f = fake({});
    const killedAt: number[] = [];
    const busyUntil = 1_000_000 + 20_000;
    f.deps.logMtime = () => 1_000_000;
    f.deps.killTree = async () => void killedAt.push(f.deps.now());
    let lastBusy = 0;
    f.deps.busy = async () => {
      const busy = f.deps.now() < busyUntil;
      if (busy) lastBusy = f.deps.now();
      return { busy, why: "cpu" };
    };
    const rc = await waitOn({ pid: 42, log: join(dir, "g.log"), maxSecs: 590, stallMinutes: 0.2, maxMinutes: 100, tail: 0 }, f.deps);
    expect(rc).toBe(4);
    expect(killedAt).toHaveLength(1);
    // stallMs is 12 s: silence counts from the last busy sample, so the kill waits a full window after it
    expect(killedAt[0]! - lastBusy).toBeGreaterThanOrEqual(12_000);
  });

  it("leaves a quick process alone", async () => {
    const c = spawn("sleep", ["1"], { stdio: "ignore" });
    const out: string[] = [];
    const rc = await waitOn({ pid: c.pid!, maxMinutes: 1, tail: 0 }, { ...realDeps, out: (l) => out.push(l) });
    expect(rc).toBe(0);
    expect(out[0]).toMatch(/gone/);
  }, 20_000);

  it("kills descendants too, with the fake clock", async () => {
    const f = fake({});
    const killed: number[] = [];
    const rc = await waitOn({ pid: 42, maxMinutes: 1, tail: 0 }, { ...f.deps, killTree: async (p) => void killed.push(p) });
    expect(rc).toBe(4);
    expect(killed).toEqual([42]);
  });
});

describe("waitOn worker target", () => {
  const silent = (cmd: string | null, queue?: WaitOnDeps["queue"]) => {
    const f = fake({});
    const killed: number[] = [];
    f.deps.logMtime = () => 1_000_000;
    f.deps.killTree = async (p) => void killed.push(p);
    f.deps.proc = () => (cmd === null ? null : { cmd, startedAt: 1_000_000 - 5000 });
    if (queue) f.deps.queue = queue;
    return { f, killed };
  };
  const opts = { pid: 42, log: join(dir, "q.log"), maxSecs: 590, stallMinutes: 0.2, maxMinutes: 1, tail: 0 };

  it("is never killed when queued or running per its status", async () => {
    writeFileSync(opts.log, "x\n");
    for (const queued of [true, false]) {
      const { f, killed } = silent(null, () => ({ queued, started: null, id: "w-1" }));
      expect(await waitOn(opts, f.deps)).toBe(3);
      expect(killed).toEqual([]);
      expect(f.out.filter((l) => l.startsWith("pid 42 is worker w-1: waiting without stall/ceiling kill"))).toHaveLength(1);
    }
  });

  it("is never killed when its command line is a worker run", async () => {
    for (const cmd of ["node /x/dist/cli/index.mjs worker run --label a -p b", "/usr/local/bin/pai worker run --provider anthropic"]) {
      const { f, killed } = silent(cmd);
      expect(await waitOn(opts, f.deps)).toBe(3);
      expect(killed).toEqual([]);
      expect(f.out.some((l) => l.includes("is worker"))).toBe(true);
    }
  });

  it("still kills a plain process", async () => {
    const { f, killed } = silent("make test");
    expect(await waitOn(opts, f.deps)).toBe(4);
    expect(killed).toEqual([42]);
  });
});

describe("statusQueue", () => {
  it("finds a queued status by the run client pid, not only status.pid", () => {
    const d = mkdtempSync(join(tmpdir(), "waiton-q-"));
    const s = {
      id: "q1", pid: 111, runPid: 222, label: "x", cwd: "/", term: "", provider: "p", model: "m",
      state: "running", started: "2026-01-01T00:00:00Z", updated: "2026-01-01T00:00:00Z",
      turns: 0, tools: 0, last: "", rc: null, secs: null,
      capacity: { provider: "p", cap: 1, total: 2, position: 1, elapsedSec: 1 },
    } as WorkerStatus;
    saveStatus(d, s);
    const q = statusQueue(d);
    expect(q(222)?.queued).toBe(true);
    expect(q(111)?.queued).toBe(true);
    expect(q(333)).toBeNull();
  });
});

describe("treeBusy: a tree that drives a live worker", () => {
  it("treeOwnsWorker matches a running worker by client, writer or wrapper pid, not a finished one", async () => {
    const { treeOwnsWorker } = await import("./wait-on.js");
    const tree = [100, 101, 102];
    expect(treeOwnsWorker(tree, [{ pid: 900, parentPid: 101, state: "running" }])).toBe(true);
    expect(treeOwnsWorker(tree, [{ pid: 900, runPid: 102, state: "queued" }])).toBe(true);
    expect(treeOwnsWorker(tree, [{ pid: 900, pool: { clientPid: 100 } as never, state: "running" }])).toBe(true);
    expect(treeOwnsWorker(tree, [{ pid: 900, parentPid: 101, state: "done" }])).toBe(false);
    expect(treeOwnsWorker(tree, [{ pid: 900, parentPid: 555, state: "running" }])).toBe(false);
  });

  it("an idle tree whose pid is the parent of a running worker status is busy", async () => {
    const { treeBusy } = await import("./wait-on.js");
    const c = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    const logDir = mkdtempSync(join(tmpdir(), "waiton-own-"));
    expect((await treeBusy(c.pid!, logDir)).busy).toBe(false);
    saveStatus(logDir, { id: "w-own", pid: 999999, parentPid: c.pid!, state: "running" } as WorkerStatus);
    const r = await treeBusy(c.pid!, logDir);
    c.kill();
    expect(r).toEqual({ busy: true, why: "live worker owned by tree" });
  }, 15_000);
});
