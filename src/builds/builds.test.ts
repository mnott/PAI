import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBuild } from "./gate.js";
import { jobPaths, parseEtime, parseTable, reapJob, sweepOrphans, type ProcRow } from "./reap.js";
import { buildNext, enqueue, listBuilds, patchTicket, releaseBuildsOf, renderBuildQueue } from "./queue.js";
import { poolSlots, slotsFor } from "./config.js";
import { bootedSimulators, shutdownAdded, type Simctl } from "./simulators.js";
import { buildGateReason } from "../hooks/ts/lib/build-gate.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pai-builds-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const base = { pollMs: 20, heartbeatMs: 10_000, lowPriority: (c: string[]) => c, out: () => {}, callerGone: () => false };
const until = async (f: () => Promise<boolean>, ms = 5000): Promise<void> => {
  const t0 = Date.now();
  while (!(await f())) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
};
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("build queue", () => {
  it("runs two builds one after the other, FIFO", async () => {
    const a = runBuild({ ...base, dir, slots: 1, label: "A", command: ["sleep", "0.5"] });
    await until(async () => (await listBuilds(dir)).length === 1);
    const b = runBuild({ ...base, dir, slots: 1, label: "B", command: ["sleep", "0.1"] });
    await until(async () => (await listBuilds(dir)).length === 2);
    const q = await listBuilds(dir);
    expect(q.map((t) => `${t.label}:${t.state}`)).toEqual(["A:running", "B:waiting"]);
    expect(await a).toBe(0);
    await until(async () => (await listBuilds(dir)).some((t) => t.label === "B" && t.state === "running"));
    expect(await b).toBe(0);
    expect(await listBuilds(dir)).toEqual([]);
  });

  it("slots=2 runs two at once and queues the third", async () => {
    const ps = ["A", "B", "C"].map((label) => runBuild({ ...base, dir, slots: 2, label, command: ["sleep", "0.6"] }));
    await until(async () => (await listBuilds(dir)).length === 3);
    const q = await listBuilds(dir);
    expect(q.filter((t) => t.state === "running")).toHaveLength(2);
    expect(q.filter((t) => t.state === "waiting")).toHaveLength(1);
    expect(await Promise.all(ps)).toEqual([0, 0, 0]);
  });

  it("passes PAI_BUILD_MODE delta by default and full with --full", async () => {
    const lines: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((b: string | Uint8Array) => (lines.push(String(b)), true)) as typeof process.stdout.write;
    try {
      await runBuild({ ...base, dir, slots: 1, command: ["sh", "-c", "echo mode=$PAI_BUILD_MODE"] });
      await runBuild({ ...base, dir, slots: 1, full: true, command: ["sh", "-c", "echo mode=$PAI_BUILD_MODE"] });
    } finally {
      process.stdout.write = orig;
    }
    expect(lines.join("")).toContain("mode=delta");
    expect(lines.join("")).toContain("mode=full");
  });

  it("kills the build tree when the caller is gone", async () => {
    const r = runBuild({ ...base, dir, slots: 1, label: "L", command: ["sleep", "30"], callerGone: () => true });
    await until(async () => (await listBuilds(dir)).some((t) => !!t.pgid));
    const t = (await listBuilds(dir))[0];
    const code = await r;
    expect(code).toBe(129);
    await until(async () => !alive(t.pgid as number));
    expect(await listBuilds(dir)).toEqual([]);
  });

  it("prunes a dead gate's ticket and kills the tree it left", async () => {
    const dead = spawnSync("true");
    const orphan = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    orphan.unref();
    const t = await enqueue(dir, { pid: dead.pid ?? 999999, label: "X", session: "s", cmd: "sleep 30", mode: "delta" });
    await patchTicket(dir, t.id, { state: "running", pgid: orphan.pid });
    expect(alive(orphan.pid as number)).toBe(true);
    expect(await listBuilds(dir)).toEqual([]);
    await until(async () => !alive(orphan.pid as number));
  });

  it("next moves a waiting build to the front; a worker's builds are released", async () => {
    const me = process.pid;
    const a = await enqueue(dir, { pid: me, label: "A", session: "s", cmd: "a", mode: "delta" });
    const b = await enqueue(dir, { pid: me, label: "B", session: "s", cmd: "b", mode: "delta", worker: "w1" });
    const c = await enqueue(dir, { pid: me, label: "C", session: "s", cmd: "c", mode: "delta" });
    expect(await buildNext(dir, c.id)).toEqual([c.id, a.id, b.id]);
    expect(await releaseBuildsOf(dir, "w1", { kill: () => {} })).toEqual([b.id]);
    expect((await listBuilds(dir)).map((t) => t.id)).toEqual([c.id, a.id]);
  });
});

const fakeSimctl = (booted: string[], log: string[]): Simctl => (args) => {
  if (args[0] === "list") return JSON.stringify({ devices: { "iOS 18": booted.map((udid) => ({ udid, state: "Booted" })) } });
  if (args[0] === "shutdown") {
    log.push(args[1]);
    const i = booted.indexOf(args[1]);
    if (i >= 0) booted.splice(i, 1);
    return "";
  }
  throw new Error("unexpected simctl call");
};

describe("test slots", () => {
  it("reads builds.testSlots (default 2) apart from builds.slots", () => {
    expect(poolSlots({}, () => ({}))).toEqual({ build: 1, test: 2 });
    expect(poolSlots({}, () => ({ builds: { slots: 3, testSlots: 4 } }))).toEqual({ build: 3, test: 4 });
    expect(slotsFor("test", { PAI_TEST_SLOTS: "5" }, () => ({}))).toBe(5);
  });

  it("a test job does not wait behind a build, and tests queue among themselves", async () => {
    const b = runBuild({ ...base, dir, slots: 1, label: "B", command: ["sleep", "0.8"] });
    await until(async () => (await listBuilds(dir)).length === 1);
    const tests = ["T1", "T2", "T3"].map((label) => runBuild({ ...base, dir, kind: "test", slots: 2, label, command: ["sleep", "0.6"], simctl: fakeSimctl([], []) }));
    await until(async () => (await listBuilds(dir)).length === 4);
    const q = await listBuilds(dir);
    expect(q.filter((t) => t.kind === "test" && t.state === "running")).toHaveLength(2);
    expect(q.filter((t) => t.kind === "test" && t.state === "waiting")).toHaveLength(1);
    expect(q.find((t) => t.label === "B")?.state).toBe("running");
    const text = renderBuildQueue(q, { build: 3, test: 2 });
    expect(text).toContain("builds (3 slots)");
    expect(text).toContain("tests (2 slots)");
    expect(await Promise.all([b, ...tests])).toEqual([0, 0, 0, 0]);
  });

  it("a build slot taken does not block a test and vice versa (slots=1 each)", async () => {
    const t = runBuild({ ...base, dir, kind: "test", slots: 1, label: "T", command: ["sleep", "0.4"], simctl: fakeSimctl([], []) });
    await until(async () => (await listBuilds(dir)).length === 1);
    const b = runBuild({ ...base, dir, slots: 1, label: "B", command: ["sleep", "0.1"] });
    await until(async () => (await listBuilds(dir)).length === 2);
    expect((await listBuilds(dir)).every((x) => x.state === "running")).toBe(true);
    await Promise.all([t, b]);
  });

  it("the guard classifies simulator and xcodebuild test runs as kind test", () => {
    const none = null;
    for (const c of ["xcrun simctl boot ABC", "xcrun simctl launch booted com.x", "xcodebuild test -scheme A", "xcodebuild test-without-building -scheme A"]) {
      expect(buildGateReason(c, "/tmp", none), c).toContain("kind test");
    }
    for (const c of ["xcodebuild -scheme A build", "swift build", "cargo test", "xcrun simctl install booted a.app"]) {
      expect(buildGateReason(c, "/tmp", none), c).toContain("kind build");
    }
  });
});

describe("simulator cleanup", () => {
  it("lists booted simulators and shuts down only the ones added", () => {
    const booted = ["A", "B"];
    const log: string[] = [];
    const sim = fakeSimctl(booted, log);
    expect(bootedSimulators(sim)).toEqual(["A", "B"]);
    booted.push("C");
    expect(shutdownAdded(["A", "B"], sim)).toEqual(["C"]);
    expect(log).toEqual(["C"]);
    expect(bootedSimulators(() => { throw new Error("no xcrun"); })).toEqual([]);
  });

  it("a finished test job shuts down the simulator it booted, not the one already up", async () => {
    const booted = ["KEEP"];
    const log: string[] = [];
    const sim = fakeSimctl(booted, log);
    const code = await runBuild({ ...base, dir, kind: "test", slots: 1, command: ["sleep", "0.3"], simctl: sim });
    expect(code).toBe(0);
    expect(log).toEqual([]);
    booted.length = 0;
    const r = runBuild({ ...base, dir, kind: "test", slots: 1, command: ["sleep", "0.3"], simctl: sim });
    await until(async () => (await listBuilds(dir)).some((t) => t.state === "running" && !!t.bootedBefore));
    booted.push("NEW");
    expect(await r).toBe(0);
    expect(log).toEqual(["NEW"]);
  });

  it("a killed test job (caller gone) also shuts its simulators down", async () => {
    const booted: string[] = [];
    const log: string[] = [];
    const sim = fakeSimctl(booted, log);
    let gone = false;
    const r = runBuild({ ...base, dir, kind: "test", slots: 1, command: ["sleep", "30"], simctl: sim, callerGone: () => gone });
    await until(async () => (await listBuilds(dir)).some((t) => !!t.pgid && !!t.bootedBefore));
    booted.push("ORPHAN");
    gone = true;
    expect(await r).toBe(129);
    expect(log).toEqual(["ORPHAN"]);
  });
});

describe("compiler reaping", () => {
  const row = (pid: number, ppid: number, age: number, command: string): ProcRow => ({ pid, ppid, age, command });
  const rec = () => {
    const sent: Array<[number, string]> = [];
    return { sent, kill: (p: number, s: NodeJS.Signals) => void sent.push([p, s]), isAlive: (p: number) => p === 3, wait: async () => {}, log: () => {} };
  };

  it("parses ps rows and etime", () => {
    expect(parseEtime("01:02")).toBe(62);
    expect(parseEtime("1-00:00:01")).toBe(86401);
    expect(parseTable("  10     1  12:00 /x/swift-frontend -c a\n").at(0)).toMatchObject({ pid: 10, ppid: 1, age: 720 });
    expect(jobPaths(["xcodebuild", "-derivedDataPath", "/tmp/dd/app-1"], "/w/trees/job1", {})).toEqual(["/w/trees/job1", "/tmp/dd/app-1"]);
  });

  it("reaps this job's compilers only, TERM then KILL for survivors", async () => {
    const r = rec();
    const table = [
      row(1, 1, 30, "/Xcode/swift-frontend -c /w/a/File.swift -o /tmp/dd/A/x.o"),
      row(2, 500, 30, "clang -c /w/a/y.c"),
      row(3, 1, 30, "/Xcode/ld -o /tmp/dd/A/out"),
      row(4, 1, 30, "/Xcode/swift-frontend -c /w/b/File.swift"), // other job
      row(5, 1, 30, "/Xcode/swift-frontend -c /elsewhere/z.swift"), // unrelated
      row(6, 1, 9000, "/Xcode/swift-frontend -c /w/a/old.swift"), // orphan from before the window
      row(7, 1, 30, "vim /w/a/notes"),
    ];
    const pids = await reapJob(["/w/a", "/tmp/dd/A"], ["/w/b"], 60, { ...r, table });
    expect(pids).toEqual([1, 2, 3]);
    expect(r.sent.filter(([, s]) => s === "SIGTERM").map(([p]) => p)).toEqual([1, 2, 3]);
    expect(r.sent.filter(([, s]) => s === "SIGKILL").map(([p]) => p)).toEqual([3]);
  });

  it("does not touch a compiler that names another running job's path too", async () => {
    const r = rec();
    const table = [row(1, 1, 5, "swift-frontend /w/a/x.swift -I /w/b/mod")];
    expect(await reapJob(["/w/a"], ["/w/b"], 60, { ...r, table })).toEqual([]);
    expect(r.sent).toEqual([]);
  });

  it("sweeps old ppid-1 compilers that match no running job", async () => {
    const r = rec();
    const table = [
      row(1, 1, 600, "swift-frontend -c /w/dead/x.swift"),
      row(2, 1, 600, "swift-frontend -c /w/live/x.swift"),
      row(3, 1, 60, "swift-frontend -c /w/dead/young.swift"),
      row(4, 77, 600, "swift-frontend -c /w/dead/child.swift"),
      row(5, 1, 600, "/Xcode/SWBBuildService"),
    ];
    expect(await sweepOrphans(["/w/live"], { ...r, table })).toEqual([1]);
  });

  it("the gate reaps compilers left by a finished job", async () => {
    const r = rec();
    const table = [row(41, 1, 1, `swift-frontend -c ${process.cwd()}/x.swift`)];
    await runBuild({ ...base, dir, slots: 1, command: ["true"], reap: { ...r, table } });
    expect(r.sent[0]).toEqual([41, "SIGTERM"]);
  });
});
