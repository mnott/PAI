import { describe, it, expect } from "vitest";
import {
  decideAgentGate,
  renderDecision,
  shortLabel,
  SUBAGENT_TOOL_NAMES,
  BYPASS_ENV,
  type AgentGateInput,
} from "./agent-gate.js";

/**
 * A real PreToolUse payload shape: taken from an actual in-process subagent
 * launch recorded in a session transcript (tool_use name "Agent", input keys
 * description/model/prompt), wrapped in the PreToolUse envelope the harness
 * feeds hooks on stdin.
 */
function payload(toolName: string, description = "Survey App Store state"): AgentGateInput {
  return {
    session_id: "00000000-0000-0000-0000-000000000000",
    cwd: "/tmp/some-project",
    tool_name: toolName,
    tool_input: { description, model: "sonnet", prompt: "Do the thing." } as AgentGateInput["tool_input"],
  };
}

/** What the harness actually reads: parse the hook's stdout. */
function decisionOf(input: AgentGateInput, env: Record<string, string | undefined>) {
  return JSON.parse(renderDecision(decideAgentGate(input, env))).hookSpecificOutput;
}

describe("agent gate", () => {
  it("covers both the current and the legacy subagent tool name", () => {
    expect([...SUBAGENT_TOOL_NAMES]).toEqual(["Agent", "Task"]);
  });

  for (const name of SUBAGENT_TOOL_NAMES) {
    it(`denies a ${name} call`, () => {
      const out = decisionOf(payload(name), {});
      expect(out.permissionDecision).toBe("deny");
      expect(out.hookEventName).toBe("PreToolUse");
      expect(out.permissionDecisionReason).toContain("pai worker run --provider anthropic");
    });

    it(`allows a ${name} call when ${BYPASS_ENV}=1`, () => {
      const out = decisionOf(payload(name), { [BYPASS_ENV]: "1" });
      expect(out.permissionDecision).toBe("allow");
      expect(out.permissionDecisionReason).toBeUndefined();
    });
  }

  it("denies regardless of the workers config — no config is consulted", () => {
    // The gate used to allow when routing was off or the active provider was
    // Anthropic. It takes no config argument at all now, so there is nothing
    // left that can switch it off but the bypass env var.
    expect(decideAgentGate.length).toBe(2);
    expect(decisionOf(payload("Agent"), { PAI_WORKERS_ACTIVE: "anthropic" }).permissionDecision).toBe(
      "deny"
    );
  });

  it("only the exact value 1 bypasses", () => {
    for (const v of ["0", "true", "yes", "", undefined]) {
      expect(decisionOf(payload("Agent"), { [BYPASS_ENV]: v }).permissionDecision).toBe("deny");
    }
  });

  it("lets a non-subagent tool through untouched", () => {
    const out = decisionOf(payload("Bash"), {});
    expect(out.permissionDecision).toBe("allow");
  });

  it("denies an event with no tool_name (malformed subagent launch)", () => {
    expect(decisionOf({}, {}).permissionDecision).toBe("deny");
  });

  it("ledgers both outcomes so `pai worker log` shows them", () => {
    expect(decideAgentGate(payload("Agent"), {}).ledger).toBe("DENIED-ANTHROPIC-AGENT");
    expect(decideAgentGate(payload("Agent"), { [BYPASS_ENV]: "1" }).ledger).toBe(
      "ALLOWED-ANTHROPIC-AGENT"
    );
  });

  it("puts the subagent description in the suggested --label", () => {
    const out = decisionOf(payload("Agent", "  Report   local release config  "), {});
    expect(out.permissionDecisionReason).toContain('--label "Report local release config"');
  });

  it("falls back to a generic label when there is no description", () => {
    const out = decisionOf({ tool_name: "Agent" }, {});
    expect(out.permissionDecisionReason).toContain('--label "task"');
  });

  it("truncates a very long description to a usable label", () => {
    expect(shortLabel(payload("Agent", "x".repeat(200)))).toHaveLength(60);
  });

  it("names the bypass in the deny reason so the escape hatch stays discoverable", () => {
    const out = decisionOf(payload("Agent"), {});
    expect(out.permissionDecisionReason).toContain(`${BYPASS_ENV}=1`);
  });
});
