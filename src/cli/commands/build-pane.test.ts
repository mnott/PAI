import { afterEach, describe, expect, it, vi } from "vitest";

const { pane, build } = vi.hoisted(() => ({ pane: vi.fn(async () => 0), build: vi.fn(async () => 0) }));
vi.mock("./pane.js", async (orig) => ({ ...(await orig<typeof import("./pane.js")>()), runCommandInPane: pane }));
vi.mock("../../builds/gate.js", async (orig) => ({ ...(await orig<typeof import("../../builds/gate.js")>()), runBuild: build }));

import { buildCommand } from "./build.js";

const run = (name: "run" | "lock") => buildCommand.subcommands!.find((c) => c.name === name)!.run!({ args: {}, opts: {}, rest: ["make"], dryRun: false } as never);

afterEach(() => {
  vi.unstubAllEnvs();
  pane.mockClear();
  build.mockClear();
});

describe("pai build run/lock and the pane", () => {
  it.each(["run", "lock"] as const)("%s from a session goes through the pane", async (name) => {
    vi.stubEnv("PAI_WORKER", "");
    vi.stubEnv("PAI_PANE_RUN", "");
    vi.stubEnv("PAI_BUILD_TICKET", "");
    await run(name);
    expect(pane).toHaveBeenCalledTimes(1);
    expect(build).not.toHaveBeenCalled();
  });
  it("from a worker it runs directly", async () => {
    vi.stubEnv("PAI_WORKER", "1");
    await run("run");
    expect(pane).not.toHaveBeenCalled();
    expect(build).toHaveBeenCalledTimes(1);
  });
  it("inside a pane run it runs directly", async () => {
    vi.stubEnv("PAI_WORKER", "");
    vi.stubEnv("PAI_PANE_RUN", "1");
    await run("lock");
    expect(pane).not.toHaveBeenCalled();
    expect(build).toHaveBeenCalledTimes(1);
  });
});
