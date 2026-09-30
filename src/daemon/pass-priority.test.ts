import { describe, expect, it } from "vitest";
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
    // argv[1] in vitest points at no cli entry: the child exits non-zero without a JSON line.
    await expect(runPassChild("noop")).rejects.toThrow(/pass child noop exited|cannot spawn/);
  });
});

describe("config", () => {
  it("passPriority defaults to background", async () => {
    const { DEFAULTS } = await import("./config.js");
    expect(DEFAULTS.passPriority).toBe("background");
  });
});
