/**
 * Tests for the follow exit decision. Pure functions; no claude, no osascript.
 */

import { describe, it, expect } from "vitest";
import { workerEnded } from "./viewer.js";

describe("workerEnded", () => {
  it("ends once the result event was rendered, whatever the status says", () => {
    expect(workerEnded(true, "running", true)).toBe(true);
    expect(workerEnded(true, undefined, true)).toBe(true);
    expect(workerEnded(true, "done", false)).toBe(true);
  });

  it("ends when the status left running and the pid is gone (killed without a result)", () => {
    expect(workerEnded(false, "done", false)).toBe(true);
    expect(workerEnded(false, "failed", false)).toBe(true);
    expect(workerEnded(false, "killed", false)).toBe(true);
    expect(workerEnded(false, "lost", false)).toBe(true);
  });

  it("keeps following while the worker runs, or its pid lives on", () => {
    expect(workerEnded(false, "running", true)).toBe(false);
    expect(workerEnded(false, "done", true)).toBe(false); // zombie status, live pid
  });

  it("keeps following when no status was ever read", () => {
    expect(workerEnded(false, undefined, false)).toBe(false);
    expect(workerEnded(false, undefined, true)).toBe(false);
  });
});
