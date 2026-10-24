import { describe, expect, it } from "vitest";
import { hasMalformedToolCall, isDegenerateAnswer } from "./malformed-toolcall.js";
import { endLabel } from "./endreason.js";
import { fallThroughReason } from "./policy.js";

describe("hasMalformedToolCall", () => {
  it("flags both captured forms", () => {
    expect(hasMalformedToolCall("<tool_call>\n<=Bash>\n<parameter=command>\nls\n</parameter>\n</function>")).toBe(true);
    expect(hasMalformedToolCall("I will read it.\n<tool_call>\n<Read>\n<parameter=file_path>\n/x\n</parameter>")).toBe(true);
    expect(hasMalformedToolCall("<tool_call>\n<Read>\n</function>\n</tool_call>")).toBe(true);
  });
  it("flags a damaged call truncated before any <parameter= or </function>", () => {
    // exactly what the live coder-l run of 20261024-145801-15024 ended with
    expect(hasMalformedToolCall("<tool_call>\n<\n</")).toBe(true);
  });
  it("ignores a well-formed result", () => {
    expect(hasMalformedToolCall("R\ni=x\nr=+\nz=done")).toBe(false);
    expect(hasMalformedToolCall("mentions <tool_call> only")).toBe(false);
    expect(hasMalformedToolCall("Ship it — the `tool_call` block was fine, then done.")).toBe(false);
    expect(hasMalformedToolCall(`<tool_call>${"x".repeat(300)}<parameter=a>`)).toBe(false);
    expect(hasMalformedToolCall(undefined)).toBe(false);
  });
  it("labels and falls through as an instrument fault", () => {
    expect(endLabel({ endReason: "malformed-tool-call" })).toBe("instrument: malformed tool call");
    const local = { local: true, policy: "auto", reason: "" } as never;
    const run = { rc: 0, state: "done", endReason: "malformed-tool-call" };
    expect(fallThroughReason(local, run, { result: "-" })).toBe("instrument fault: malformed tool call");
    expect(fallThroughReason(local, run, { result: "-" }, "x bench")).toBeNull();
  });
});

describe("isDegenerateAnswer", () => {
  const task = "t".repeat(400);
  it("flags a stray token with no tools on a real task", () => {
    expect(isDegenerateAnswer(",", 0, task)).toBe(true);
    expect(isDegenerateAnswer(" ok ", 0, task)).toBe(true);
    expect(isDegenerateAnswer("", 0, task)).toBe(true);
  });
  it("ignores tools used, a real answer, or a trivial task", () => {
    expect(isDegenerateAnswer(",", 2, task)).toBe(false);
    expect(isDegenerateAnswer("PINEAPPLE", 0, task)).toBe(false);
    expect(isDegenerateAnswer(",", 0, "reply with a comma")).toBe(false);
  });
  it("labels and falls through as an instrument fault", () => {
    expect(endLabel({ endReason: "degenerate-answer" })).toBe("instrument: degenerate answer");
    const local = { local: true, policy: "auto", reason: "" } as never;
    expect(fallThroughReason(local, { rc: 0, state: "done", endReason: "degenerate-answer" }, { result: "-" })).toBe("instrument fault: degenerate answer");
  });
});
