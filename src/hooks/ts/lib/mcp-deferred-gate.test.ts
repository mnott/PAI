import { describe, it, expect } from "vitest";
import {
  decideMcpGate,
  isMcpTool,
  lastToolSearchSurfacingIndex,
  scanTranscriptEvidence,
  type GateHookInput,
} from "./mcp-deferred-gate.js";

// ---------------------------------------------------------------------------
// Fixtures — the transcript shapes that matter for the gate
// ---------------------------------------------------------------------------

const TOOL = "mcp__aibroker__aibroker_rename";

function hookInput(toolName = TOOL): GateHookInput {
  return {
    session_id: "test-session",
    transcript_path: "/tmp/nonexistent-transcript.jsonl",
    cwd: "/tmp/project",
    tool_name: toolName,
    tool_input: { from: "a", to: "b" },
  };
}

/** A tool_use entry for `name` with the given input. */
function toolUseLine(id: string, name: string, input: unknown): string {
  return JSON.stringify({
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  });
}

/** A tool_result for `id`; `errorText` marks it failed with that message. */
function toolResultLine(id: string, errorText?: string): string {
  const block: Record<string, unknown> = {
    type: "tool_result",
    tool_use_id: id,
    content: [{ type: "text", text: errorText ?? "ok" }],
  };
  if (errorText) block.is_error = true;
  return JSON.stringify({ message: { role: "user", content: [block] } });
}

/** What the schema gate's rejection looks like in the transcript. */
const GATE_ERROR =
  "InputValidationError: tool schema not loaded. The following deferred tools are " +
  "available via ToolSearch. Their schemas are NOT loaded — calling them directly will " +
  'fail. Use ToolSearch with query "select:mcp__aibroker__aibroker_rename" to load tool ' +
  "schemas before calling them.";

/** What a mid-session re-registration's stale-handle rejection looks like (2026-09-18 incident). */
const STALE_ERROR = "Error: 411 deferred tools are no longer available: aibroker_rename";

// ---------------------------------------------------------------------------
// isMcpTool
// ---------------------------------------------------------------------------

describe("isMcpTool", () => {
  it("accepts mcp__server__tool names", () => {
    expect(isMcpTool(TOOL)).toBe(true);
  });

  it("rejects core tools and bare mcp__ prefixes", () => {
    expect(isMcpTool("Read")).toBe(false);
    expect(isMcpTool("Bash")).toBe(false);
    expect(isMcpTool("mcp__")).toBe(false);
    expect(isMcpTool("mcp__server")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// scanTranscriptEvidence
// ---------------------------------------------------------------------------

describe("scanTranscriptEvidence", () => {
  it("sees a ToolSearch that surfaced the tool", () => {
    const transcript = [
      toolUseLine("t1", "ToolSearch", { query: `select:${TOOL}` }),
      toolResultLine("t1"),
    ].join("\n");
    expect(scanTranscriptEvidence(transcript, TOOL).surfacedByToolSearch).toBe(true);
  });

  it("sees a prior successful call but not a gate-failed one", () => {
    const failed = [
      toolUseLine("t1", TOOL, { from: "a", to: "b" }),
      toolResultLine("t1", GATE_ERROR),
    ].join("\n");
    expect(scanTranscriptEvidence(failed, TOOL).succeededBefore).toBe(false);

    const succeeded = [
      toolUseLine("t1", TOOL, { from: "a", to: "b" }),
      toolResultLine("t1"),
    ].join("\n");
    expect(scanTranscriptEvidence(succeeded, TOOL).succeededBefore).toBe(true);
  });

  it("ignores junk lines and empty input", () => {
    expect(scanTranscriptEvidence("not json\n\n{broken", TOOL)).toEqual({
      surfacedByToolSearch: false,
      succeededBefore: false,
    });
  });
});

// ---------------------------------------------------------------------------
// decideMcpGate — (a) deferred/failure context gets the correction
// ---------------------------------------------------------------------------

describe("decideMcpGate: deferred and failed-call contexts", () => {
  it("corrects a deferred tool with no transcript evidence (first attempt)", () => {
    const decision = decideMcpGate(hookInput(), "");
    expect(decision.action).toBe("correct");

    const parsed = JSON.parse(decision.output);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    const reason = parsed.hookSpecificOutput.permissionDecisionReason as string;

    // The remedy: ToolSearch with the exact select: form of the full tool name.
    expect(reason).toContain("ToolSearch");
    expect(reason).toContain(`select:${TOOL}`);
    // The misreport this hook exists to prevent, denied in plain words.
    expect(reason.toLowerCase()).toContain("not disconnected");
    expect(reason).toContain("do not report an outage");
  });

  it("corrects the retry after a gate failure (observed incident shape)", () => {
    const transcript = [
      toolUseLine("t1", TOOL, { from: "a", to: "b" }),
      toolResultLine("t1", GATE_ERROR),
    ].join("\n");
    const decision = decideMcpGate(hookInput(), transcript);

    expect(decision.action).toBe("correct");
    const reason = JSON.parse(decision.output).hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain(`select:${TOOL}`);
    expect(reason.toLowerCase()).toContain("not disconnected");
  });

  it("emits a countable observation for every correction", () => {
    const decision = decideMcpGate(hookInput(), "");
    expect(decision.observation).not.toBeNull();
    expect(decision.observation?.type).toBe("decision");
    expect(decision.observation?.tool_name).toBe(TOOL);
    expect(decision.observation?.title).toContain("MCP deferred-tool gate");
  });
});

// ---------------------------------------------------------------------------
// decideMcpGate — (a2) stale deferred-tool handles after a re-registration
// ---------------------------------------------------------------------------

describe("decideMcpGate: stale deferred-tool handles", () => {
  it("corrects the retry after a re-registration invalidated the handle (2026-09-18 incident)", () => {
    // The tool was surfaced by ToolSearch earlier — evidence would normally
    // pass it through — but the handle is dead now, so the gate must deny.
    const transcript = [
      toolUseLine("t0", "ToolSearch", { query: `select:${TOOL}` }),
      toolResultLine("t0"),
      toolUseLine("t1", TOOL, { from: "a", to: "b" }),
      toolResultLine("t1", STALE_ERROR),
    ].join("\n");
    const decision = decideMcpGate(hookInput(), transcript);

    expect(decision.action).toBe("correct");
    const reason = JSON.parse(decision.output).hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain("ToolSearch");
    expect(reason).toContain(`select:${TOOL}`);
    expect(reason.toLowerCase()).toContain("not disconnected");
    expect(reason).toContain("do not report an outage");
  });

  it("re-arms even when the tool ran successfully before the re-registration", () => {
    const transcript = [
      toolUseLine("t0", TOOL, { from: "a", to: "b" }),
      toolResultLine("t0"),
      toolUseLine("t1", TOOL, { from: "a", to: "b" }),
      toolResultLine("t1", STALE_ERROR),
    ].join("\n");
    expect(decideMcpGate(hookInput(), transcript).action).toBe("correct");
  });

  it("passes once a ToolSearch after the invalidation reloaded the entry", () => {
    const transcript = [
      toolUseLine("t1", TOOL, { from: "a", to: "b" }),
      toolResultLine("t1", STALE_ERROR),
      toolUseLine("t2", "ToolSearch", { query: `select:${TOOL}` }),
      toolResultLine("t2"),
    ].join("\n");
    const decision = decideMcpGate(hookInput(), transcript);
    expect(decision.action).toBe("pass");
    expect(JSON.parse(decision.output).hookSpecificOutput.permissionDecision).toBe("allow");
  });

  it("corrects when only the tool input carries the stale-handle text", () => {
    const input = hookInput();
    input.tool_input = { text: `411 ${"deferred tools are no longer available"}` };
    expect(decideMcpGate(input, "").action).toBe("correct");
  });
});

describe("lastToolSearchSurfacingIndex", () => {
  it("finds the last surfacing ToolSearch and returns -1 when absent", () => {
    const transcript = [
      toolUseLine("t1", TOOL, { from: "a", to: "b" }),
      toolResultLine("t1", STALE_ERROR),
      toolUseLine("t2", "ToolSearch", { query: `select:${TOOL}` }),
      toolResultLine("t2"),
    ].join("\n");
    // After the stale error, i.e. the remedy postdates the invalidation.
    expect(lastToolSearchSurfacingIndex(transcript, TOOL)).toBeGreaterThan(
      transcript.lastIndexOf("deferred tools are no longer available"),
    );
    expect(lastToolSearchSurfacingIndex("not json", TOOL)).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// decideMcpGate — (b) normal contexts pass through untouched
// ---------------------------------------------------------------------------

describe("decideMcpGate: pass-through", () => {
  it("passes through after ToolSearch surfaced the tool", () => {
    const transcript = [
      toolUseLine("t1", "ToolSearch", { query: `select:${TOOL}` }),
      toolResultLine("t1"),
    ].join("\n");
    const decision = decideMcpGate(hookInput(), transcript);

    expect(decision.action).toBe("pass");
    expect(decision.observation).toBeNull();
    const parsed = JSON.parse(decision.output);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(decision.output).not.toContain("ToolSearch");
  });

  it("passes through a tool that already ran successfully", () => {
    const transcript = [
      toolUseLine("t1", TOOL, { from: "a", to: "b" }),
      toolResultLine("t1"),
    ].join("\n");
    const decision = decideMcpGate(hookInput(), transcript);

    expect(decision.action).toBe("pass");
    expect(JSON.parse(decision.output).hookSpecificOutput.permissionDecision).toBe("allow");
  });

  it("passes non-mcp tools through regardless of transcript", () => {
    const decision = decideMcpGate(hookInput("Read"), "");
    expect(decision.action).toBe("pass");
    expect(decision.observation).toBeNull();
  });

  it("passes on missing tool_name or junk input", () => {
    expect(decideMcpGate({}, "").action).toBe("pass");
    expect(decideMcpGate({ tool_name: "" }, "").action).toBe("pass");
  });
});
