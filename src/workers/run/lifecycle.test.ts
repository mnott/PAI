import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  spawnOwned: vi.fn(),
  runGates: vi.fn(),
  reapRunTree: vi.fn(async () => undefined),
}));

vi.mock("./pane-handles.js", async (orig) => ({
  ...(await orig<typeof import("./pane-handles.js")>()),
  spawnOwned: hoisted.spawnOwned,
  announcePane: vi.fn(async () => undefined),
  requireVisiblePane: vi.fn(async () => true),
}));
vi.mock("./gate.js", async (orig) => ({ ...(await orig<typeof import("./gate.js")>()), runGates: hoisted.runGates }));
vi.mock("./lifecycle.js", () => ({ reapRunTree: hoisted.reapRunTree }));
vi.mock("../pane.js", async (orig) => ({
  ...(await orig<typeof import("../pane.js")>()),
  resolveHostSession: vi.fn(async () => ({ term: "test-term" })),
}));
vi.mock("../../builds/queue.js", async (orig) => ({
  ...(await orig<typeof import("../../builds/queue.js")>()),
  releaseBuildsOf: vi.fn(async () => []),
}));

import { foldRun } from "./execute-fold.js";
import { prepareRun, newRunState, type PreparedRun } from "./execute-prepare.js";
import { executeCodexRun } from "./execute.js";
import { loadStatus } from "../status.js";
import type { CodexArgs, ExecuteArgs } from "./types.js";

let root: string;
let logDir: string;
const exits: number[] = [];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "lifecycle-")));
  logDir = join(root, "logs");
  mkdirSync(logDir, { recursive: true });
  exits.length = 0;
  hoisted.spawnOwned.mockReset();
  hoisted.runGates.mockReset();
  hoisted.reapRunTree.mockClear();
  vi.spyOn(process, "exit").mockImplementation(((c?: number) => {
    exits.push(c ?? 0);
    return undefined as never;
  }) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.removeAllListeners(sig);
  rmSync(root, { recursive: true, force: true });
});

const fakeProc = (stdout: PassThrough | null = null) => Object.assign(new EventEmitter(), { pid: 999999, kill: vi.fn(), stdin: null, stdout, stderr: null });

function args(over: Record<string, unknown> = {}): ExecuteArgs {
  return {
    config: { routing: {} },
    logDir,
    target: { providerName: "stub", provider: {}, via: "flag" },
    model: "m",
    label: "lc",
    parsed: { headless: false, prompt: null, outputFormat: "text", allowedTools: [], mcp: [], rest: [], callerSystemPrompts: [] },
    claudeArgs: [],
    reroutes: 0,
    reportFormat: "ag2",
    limit: null,
    noBrowser: false,
    opts: {},
    ...over,
  } as unknown as ExecuteArgs;
}

function prepared(over: Record<string, unknown> = {}): PreparedRun {
  return {
    headless: false,
    wid: "w-lc",
    adopted: null,
    cwd: root,
    term: "t",
    paneVerified: false,
    session: null,
    sessionKey: undefined,
    spawnerSession: null,
    worktree: null,
    preamble: null,
    addendum: null,
    trailerApplied: false,
    env: {},
    claudeCmd: ["claude"],
    cmd: ["claude"],
    chromeArgs: [],
    mcpArgs: [],
    toolArgs: [],
    toolsFlag: [],
    slimArgs: [],
    promptText: null,
    state: newRunState(),
    ...over,
  } as unknown as PreparedRun;
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe("run lifecycle: claude engine", () => {
  it("a process error ends like a normal exit: status failed with the error, tree reaped, signal handlers removed", async () => {
    const proc = fakeProc();
    hoisted.spawnOwned.mockResolvedValue(proc);
    const before = process.listenerCount("SIGTERM");
    const run = foldRun(args(), prepared());
    const caught = run.catch((e: Error) => e);
    await tick();
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    proc.emit("error", new Error("spawn claude ENOENT"));
    const err = await caught;
    expect((err as Error).message).toContain("ENOENT");
    const st = loadStatus(logDir, "w-lc");
    expect(st?.state).toBe("failed");
    expect(st?.last).toContain("ENOENT");
    expect(hoisted.reapRunTree).toHaveBeenCalledTimes(1);
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });

  it("records requested_model / model_fallback from the step-down in the status", async () => {
    hoisted.spawnOwned.mockRejectedValue(new Error("no pane"));
    const modelRecord = { requestedModel: "big", modelFallback: true, modelFallbackReason: "stepped down" };
    await expect(foldRun(args({ model: "small", modelRecord }), prepared())).rejects.toThrow("no pane");
    expect(loadStatus(logDir, "w-lc")).toMatchObject({ model: "small", ...modelRecord });
  });

  it("a spawn rejection is cleaned up the same way", async () => {
    hoisted.spawnOwned.mockRejectedValue(new Error("no pane"));
    await expect(foldRun(args(), prepared())).rejects.toThrow("no pane");
    expect(loadStatus(logDir, "w-lc")?.state).toBe("failed");
    expect(hoisted.reapRunTree).toHaveBeenCalledTimes(1);
  });

  it("a signal while the gates still block reaps the run tree and exits 143", async () => {
    hoisted.runGates.mockReturnValue(new Promise(() => undefined));
    void foldRun(args({ parsed: { ...args().parsed, headless: true } }), prepared({ headless: true }));
    await tick();
    process.emit("SIGTERM");
    await tick();
    expect(loadStatus(logDir, "w-lc")?.state).toBe("killed");
    expect(hoisted.reapRunTree).toHaveBeenCalledTimes(1);
    expect(exits).toContain(143);
  });

  it("a signal after the spawn kills the child and reaps the tree", async () => {
    const proc = fakeProc();
    hoisted.spawnOwned.mockResolvedValue(proc);
    void foldRun(args(), prepared());
    await tick();
    process.emit("SIGINT");
    await tick();
    expect(proc.kill).toHaveBeenCalled();
    expect(hoisted.reapRunTree).toHaveBeenCalledTimes(1);
    expect(exits).toContain(143);
  });
});

describe("run lifecycle: codex engine", () => {
  const codexArgs = (): CodexArgs =>
    args({ parsed: { headless: true, prompt: "do it", outputFormat: "text", allowedTools: ["Read"], mcp: [], rest: [], callerSystemPrompts: [] }, worktreeFlag: false, id: "w-cx", cwd: root, target: { providerName: "stub", provider: { env: {} }, via: "flag" } }) as unknown as CodexArgs;

  it("codex missing from PATH (process error) ends failed, reaped, events fd closed", async () => {
    const proc = fakeProc(new PassThrough());
    hoisted.spawnOwned.mockResolvedValue(proc);
    const before = process.listenerCount("SIGTERM");
    const caught = executeCodexRun(codexArgs()).catch((e: Error) => e);    await tick();
    await tick();
    proc.emit("error", new Error("spawn codex ENOENT"));
    const err = await caught;
    expect((err as Error).message).toContain("ENOENT");
    const st = loadStatus(logDir, "w-cx");
    expect(st?.state).toBe("failed");
    expect(st?.last).toContain("ENOENT");
    expect(hoisted.reapRunTree).toHaveBeenCalledTimes(1);
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });

  it("a signal reaps the codex tree", async () => {
    const proc = fakeProc(new PassThrough());
    hoisted.spawnOwned.mockResolvedValue(proc);
    void executeCodexRun(codexArgs()).catch(() => undefined);
    await tick();
    await tick();
    process.emit("SIGHUP");
    await tick();
    expect(proc.kill).toHaveBeenCalled();
    expect(hoisted.reapRunTree).toHaveBeenCalledTimes(1);
    expect(exits).toContain(143);
  });
});

describe("run lifecycle: prepare", () => {
  function repo(): string {
    const dir = join(root, "repo");
    mkdirSync(dir);
    const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" });
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(dir, "f"), "x");
    git("add", "f");
    git("commit", "-qm", "init");
    return dir;
  }

  it("an unknown --mcp name fails before any worktree is created", async () => {
    const dir = repo();
    const a = args({
      cwd: dir,
      mcpFlag: "no-such-mcp-server",
      target: { providerName: "stub", provider: { native: true }, via: "flag" },
      parsed: { headless: true, prompt: "p", outputFormat: "text", allowedTools: ["Edit"], mcp: [], rest: [], callerSystemPrompts: [], callerMcpConfig: undefined },
      config: { routing: {}, mcpSets: {} },
    });
    await expect(prepareRun(a)).rejects.toThrow();
    const wt = execFileSync("git", ["-C", dir, "worktree", "list"]).toString().trim().split("\n");
    expect(wt).toHaveLength(1);
    expect(existsSync(join(logDir, "worktrees"))).toBe(false);
  });
});
