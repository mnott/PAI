/**
 * Priority and pause of a worker's engine requests: the status fields, the
 * ledger lines, the router's live reader, and the CLI / MCP arguments.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GROUPS } from "../cli/registry.js";
import { runCli, type Io } from "../cli/run.js";
import { makeStyle } from "../cli/help.js";
import { engineControlReader, parseEnginePriority, setWorkerPaused, setWorkerPriority } from "./engine-control.js";
import { parseLedger } from "./ledger.js";
import { ledgerPath, statusPath } from "./paths.js";
import { loadStatus, saveStatus, type WorkerStatus } from "./status.js";
import { workerRunShape } from "../daemon-mcp/tools/worker-run-args.js";

let dir: string;
let home: string;
let logDir: string;
const saved = { home: process.env.PAI_HOME, yaml: process.env.PAI_WORKERS_YAML };
let written: string[];
let errs: string[];
const io: Io = { out: (s) => written.push(s), err: (s) => errs.push(s), style: makeStyle(false) };

const status = (id: string, over: Partial<WorkerStatus> = {}): WorkerStatus =>
  ({ id, pid: process.pid, label: "job", cwd: "/", term: "", provider: "gyro-m", model: "m", state: "running", started: "2026-01-01 00:00:00", updated: "", turns: 0, tools: 0, last: "", rc: null, secs: null, ...over }) as WorkerStatus;
const ledger = () => parseLedger(readFileSync(ledgerPath(logDir), "utf8"));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pai-engctl-"));
  home = join(dir, "home");
  logDir = join(home, "logs", "workers");
  mkdirSync(logDir, { recursive: true });
  process.env.PAI_HOME = home;
  process.env.PAI_WORKERS_YAML = join(dir, "workers.yaml");
  writeFileSync(process.env.PAI_WORKERS_YAML, "providers: {}\n");
  written = [];
  errs = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => (written.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => (errs.push(String(s)), true));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of [["PAI_HOME", saved.home], ["PAI_WORKERS_YAML", saved.yaml]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("status fields and ledger", () => {
  it("priority and pause are stored in the status and survive the runner's own periodic save", () => {
    const s = status("w1");
    saveStatus(logDir, s); // the runner's first write (baseline)
    expect(setWorkerPriority(logDir, "w1", "low")).toBe("normal");
    expect(setWorkerPaused(logDir, "w1", true)).toBe(true);
    expect(setWorkerPaused(logDir, "w1", true)).toBe(false); // already paused: no second line
    saveStatus(logDir, s); // the runner's stale in-memory copy
    expect(loadStatus(logDir, "w1")).toMatchObject({ priority: "low", paused: true });
  });

  it("writes one ledger line per priority change, pause and resume", () => {
    saveStatus(logDir, status("w1"));
    setWorkerPriority(logDir, "w1", "high", "cockpit");
    setWorkerPaused(logDir, "w1", true);
    setWorkerPaused(logDir, "w1", false);
    expect(ledger().map((l) => [l.event, l.fields.id, l.fields.who, l.fields.from, l.fields.to])).toEqual([
      ["WORKER-PRIORITY", "w1", "cockpit", "normal", "high"],
      ["WORKER-PAUSE", "w1", "cli", undefined, undefined],
      ["WORKER-RESUME", "w1", "cli", undefined, undefined],
    ]);
  });

  it("refuses an unknown worker, a bad level and the pause of a finished worker", () => {
    expect(() => setWorkerPriority(logDir, "nope", "low")).toThrow(/no worker named/);
    expect(() => parseEnginePriority("urgent")).toThrow(/high, normal or low/);
    saveStatus(logDir, status("done1", { state: "done" }));
    expect(() => setWorkerPaused(logDir, "done1", true)).toThrow(/only a running worker/);
  });
});

describe("the router's reader", () => {
  it("reads the current value for every call: a live change applies to the next request", () => {
    saveStatus(logDir, status("w1"));
    const read = engineControlReader(() => logDir);
    expect(read("w1")).toEqual({ priority: "normal", paused: false });
    setWorkerPriority(logDir, "w1", "low");
    expect(read("w1")).toEqual({ priority: "low", paused: false });
    setWorkerPaused(logDir, "w1", true);
    // make the rewrite visible to a coarse-mtime filesystem too (size differs anyway)
    const p = statusPath(logDir, "w1");
    utimesSync(p, new Date(), new Date(Date.now() + 5000));
    expect(read("w1")).toEqual({ priority: "low", paused: true });
    setWorkerPaused(logDir, "w1", false);
    expect(read("w1").paused).toBe(false);
  });

  it("an unknown worker reads as the header hint or normal; a finished paused worker never parks", () => {
    const read = engineControlReader(() => logDir);
    expect(read("conn:1234")).toEqual({ priority: "normal", paused: false });
    expect(read("conn:1234", "high")).toEqual({ priority: "high", paused: false });
    saveStatus(logDir, status("w2", { paused: true, state: "killed" }));
    expect(read("w2").paused).toBe(false);
  });
});

describe("CLI", () => {
  it("pai worker priority <id> <level>, pause <id>, resume <id>", async () => {
    saveStatus(logDir, status("w1"));
    expect(await runCli(GROUPS, ["worker", "priority", "w1", "low"], io)).toBe(0);
    expect(written.join("")).toContain("w1: normal -> low");
    expect(await runCli(GROUPS, ["worker", "pause", "w1"], io)).toBe(0);
    expect(loadStatus(logDir, "w1")).toMatchObject({ priority: "low", paused: true });
    expect(await runCli(GROUPS, ["worker", "resume", "w1"], io)).toBe(0);
    expect(loadStatus(logDir, "w1")!.paused).toBe(false);
    expect(written.join("")).toContain("w1: resumed");
  });

  it("a bad level or an unknown worker is an error, the session subcommands still work", async () => {
    saveStatus(logDir, status("w1"));
    expect(await runCli(GROUPS, ["worker", "priority", "w1", "urgent"], io)).not.toBe(0);
    expect(await runCli(GROUPS, ["worker", "priority", "ghost", "low"], io)).not.toBe(0);
    expect(await runCli(GROUPS, ["worker", "priority", "list"], io)).toBe(0);
    expect(await runCli(GROUPS, ["worker", "pause", "ghost"], io)).not.toBe(0);
  });

  it("run --priority is declared for the engine as well as the capacity queue", () => {
    const worker = GROUPS.flatMap((g) => g.commands).find((c) => c.name === "worker")!;
    const run = worker.subcommands!.find((c) => c.name === "run")!;
    expect(run.options!.find((o) => o.name === "priority")!.summary).toMatch(/engine is shared/);
    expect(worker.subcommands!.map((c) => c.name)).toContain("pause");
  });
});

describe("MCP", () => {
  it("worker_run takes a priority of high, normal or low only", () => {
    expect(workerRunShape.priority.safeParse("low").success).toBe(true);
    expect(workerRunShape.priority.safeParse(undefined).success).toBe(true);
    expect(workerRunShape.priority.safeParse("urgent").success).toBe(false);
  });
});
