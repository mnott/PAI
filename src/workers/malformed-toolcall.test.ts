import { describe, expect, it } from "vitest";
import { hasMalformedToolCall } from "./malformed-toolcall.js";
import { endLabel } from "./endreason.js";
import { fallThroughReason } from "./policy.js";

describe("hasMalformedToolCall", () => {
  it("flags both captured forms", () => {
    expect(hasMalformedToolCall("<tool_call>\n<=Bash>\n<parameter=command>\nls\n</parameter>\n</function>")).toBe(true);
    expect(hasMalformedToolCall("I will read it.\n<tool_call>\n<Read>\n<parameter=file_path>\n/x\n</parameter>")).toBe(true);
    expect(hasMalformedToolCall("<tool_call>\n<Read>\n</function>\n</tool_call>")).toBe(true);
  });
  it("ignores a well-formed result", () => {
    expect(hasMalformedToolCall("R\ni=x\nr=+\nz=done")).toBe(false);
    expect(hasMalformedToolCall("mentions <tool_call> only")).toBe(false);
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
