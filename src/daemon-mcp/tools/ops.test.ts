import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  daemonStatusCmd: vi.fn(async () => 0),
  daemonStartCmd: vi.fn(async () => { console.log("Started daemon pid 7"); return 0; }),
  daemonStopCmd: vi.fn(async () => { console.error("boom"); return 1; }),
  daemonRestartCmd: vi.fn(() => 0),
  routerStatusText: vi.fn(() => "router running (pid 1)"),
  routerStartText: vi.fn(() => "router starting"),
  routerStopText: vi.fn(() => "router stopped (pid 1)"),
  routerRestartText: vi.fn(async () => "router restarted"),
  runtimeStartStop: vi.fn(async () => ({ ok: true, message: "ollama up" })),
  defaultDeps: vi.fn(() => ({ home: "/h" })),
  stopMemoryRun: vi.fn(() => ({ ok: true, message: "stopping embed" })),
  memoryRunRefusal: vi.fn(async () => null as string | null),
  spawnMemoryRun: vi.fn(async () => ({ ok: true, message: "" })),
  writeLedgerLine: vi.fn(),
  fetchDaemonMemory: vi.fn(async () => ({ embedBacklog: 5 }) as { embedBacklog: number } | null),
  readRun: vi.fn(() => null),
  killWorker: vi.fn(async () => ["w-1: stopped"]),
  runWorkerGc: vi.fn(async (_d: string, _o: unknown, out: (s: string) => void) => out("0 archived")),
  poolStatusText: vi.fn(async () => "pool: enabled"),
  mergeWorker: vi.fn((_d: string, id: string, _o: unknown) => `merged ${id}`),
  readMergeVerify: vi.fn(() => "npx tsc --noEmit" as string | undefined),
  RelatedTestsFailedError: class RelatedTestsFailedError extends Error {},
  batteryCockpitLine: vi.fn(() => "18 % (battery) · local work paused"),
  readBatteryGate: vi.fn(() => ({ phase: "paused", reason: "battery at 18 %" }) as unknown),
  liveBenchmarkMarker: vi.fn(() => ({ pid: 9, label: "strata-bench" }) as unknown),
}));

vi.mock("../../cli/impl/daemon.js", () => m);
vi.mock("../../router/service-control.js", () => m);
vi.mock("../../router/cockpit-actions.js", () => m);
vi.mock("../../router/cockpit-memory.js", () => m);
vi.mock("../../memory/run-state.js", () => m);
vi.mock("../../workers/kill-tree.js", () => m);
vi.mock("../../workers/gc-run.js", () => m);
vi.mock("../../workers/pool-cli.js", () => m);
vi.mock("../../workers/worktree.js", () => m);
vi.mock("../../workers/workers-config.js", () => m);
vi.mock("../../daemon/battery-guard.js", () => m);
vi.mock("../../daemon/pass-priority.js", () => ({ cliEntry: () => "/dist/cli/index.mjs" }));
vi.mock("../../workers/config.js", () => ({ readWorkersSection: () => ({ workers: {} }) }));
vi.mock("../../workers/paths.js", () => ({ workersLogDir: () => "/logs" }));

import { batteryStatus, daemonService, memoryRun, modelRuntime, poolStatus, routerService, workerGc, workerKill, workerMerge } from "./ops.js";

const body = (r: { content: Array<{ text: string }> }): string => r.content[0]!.text;

beforeEach(() => vi.clearAllMocks());

describe("daemon_service", () => {
  it("start returns what the shared function printed", async () => {
    const r = await daemonService({ action: "start" });
    expect(m.daemonStartCmd).toHaveBeenCalledOnce();
    expect(body(r)).toBe("Started daemon pid 7");
  });
  it("a failing stop is an error carrying its output", async () => {
    const r = await daemonService({ action: "stop" });
    expect(r).toMatchObject({ isError: true });
    expect(body(r)).toBe("boom");
  });
  it("defaults to status", async () => {
    await daemonService({});
    expect(m.daemonStatusCmd).toHaveBeenCalledOnce();
  });
});

describe("router_service", () => {
  it("routes each action to the shared function with the cli entry", async () => {
    expect(body(await routerService({}))).toBe("router running (pid 1)");
    await routerService({ action: "start" });
    expect(m.routerStartText).toHaveBeenCalledWith("/dist/cli/index.mjs");
    expect(body(await routerService({ action: "stop" }))).toBe("router stopped (pid 1)");
    expect(body(await routerService({ action: "restart" }))).toBe("router restarted");
    expect(m.routerRestartText).toHaveBeenCalledWith("/dist/cli/index.mjs");
  });
});

describe("model_runtime", () => {
  it("start passes runtime, op and model", async () => {
    const r = await modelRuntime({ runtime: "ollama", action: "start", model: "e5" });
    expect(m.runtimeStartStop).toHaveBeenCalledWith("ollama", "start", { home: "/h" }, { model: "e5" });
    expect(body(r)).toBe("ollama up");
  });
  it("a refusal is an error", async () => {
    m.runtimeStartStop.mockResolvedValueOnce({ ok: false, message: "short memory" });
    expect(await modelRuntime({ runtime: "ollama", action: "stop" })).toMatchObject({ isError: true });
  });
  it("start needs a runtime", async () => {
    expect(await modelRuntime({ action: "start" })).toMatchObject({ isError: true });
    expect(m.runtimeStartStop).not.toHaveBeenCalled();
  });
});

describe("memory_run", () => {
  it("embed spawns the shared run after the duplicate guard", async () => {
    const r = await memoryRun({ action: "embed" });
    expect(m.memoryRunRefusal).toHaveBeenCalled();
    expect(m.spawnMemoryRun).toHaveBeenCalledWith("embed", "", "/h", undefined, "/dist/cli/index.mjs");
    expect(body(r)).toMatch(/embedding/);
  });
  it("embed with backlog 0 starts nothing", async () => {
    m.fetchDaemonMemory.mockResolvedValueOnce({ embedBacklog: 0 });
    expect(body(await memoryRun({ action: "embed" }))).toBe("nothing to embed (backlog 0)");
    expect(m.spawnMemoryRun).not.toHaveBeenCalled();
  });
  it("a running run refuses a second", async () => {
    m.memoryRunRefusal.mockResolvedValueOnce("index already running (started by cli, pid 3)");
    expect(await memoryRun({ action: "index" })).toMatchObject({ isError: true });
    expect(m.spawnMemoryRun).not.toHaveBeenCalled();
  });
  it("stop and status", async () => {
    expect(body(await memoryRun({ action: "stop" }))).toBe("stopping embed");
    expect(body(await memoryRun({}))).toBe("no memory run active; embed backlog 5");
  });
});

describe("worker_kill, worker_gc, pool_status", () => {
  it("kill forwards the options", async () => {
    const r = await workerKill({ id: "w-1", only: true, reason: "loop" });
    expect(m.killWorker).toHaveBeenCalledWith("/logs", "w-1", expect.objectContaining({ only: true, reason: "loop" }));
    expect(body(r)).toBe("w-1: stopped");
  });
  it("gc is a dry run unless dry_run=false", async () => {
    await workerGc({ foreign: true });
    expect(m.runWorkerGc.mock.calls[0]![1]).toMatchObject({ foreign: true, dryRun: true });
    await workerGc({ dry_run: false, all_finished: true });
    expect(m.runWorkerGc.mock.calls[1]![1]).toMatchObject({ allFinished: true, dryRun: false });
  });
  it("pool status", async () => {
    expect(body(await poolStatus())).toBe("pool: enabled");
  });
});

describe("worker_merge", () => {
  it("uses the configured verify default and the shared gates", async () => {
    expect(body(await workerMerge({ id: "w-1" }))).toBe("merged w-1");
    expect(m.mergeWorker).toHaveBeenLastCalledWith("/logs", "w-1", { noCommit: false, verify: "npx tsc --noEmit", verifyTests: true, rebuild: true });
  });
  it("flags skip the gates", async () => {
    await workerMerge({ id: "w-2", no_verify: true, no_verify_tests: true, no_build: true, no_commit: true });
    expect(m.mergeWorker).toHaveBeenLastCalledWith("/logs", "w-2", { noCommit: true, verify: undefined, verifyTests: false, rebuild: false });
  });
  it("a failed related-tests gate is an error that says the merge was kept", async () => {
    m.mergeWorker.mockImplementationOnce(() => { throw new m.RelatedTestsFailedError("failed: a.test.ts"); });
    const r = await workerMerge({ id: "w-3" });
    expect(r).toMatchObject({ isError: true });
    expect(body(r)).toMatch(/failed: a.test.ts[\s\S]*merge was kept/);
  });
});

describe("battery_status", () => {
  it("reports reading, gate and the benchmark marker", async () => {
    const t = body(await batteryStatus());
    expect(t).toMatch(/18 % \(battery\)/);
    expect(t).toMatch(/gate: paused — battery at 18 %/);
    expect(t).toMatch(/strata-bench \(pid 9\)/);
  });
});
