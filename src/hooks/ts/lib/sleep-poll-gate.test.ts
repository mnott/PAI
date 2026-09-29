import { describe, it, expect } from "vitest";
import { decideSleepPollGate, renderDecision, type SleepPollGateInput } from "./sleep-poll-gate.js";

function decisionOf(input: SleepPollGateInput, env: Record<string, string | undefined> = {}) {
  return JSON.parse(renderDecision(decideSleepPollGate(input, env))).hookSpecificOutput;
}

function bash(command: string, run_in_background?: boolean): SleepPollGateInput {
  return { tool_name: "Bash", tool_input: { command, ...(run_in_background !== undefined ? { run_in_background } : {}) } };
}

describe("sleep-poll gate", () => {
  it("denies a long sleep, standalone or buried in a compound command", () => {
    for (const cmd of [
      "sleep 590",
      "sleep 2m",
      "cd x && sleep 300",
      "sleep 120; tail -5 f",
      "while true; do sleep 90; done",
      "for i in 1 2; do sleep 61; done",
    ]) {
      const out = decisionOf(bash(cmd));
      expect(out.permissionDecision).toBe("deny");
      expect(out.hookEventName).toBe("PreToolUse");
      expect(out.permissionDecisionReason).toContain("do not sleep-poll");
    }
  });

  it("allows a short sleep or a sleep lookalike", () => {
    for (const cmd of ["sleep 30", "sleep 59; tail f", "echo sleep 500", "grep sleep file", "timeout 600 make"]) {
      expect(decisionOf(bash(cmd)).permissionDecision).toBe("allow");
    }
  });

  it("allows any command when run_in_background is true — a backgrounded sleep blocks nothing", () => {
    expect(decisionOf(bash("sleep 590", true)).permissionDecision).toBe("allow");
  });

  it("lets a non-Bash tool through untouched", () => {
    expect(
      decisionOf({ tool_name: "Write", tool_input: { command: "sleep 590" } } as unknown as SleepPollGateInput)
        .permissionDecision
    ).toBe("allow");
  });

  it("interactive session: deny reason points at run_in_background and a bounded loop", () => {
    const out = decisionOf(bash("sleep 590"), {});
    expect(out.permissionDecisionReason).toContain("run_in_background: true");
    expect(out.permissionDecisionReason).toContain("bounded loop under 60s");
  });

  it("worker session (PAI_WORKER=1): deny reason points at a foreground timeout and a kill -0 loop instead", () => {
    const out = decisionOf(bash("sleep 590"), { PAI_WORKER: "1" });
    expect(out.permissionDecisionReason).toContain("FOREGROUND with a Bash timeout up to 600000 ms");
    expect(out.permissionDecisionReason).not.toContain("run_in_background: true");
  });

  it("names the exact offending duration in the reason", () => {
    expect(decisionOf(bash("sleep 2m")).permissionDecisionReason).toContain("sleep 120s blocked");
  });

  it("sums sleeps across one command", () => {
    for (const cmd of ["sleep 58; sleep 58", "sleep 30 && sleep 30", "sleep 1m\nsleep 1", "sleep 0.5m; sleep 31", "for i in 1 2 3; do sleep 30; done", "until false; do sleep 5; done"]) {
      expect(decisionOf(bash(cmd)).permissionDecision, cmd).toBe("deny");
    }
    for (const cmd of ["sleep 30; sleep 20", "for i in 1 2; do sleep 20; done", "for i in {1..3}; do sleep 10; done", "while kill -0 123 2>/dev/null; do sleep 15; done"]) {
      expect(decisionOf(bash(cmd)).permissionDecision, cmd).toBe("allow");
    }
  });

  it("worker: run_in_background is denied with foreground advice; interactive keeps it", () => {
    const out = decisionOf(bash("npm test", true), { PAI_WORKER: "1" });
    expect(out.permissionDecision).toBe("deny");
    expect(out.permissionDecisionReason).toContain("FOREGROUND");
    expect(decisionOf(bash("npm test", true), {}).permissionDecision).toBe("allow");
    expect(decisionOf(bash("npm test", false), { PAI_WORKER: "1" }).permissionDecision).toBe("allow");
  });
});
