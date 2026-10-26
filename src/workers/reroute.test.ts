import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { continuedNote, escalateOverdue, escalationReason, providerPinned, rerouteWorker, reroutePolicy, type RerouteDeps } from "./reroute.js";
import { loadStatus, saveStatus, nowStamp, type WorkerStatus } from "./status.js";
import { runSupervisionTick } from "./supervision.js";

const NOW = Date.parse("2026-10-24T12:00:00");
const ago = (min: number): string => nowStamp(new Date(NOW - min * 60_000));
const POLICY = { queuedMaxMin: 15, stallMaxMin: 10, stallFailedCalls: 6 };

let dir: string;
let promptFile: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reroute-"));
  promptFile = join(dir, "w1.prompt");
  writeFileSync(promptFile, "Do the thing.", "utf8");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const mkStatus = (over: Partial<WorkerStatus> = {}): WorkerStatus =>
  ({
    id: "w1", pid: 1, label: "fix it", cwd: "/repo", term: "", provider: "coder-l", model: "m", state: "running",
    started: ago(1), updated: ago(0), turns: 1, tools: 1, last: "", rc: null, secs: null, promptFile,
    routeWhy: "coder-l/m (routing policy: prefer-local)", ...over,
  }) as WorkerStatus;

const seams = (over: Partial<RerouteDeps> = {}) => {
  const kill = vi.fn().mockResolvedValue([]);
  const spawn = vi.fn();
  const resolve = vi.fn().mockResolvedValue({ provider: "anthropic", model: "sonnet", description: "cloud: anthropic sonnet" });
  return { kill, spawn, resolve, deps: { logDir: dir, kill, spawn, resolve, announceMs: 0, ...over } satisfies RerouteDeps };
};

describe("rerouteWorker", () => {
  it("queued: stops the waiting process, starts the same task on the target, no branch note", async () => {
    saveStatus(dir, mkStatus({ state: "queued" }));
    const s = seams();
    const r = await rerouteWorker("w1", "cloud", s.deps);
    expect(s.resolve).toHaveBeenCalledWith("cloud");
    expect(s.kill).toHaveBeenCalledWith("w1", expect.stringContaining("rerouted to anthropic"));
    expect(s.spawn).toHaveBeenCalledTimes(1);
    const sp = s.spawn.mock.calls[0]![0];
    expect(sp).toMatchObject({ id: "w1", provider: "anthropic", model: "sonnet", why: "rerouted by reroute" });
    expect(readFileSync(sp.specFile, "utf8")).toBe("Do the thing.");
    expect(r).toMatchObject({ was: "queued", provider: "anthropic" });
    expect(r.branch).toBeUndefined();
    expect(loadStatus(dir, "w1")?.rerouted).toContain("anthropic");
  });

  it("running: kills first (salvage), then spawns with the continued-from note on the branch", async () => {
    saveStatus(dir, mkStatus({ branch: "worker/w1" }));
    const order: string[] = [];
    const s = seams({ kill: vi.fn(async () => void order.push("kill")), spawn: vi.fn(() => void order.push("spawn")) });
    const r = await rerouteWorker("w1", "cloud", s.deps);
    expect(order).toEqual(["kill", "spawn"]);
    const text = readFileSync(r.specFile, "utf8");
    expect(text.split("\n")[0]).toBe(continuedNote("w1", "worker/w1"));
    expect(text).toContain("continued from w1 on branch worker/w1");
    expect(text.endsWith("Do the thing.")).toBe(true);
    expect(r).toMatchObject({ was: "running", branch: "worker/w1" });
  });

  it("refuses a finished worker, the same provider and a missing task copy before stopping anything", async () => {
    const s = seams();
    saveStatus(dir, mkStatus({ state: "done" }));
    await expect(rerouteWorker("w1", "cloud", s.deps)).rejects.toThrow(/only a queued or running/);
    saveStatus(dir, mkStatus({ provider: "anthropic" }));
    await expect(rerouteWorker("w1", "cloud", s.deps)).rejects.toThrow(/already runs on anthropic/);
    saveStatus(dir, mkStatus({ promptFile: undefined }));
    await expect(rerouteWorker("w1", "cloud", s.deps)).rejects.toThrow(/kept no copy of its task/);
    await expect(rerouteWorker("nope", "cloud", s.deps)).rejects.toThrow(/no worker named/);
    expect(s.kill).not.toHaveBeenCalled();
    expect(s.spawn).not.toHaveBeenCalled();
  });
});

describe("escalationReason", () => {
  it("queued longer than queuedMaxMin", () => {
    expect(escalationReason(mkStatus({ state: "queued", started: ago(20) }), NOW, POLICY)).toBe("queued 20m");
    expect(escalationReason(mkStatus({ state: "queued", started: ago(14) }), NOW, POLICY)).toBeNull();
  });

  it("running without edit or commit for stallMaxMin; progress resets it", () => {
    expect(escalationReason(mkStatus({ started: ago(30) }), NOW, POLICY)).toBe("no edit or commit for 30m");
    expect(escalationReason(mkStatus({ started: ago(30), progressAt: ago(3) }), NOW, POLICY)).toBeNull();
    expect(escalationReason(mkStatus({ started: ago(5) }), NOW, POLICY)).toBeNull();
  });

  it("running with stallFailedCalls failed calls in a row", () => {
    expect(escalationReason(mkStatus({ consecFails: 6 }), NOW, POLICY)).toBe("6 failed tool calls in a row");
    expect(escalationReason(mkStatus({ consecFails: 5 }), NOW, POLICY)).toBeNull();
  });

  it("a pinned provider is never escalated", () => {
    for (const why of ["glm/m (flag: --provider)", "gyro/m (local)"]) {
      expect(providerPinned({ routeWhy: why })).toBe(true);
      expect(escalationReason(mkStatus({ state: "queued", started: ago(99), routeWhy: why }), NOW, POLICY)).toBeNull();
    }
    expect(providerPinned({ routeWhy: "glm/m (session profile fallback)" })).toBe(false);
  });

  it("a session-profile-routed job is not pinned: queued past queuedMaxMin it escalates", () => {
    const s = mkStatus({ state: "queued", started: ago(99), routeWhy: "glm/m (session profile)" });
    expect(providerPinned(s)).toBe(false);
    expect(escalationReason(s, NOW, POLICY)).toMatch(/^queued/);
  });

  it("an already rerouted, paused or task-less job is left alone", () => {
    const old = { state: "queued", started: ago(99) } as const;
    expect(escalationReason(mkStatus({ ...old, rerouted: "anthropic: queued 16m" }), NOW, POLICY)).toBeNull();
    expect(escalationReason(mkStatus({ ...old, paused: true }), NOW, POLICY)).toBeNull();
    expect(escalationReason(mkStatus({ ...old, promptFile: undefined }), NOW, POLICY)).toBeNull();
  });
});

describe("escalateOverdue", () => {
  it("reroutes an overdue job to the cloud once, however often the tick runs", async () => {
    saveStatus(dir, mkStatus({ state: "queued", started: ago(30), spawnerSession: "sess-1" }));
    const s = seams();
    const first = await escalateOverdue([loadStatus(dir, "w1")!], s.deps, NOW, POLICY);
    expect(first).toEqual([{ id: "w1", label: "fix it", provider: "anthropic", reason: "queued 30m", session: "sess-1" }]);
    expect(s.resolve).toHaveBeenCalledWith("cloud");
    const again = await escalateOverdue([loadStatus(dir, "w1")!], s.deps, NOW, POLICY);
    expect(again).toEqual([]);
    expect(s.spawn).toHaveBeenCalledTimes(1);
    expect(s.spawn.mock.calls[0]![0].why).toBe("rerouted by escalation: queued 30m");
  });

  it("a job already on the fallback is marked and not tried again", async () => {
    saveStatus(dir, mkStatus({ provider: "anthropic", started: ago(30) }));
    const s = seams();
    expect(await escalateOverdue([loadStatus(dir, "w1")!], s.deps, NOW, POLICY)).toEqual([]);
    expect(s.kill).not.toHaveBeenCalled();
    expect(loadStatus(dir, "w1")?.rerouted).toMatch(/^skipped/);
    await escalateOverdue([loadStatus(dir, "w1")!], s.deps, NOW, POLICY);
    expect(s.resolve).toHaveBeenCalledTimes(1);
  });

  it("the supervision tick escalates, tells the owner with one S message, and a second tick stays quiet", async () => {
    saveStatus(dir, mkStatus({ state: "queued", started: ago(30), spawnerSession: "sess-1", pid: process.pid }));
    const s = seams();
    const push = vi.fn().mockResolvedValue(true);
    const opts = { now: new Date(NOW), push, isAlive: () => true, rerouteDeps: s.deps, reroutePolicy: POLICY, pushPolicy: "all" as const };
    const r1 = await runSupervisionTick(dir, opts);
    const ev = r1.events.filter((e) => e.kind === "rerouted");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.text).toBe("S|i=w1|z=fix it: escalated to anthropic: queued 30m");
    const r2 = await runSupervisionTick(dir, opts);
    expect(r2.events.filter((e) => e.kind === "rerouted")).toHaveLength(0);
    expect(s.spawn).toHaveBeenCalledTimes(1);
  });
});

describe("the shared restart (rerunOn)", () => {
  it("starts the task on the target through the runner, ledgers it and links the old run", async () => {
    const { rerunOn } = await import("./run/escalate.js");
    const st = mkStatus();
    saveStatus(dir, st);
    const runner = vi.fn().mockImplementation(async (o: { onWorkerStart: (id: string) => void }) => (o.onWorkerStart("w2"), 0));
    const rc = await rerunOn({ logDir: dir, cwd: "/repo", label: "fix it", specPath: promptFile, claudeArgs: [], runner: runner as never }, "w1", "rerouted by cli", st, { provider: "anthropic", model: "sonnet" });
    expect(rc).toBe(0);
    expect(runner.mock.calls[0]![0]).toMatchObject({ providerFlag: "anthropic", modelFlag: "sonnet", label: "fix it (rerouted)", specPath: promptFile, _fallThroughOf: "w1", _priorIds: ["w1"] });
    expect(loadStatus(dir, "w1")?.fallThroughTo).toBe("w2");
    expect(readFileSync(join(dir, "ledger.log"), "utf8")).toMatch(/WORKER-FALLTHROUGH id=w1 reason=rerouted by cli to=anthropic/);
  });
});

describe("the default restart is headless", () => {
  it("passes -p <task> to rerunOn (without it the restart is an interactive launch that exits rc 1)", async () => {
    vi.resetModules();
    const rerunOn = vi.fn().mockResolvedValue(0);
    vi.doMock("./run/escalate.js", () => ({ rerunOn }));
    const { defaultSpawn } = await import("./reroute.js");
    const st = mkStatus();
    saveStatus(dir, st);
    defaultSpawn(dir)({ id: "w1", why: "rerouted by escalation", provider: "anthropic", specFile: promptFile });
    await vi.waitFor(() => expect(rerunOn).toHaveBeenCalled());
    expect(rerunOn.mock.calls[0]![0]).toMatchObject({ claudeArgs: ["-p", "Do the thing."], specPath: promptFile });
    vi.doUnmock("./run/escalate.js");
  });
});

describe("reroutePolicy", () => {
  it("defaults: queuedMaxMin 15, stallMaxMin 10, stallFailedCalls 6", () => {
    const old = process.env.PAI_CONFIG_FILE;
    process.env.PAI_CONFIG_FILE = join(dir, "none.yaml");
    try {
      expect(reroutePolicy()).toEqual({ queuedMaxMin: 15, stallMaxMin: 10, stallFailedCalls: 6 });
    } finally {
      if (old === undefined) delete process.env.PAI_CONFIG_FILE;
      else process.env.PAI_CONFIG_FILE = old;
    }
  });

  it("a user config.yaml workers.escalate overrides single keys", () => {
    const file = join(dir, "config.yaml");
    writeFileSync(file, "workers:\n  escalate:\n    queuedMaxMin: 5\n", "utf8");
    const old = process.env.PAI_CONFIG_FILE;
    process.env.PAI_CONFIG_FILE = file;
    try {
      expect(reroutePolicy()).toEqual({ queuedMaxMin: 5, stallMaxMin: 10, stallFailedCalls: 6 });
    } finally {
      if (old === undefined) delete process.env.PAI_CONFIG_FILE;
      else process.env.PAI_CONFIG_FILE = old;
    }
  });
});

describe("progress and queue-row helpers", () => {
  it("isProgressTool: Edit, Write and git commit count; reads and other Bash do not", async () => {
    const { isProgressTool } = await import("./run/stream.js");
    expect(isProgressTool("Edit", {})).toBe(true);
    expect(isProgressTool("Write", {})).toBe(true);
    expect(isProgressTool("Bash", { command: 'git add -A && git commit -m "x"' })).toBe(true);
    expect(isProgressTool("Bash", { command: "git -C /r commit -m x" })).toBe(true);
    expect(isProgressTool("Bash", { command: "git status" })).toBe(false);
    expect(isProgressTool("Read", {})).toBe(false);
  });

  it("queuedBarRow reads like the operator asked", async () => {
    const { queuedBarRow } = await import("./capacity.js");
    expect(queuedBarRow({ provider: "coder-l", position: 2, queued: 6, elapsedSec: 1500, held: 3, cap: 3 })).toBe("queued · position 2 of 6 · coder-l 3/3 · waited 25m");
    expect(queuedBarRow({ provider: "p", position: 1, queued: 1, elapsedSec: 30, priority: "high" })).toBe("queued · position 1 of 1 · p · waited 0m · high priority");
  });
});
