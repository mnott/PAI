import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as childProcess from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

import { clickrControlsArgv, clickrControlsReturnArgv, markControlsHeld, returnControlsIfHeld } from "./controls.js";
import { loadStatus, nowStamp, saveStatus, type WorkerStatus } from "./status.js";

describe("clickrControlsArgv", () => {
  it("you binds the grant to the worker id and, when known, its runner pid", () => {
    expect(clickrControlsArgv("w1", "you", 4242)).toEqual(["controls", "you", "--agent", "w1", "--pid", "4242"]);
  });

  it("you without a known pid omits --pid", () => {
    expect(clickrControlsArgv("w1", "you")).toEqual(["controls", "you", "--agent", "w1"]);
  });

  it("me has no target and ignores any pid", () => {
    expect(clickrControlsArgv("w1", "me", 4242)).toEqual(["controls", "me"]);
  });
});

describe("clickrControlsReturnArgv", () => {
  it("returns a worker's grant by id", () => {
    expect(clickrControlsReturnArgv("w1")).toEqual(["controls", "return", "--agent", "w1"]);
  });
});

function fakeStatus(id: string): WorkerStatus {
  return {
    id,
    pid: 4242,
    label: "x",
    cwd: "/tmp",
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
}

describe("markControlsHeld / returnControlsIfHeld", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    vi.mocked(childProcess.spawn).mockReset();
  });

  it("markControlsHeld persists the flag through saveStatus/loadStatus", () => {
    dir = mkdtempSync(join(tmpdir(), "pai-controls-"));
    saveStatus(dir, fakeStatus("w1"));
    expect(loadStatus(dir, "w1")?.controlsHeld).toBeUndefined();
    markControlsHeld(dir, "w1");
    expect(loadStatus(dir, "w1")?.controlsHeld).toBe(true);
  });

  it("markControlsHeld on an unknown id is a no-op, not a throw", () => {
    dir = mkdtempSync(join(tmpdir(), "pai-controls-"));
    expect(() => markControlsHeld(dir, "nope")).not.toThrow();
  });

  it("returnControlsIfHeld does nothing (never spawns) when the flag was never set", async () => {
    dir = mkdtempSync(join(tmpdir(), "pai-controls-"));
    saveStatus(dir, fakeStatus("w1"));
    await returnControlsIfHeld(dir, "w1");
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it("returnControlsIfHeld with no id is a no-op", async () => {
    dir = mkdtempSync(join(tmpdir(), "pai-controls-"));
    await returnControlsIfHeld(dir, undefined);
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it("returnControlsIfHeld spawns clickr controls return --agent <id> when the flag is set", async () => {
    dir = mkdtempSync(join(tmpdir(), "pai-controls-"));
    saveStatus(dir, fakeStatus("w1"));
    markControlsHeld(dir, "w1");
    const proc = new EventEmitter();
    vi.mocked(childProcess.spawn).mockReturnValue(proc as unknown as ReturnType<typeof childProcess.spawn>);
    const done = returnControlsIfHeld(dir, "w1");
    expect(childProcess.spawn).toHaveBeenCalledWith(
      "clickr",
      ["controls", "return", "--agent", "w1"],
      expect.objectContaining({ stdio: "ignore" })
    );
    proc.emit("close", 0);
    await done;
  });

  it("a missing clickr binary (spawn 'error') resolves without throwing", async () => {
    dir = mkdtempSync(join(tmpdir(), "pai-controls-"));
    saveStatus(dir, fakeStatus("w1"));
    markControlsHeld(dir, "w1");
    const proc = new EventEmitter();
    vi.mocked(childProcess.spawn).mockReturnValue(proc as unknown as ReturnType<typeof childProcess.spawn>);
    const done = returnControlsIfHeld(dir, "w1");
    proc.emit("error", new Error("ENOENT"));
    await expect(done).resolves.toBeUndefined();
  });
});
