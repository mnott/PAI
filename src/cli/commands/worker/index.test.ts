/**
 * Regression: the interactive picker launches a project with the argv from
 * workerRunArgv() — `worker run --label <label> --cwd <dir>` — and the run
 * command must parse that argv and run the worker in <dir> instead of dying
 * with "error: unknown option --cwd".
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";

const mocks = vi.hoisted(() => ({
  runWorker: vi.fn(),
  runChain: vi.fn(),
}));

vi.mock("../../../workers/run.js", () => ({ runWorker: mocks.runWorker }));
vi.mock("../../../workers/chain.js", () => ({ runChain: mocks.runChain }));

import { registerWorkerCommands } from "./index.js";
import { workerRunArgv } from "../../lib/launch.js";

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
