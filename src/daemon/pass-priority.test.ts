import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

// A scripted child: the real spawn (taskpolicy -b + nice 19 + node start) outlasts
// vitest's 5s timeout when the full suite saturates the CPUs.
vi.mock("node:child_process", async (orig) => ({
  ...(await orig<typeof import("node:child_process")>()),
  spawn: () => {
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => child.emit("close", 1, null));
    return child;
  },
}));
import { buildPassCommand, runPassChild } from "./pass-priority.js";

const all = () => true;
const none = () => false;

describe("buildPassCommand", () => {
  it("darwin: taskpolicy -b + nice 19", () => {
    expect(buildPassCommand("darwin", "/n", "/e", ["memory", "pass", "embed"], all)).toEqual({
      cmd: "taskpolicy",
      args: ["-b", "nice", "-n", "19", "/n", "/e", "memory", "pass", "embed"],
    });
  });
  it("darwin without taskpolicy: plain nice 19", () => {
    expect(buildPassCommand("darwin", "/n", "/e", ["x"], none)).toEqual({
      cmd: "nice",
      args: ["-n", "19", "/n", "/e", "x"],
    });
  });
  it("linux: nice 19 + ionice -c3", () => {
    expect(buildPassCommand("linux", "/n", "/e", ["x"], all)).toEqual({
      cmd: "nice",
      args: ["-n", "19", "ionice", "-c3", "/n", "/e", "x"],
    });
  });
  it("linux without ionice: plain nice 19", () => {
    expect(buildPassCommand("linux", "/n", "/e", ["x"], none).args).toEqual(["-n", "19", "/n", "/e", "x"]);
  });
});

describe("runPassChild", () => {
  it("rejects when the child cannot report", async () => {
    // The scripted child exits 1 without a JSON line.
    await expect(runPassChild("noop")).rejects.toThrow(/pass child noop exited|cannot spawn/);
  });
});

describe("config", () => {
  it("passPriority defaults to background", async () => {
    const { defaults } = await import("./config.js");
    expect(defaults().passPriority).toBe("background");
  });
});
