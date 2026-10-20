import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { inVisiblePane } from "./pane.js";
import { openOwnedPane, runPaneExec } from "../../workers/pane-exec.js";
import { runInPane } from "../../workers/pane-run.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pai-nested-"));
  vi.stubEnv("PAI_HOME", join(dir, "home"));
  vi.stubEnv("PAI_WORKER_ALLOW_HIDDEN", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("a process started inside a pane gets its own pane", () => {
  it("the launcher's direct child is already in its pane", () => {
    expect(inVisiblePane({ PAI_PANE_EXEC: "r1", PAI_PANE_EXEC_PID: "4242" }, 4242)).toBe(true);
  });

  it("a grandchild (other parent) is not, even inside a worker or a pane run", () => {
    expect(inVisiblePane({ PAI_PANE_EXEC: "r1", PAI_PANE_EXEC_PID: "4242" }, 9999)).toBe(false);
    expect(inVisiblePane({ PAI_PANE_EXEC: "r1", PAI_PANE_EXEC_PID: "4242", PAI_WORKER: "1", PAI_PANE_RUN: "1" }, 9999)).toBe(false);
    expect(inVisiblePane({ PAI_PANE_EXEC: "r1" }, 9999)).toBe(false);
  });

  it("without a launcher the worker / pane-run markers still count", () => {
    expect(inVisiblePane({ PAI_WORKER: "1" }, 1)).toBe(true);
    expect(inVisiblePane({ PAI_PANE_RUN: "1" }, 1)).toBe(true);
    expect(inVisiblePane({}, 1)).toBe(false);
  });

  it("the wrapper gives its child the new run-id and the wrapper's pid, replacing inherited values", async () => {
    const id = "t-nested-env";
    let wrapper: Promise<number> | undefined;
    const pane = await openOwnedPane({
      id,
      kind: "pane",
      open: async () => {
        wrapper = runPaneExec(id, { out: () => undefined, err: () => undefined, closePane: async () => undefined, proc: new EventEmitter() as NodeJS.Process, killGraceMs: 300 });
        return "fake";
      },
      helloMs: 5000,
    });
    const proc = await pane.start({
      argv: ["sh", "-c", "echo $PAI_PANE_EXEC $PAI_PANE_EXEC_PID"],
      env: { PATH: process.env.PATH, PAI_PANE_EXEC: "old-run", PAI_PANE_EXEC_PID: "1" },
    });
    let out = "";
    proc.stdout.on("data", (c: Buffer) => (out += c));
    await new Promise((r) => proc.on("close", r));
    await wrapper;
    expect(out.trim()).toBe(`${id} ${process.pid}`);
  }, 15_000);

  it("runInPane from a grandchild calls the launcher; the direct spawn drops the stale markers", async () => {
    const launch = vi.fn(async () => null);
    const base = { command: ["true"], logDir: join(dir, "logs"), out: () => undefined, err: () => undefined };
    await runInPane({ ...base, launch, env: { PATH: process.env.PATH, PAI_PANE_EXEC: "old", PAI_PANE_EXEC_PID: "1" } });
    expect(launch).toHaveBeenCalledTimes(1);
  }, 15_000);
});
