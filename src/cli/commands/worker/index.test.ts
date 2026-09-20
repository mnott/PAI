/**
 * Regression: the interactive picker launches a project with the argv from
 * workerRunArgv() — `worker run --label <label> --cwd <dir>` — and the run
 * command must parse that argv and run the worker in <dir> instead of dying
 * with "error: unknown option --cwd".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";

const mocks = vi.hoisted(() => ({
  runWorker: vi.fn(),
  runChain: vi.fn(),
  logDir: "",
}));

vi.mock("../../../workers/run.js", () => ({ runWorker: mocks.runWorker }));
vi.mock("../../../workers/chain.js", () => ({ runChain: mocks.runChain }));
vi.mock("../../../workers/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../workers/config.js")>();
  return {
    ...actual,
    readWorkersSection: () => ({
      raw: {},
      workers: { ...actual.parseWorkersConfig(undefined), logDir: mocks.logDir },
    }),
  };
});

import { registerWorkerCommands } from "./index.js";
import { workerRunArgv } from "../../lib/launch.js";
import { loadStatus, saveStatus, nowStamp, type WorkerStatus } from "../../../workers/status.js";

function buildCli(): Command {
  const pai = new Command();
  pai.name("pai").exitOverride();
  const worker = pai.command("worker").description("test harness");
  registerWorkerCommands(worker);
  return pai;
}

describe("worker run --cwd", () => {
  afterEach(() => {
    vi.clearAllMocks();
    process.exitCode = 0;
  });

  it("parses the picker's exact workerRunArgv and runs the worker in that directory", async () => {
    mocks.runWorker.mockResolvedValue(0);
    const dir = mkdtempSync(join(tmpdir(), "pai-worker-cwd-"));
    try {
      const argv = workerRunArgv("fix login timeout", dir);
      await buildCli().parseAsync(["node", "pai", ...argv]);
      expect(mocks.runWorker).toHaveBeenCalledTimes(1);
      const opts = mocks.runWorker.mock.calls[0][0];
      expect(opts.cwd).toBe(dir);
      expect(opts.label).toBe("fix login timeout");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("rejects a --cwd that does not exist, clearly, before spawning anything", async () => {
    await buildCli().parseAsync([
      "node",
      "pai",
      "worker",
      "run",
      "--label",
      "x",
      "--cwd",
      "/definitely/not/a/real/dir",
    ]);
    expect(mocks.runWorker).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("without --cwd the run defaults to this process's cwd", async () => {
    mocks.runWorker.mockResolvedValue(0);
    await buildCli().parseAsync(["node", "pai", "worker", "run", "--label", "x"]);
    expect(mocks.runWorker).toHaveBeenCalledTimes(1);
    expect(mocks.runWorker.mock.calls[0][0].cwd).toBeUndefined();
  });
});

describe("worker run --label is optional, derived from the prompt", () => {
  afterEach(() => {
    vi.clearAllMocks();
    process.exitCode = 0;
  });

  it("derives the label from the prompt's first line when --label is missing", async () => {
    mocks.runWorker.mockResolvedValue(0);
    await buildCli().parseAsync(["node", "pai", "worker", "run", "-p", "Reply with exactly one word: pong."]);
    expect(mocks.runWorker).toHaveBeenCalledTimes(1);
    expect(process.exitCode).not.toBe(2);
    expect(mocks.runWorker.mock.calls[0][0].label).toBe("Reply with exactly one word: pong.");
  });

  it("derives the label when --label is given but empty", async () => {
    mocks.runWorker.mockResolvedValue(0);
    await buildCli().parseAsync(["node", "pai", "worker", "run", "--label", "", "-p", "print OK"]);
    expect(mocks.runWorker).toHaveBeenCalledTimes(1);
    expect(process.exitCode).not.toBe(2);
    expect(mocks.runWorker.mock.calls[0][0].label).toBe("print OK");
  });

  it("an explicit --label wins verbatim over the derived one", async () => {
    mocks.runWorker.mockResolvedValue(0);
    await buildCli().parseAsync([
      "node", "pai", "worker", "run", "--label", "my exact label", "-p", "some other first line",
    ]);
    expect(mocks.runWorker).toHaveBeenCalledTimes(1);
    expect(mocks.runWorker.mock.calls[0][0].label).toBe("my exact label");
  });

  it("does not require --label when --chain is used (the chain labels its own stages)", async () => {
    mocks.runChain.mockResolvedValue(0);
    await buildCli().parseAsync([
      "node", "pai", "worker", "run", "--chain", "draft,implement", "-p", "add a thing",
    ]);
    expect(mocks.runChain).toHaveBeenCalledTimes(1);
    expect(process.exitCode).not.toBe(2);
  });
});

describe("worker run --spec", () => {
  let dir: string;

  afterEach(() => {
    vi.clearAllMocks();
    process.exitCode = 0;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("reads the prompt from the file, byte-for-byte, and passes it as -p", async () => {
    mocks.runWorker.mockResolvedValue(0);
    dir = mkdtempSync(join(tmpdir(), "pai-worker-spec-"));
    const specPath = join(dir, "spec.txt");
    const content = "line one\nline two\nline three\n";
    writeFileSync(specPath, content, "utf8");
    await buildCli().parseAsync([
      "node", "pai", "worker", "run", "--label", "spec probe", "--spec", specPath,
    ]);
    expect(mocks.runWorker).toHaveBeenCalledTimes(1);
    const opts = mocks.runWorker.mock.calls[0][0];
    expect(opts.claudeArgs).toEqual(["-p", content]);
    expect(opts.specPath).toBe(specPath);
  });

  it("errors naming the path when the spec file does not exist", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    dir = mkdtempSync(join(tmpdir(), "pai-worker-spec-"));
    const missing = join(dir, "missing.txt");
    await buildCli().parseAsync([
      "node", "pai", "worker", "run", "--label", "x", "--spec", missing,
    ]);
    expect(mocks.runWorker).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes(missing))).toBe(true);
    errSpy.mockRestore();
  });

  it("errors naming the path when the spec file is empty", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    dir = mkdtempSync(join(tmpdir(), "pai-worker-spec-"));
    const empty = join(dir, "empty.txt");
    writeFileSync(empty, "", "utf8");
    await buildCli().parseAsync([
      "node", "pai", "worker", "run", "--label", "x", "--spec", empty,
    ]);
    expect(mocks.runWorker).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes(empty))).toBe(true);
    errSpy.mockRestore();
  });

  it("errors when --spec and -p are both given", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    dir = mkdtempSync(join(tmpdir(), "pai-worker-spec-"));
    const specPath = join(dir, "spec.txt");
    writeFileSync(specPath, "content", "utf8");
    await buildCli().parseAsync([
      "node", "pai", "worker", "run", "--label", "x", "--spec", specPath, "-p", "also inline",
    ]);
    expect(mocks.runWorker).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(
      errSpy.mock.calls.some((c) => String(c[0]).includes("mutually exclusive"))
    ).toBe(true);
    errSpy.mockRestore();
  });
});

describe("worker run: long inline -p hint", () => {
  afterEach(() => {
    vi.clearAllMocks();
    process.exitCode = 0;
  });

  it("prints a stderr hint (not an error) for a long inline prompt, and still runs", async () => {
    mocks.runWorker.mockResolvedValue(0);
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const longPrompt = "print OK. " + "x".repeat(650);
    await buildCli().parseAsync([
      "node", "pai", "worker", "run", "--label", "hint probe", "-p", longPrompt,
    ]);
    expect(mocks.runWorker).toHaveBeenCalledTimes(1);
    expect(process.exitCode).not.toBe(1);
    expect(process.exitCode).not.toBe(2);
    expect(
      errSpy.mock.calls.some((c) =>
        String(c[0]).includes("hint: long inline prompts break on shell quoting")
      )
    ).toBe(true);
    errSpy.mockRestore();
  });

  it("no hint for a short inline prompt", async () => {
    mocks.runWorker.mockResolvedValue(0);
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await buildCli().parseAsync(["node", "pai", "worker", "run", "--label", "short", "-p", "print OK"]);
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe("worker kill: reused-pid protection", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pai-worker-kill-"));
    mocks.logDir = dir;
  });

  afterEach(() => {
    vi.clearAllMocks();
    process.exitCode = 0;
    rmSync(dir, { recursive: true, force: true });
  });

  it("marks a stale/reused pid lost and signals nothing", async () => {
    const status: WorkerStatus = {
      id: "kill-test",
      pid: 999999,
      label: "x",
      cwd: dir,
      term: "",
      provider: "anthropic",
      model: "sonnet",
      state: "running",
      started: nowStamp(),
      updated: nowStamp(),
      turns: 0,
      tools: 0,
      last: "",
      rc: null,
      secs: null,
    };
    saveStatus(dir, status);
    // pid 999999 does not exist, so ownsPid's own alive() check already
    // returns false — this spy only proves the real SIGTERM (not the
    // liveness-probe signal 0) was never sent.
    const killSpy = vi.spyOn(process, "kill");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await buildCli().parseAsync(["node", "pai", "worker", "kill", "kill-test"]);
    expect(killSpy.mock.calls.some((c) => c[1] === "SIGTERM")).toBe(false);
    const after = loadStatus(dir, "kill-test");
    expect(after?.state).toBe("lost");
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes("marked lost"))).toBe(true);
    killSpy.mockRestore();
    logSpy.mockRestore();
  });
});
