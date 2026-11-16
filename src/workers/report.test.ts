/**
 * Tests for the worker contract prompt — which class gets which opening block.
 * Guards the 2026-11-16 harness bug: an L1 started with `pai worker run --class orchestrate`
 * (no --orchestrate flag) got the implementation-worker opening and implemented everything
 * itself on its cloud model instead of cutting packages for local L2 implementers.
 */

import { describe, it, expect } from "vitest";
import { workerContractPrompt, ORCHESTRATOR_START_BLOCK, WORKER_CONTRACT_PROMPT } from "./report.js";

describe("workerContractPrompt — planner classes (orchestrate/plan without the flag)", () => {
  for (const cls of ["orchestrate", "plan"]) {
    it(`${cls} gets the L1 planner opening and starts L2 implementers`, () => {
      const p = workerContractPrompt(cls, "ag2");
      expect(p).toContain("L1 planner");
      expect(p).toContain("--class implement");
      expect(p).toContain("pai worker merge <id>");
      // the exact start/wait/merge commands reach it without the flag
      expect(p).toContain(ORCHESTRATOR_START_BLOCK);
    });
    it(`${cls} does not get the implementation-worker opening`, () => {
      const p = workerContractPrompt(cls, "ag2");
      expect(p).not.toContain("this task is yours to finish");
      expect(p).not.toContain("Never hand your whole task");
      expect(p).not.toContain("Child workers are for two things");
      // the rest of the full contract still applies
      expect(p).toContain("Answer it FIRST");
      expect(p).toContain("pai worker help");
      expect(p).toMatch(/heredoc/i);
      expect(p).toContain("AG2 `R` message");
    });
  }

  it("the --orchestrate flag path still appends ORCHESTRATOR_CONTRACT and now uses the planner opening too", () => {
    const p = workerContractPrompt("implement", "ag2", true);
    expect(p).toContain("Orchestrator mode");
    expect(p).toContain("L1 planner");
  });

  it("class implement without the flag is unchanged (implementation-worker opening)", () => {
    const p = workerContractPrompt("implement", "ag2");
    expect(p).toContain("this task is yours to finish");
    expect(p).toContain("PARALLELISING");
    expect(p).not.toContain("L1 planner");
    expect(p).not.toContain("Orchestrator mode");
  });

  it("spotcheck/simple keep the short contract", () => {
    for (const cls of ["spotcheck", "simple"]) {
      const p = workerContractPrompt(cls, "ag2");
      expect(p).toContain("No child workers, no handoff");
      expect(p).not.toContain("L1 planner");
      expect(p.length).toBeLessThan(workerContractPrompt("implement", "ag2").length);
    }
  });

  it("the keepalive baseline stays the worker-role full contract", () => {
    expect(WORKER_CONTRACT_PROMPT).toContain("this task is yours to finish");
    expect(WORKER_CONTRACT_PROMPT).not.toContain("L1 planner");
  });
});
