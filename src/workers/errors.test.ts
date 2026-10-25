import { describe, expect, it } from "vitest";
import { endError, endReasonCode, errorTypeOf, paiError, retriable } from "./errors.js";
import { isUhpErrorCode } from "./uhp-vocab.js";

describe("end reason -> code", () => {
  it.each([
    ["exit", null],
    [undefined, null],
    ["deadline", "timeout"],
    ["loop-stopped", "pai_loop_stopped"],
    ["pai-worker-kill", "cancelled"],
    ["client-gone", "cancelled"],
    ["parent-gone", "pai_parent_gone"],
    ["external-signal", "pai_external_signal"],
    ["malformed-tool-call", "pai_malformed_tool_call"],
    ["degenerate-answer", "pai_degenerate_answer"],
  ])("%s -> %s", (reason, code) => {
    expect(endReasonCode(reason)).toBe(code);
  });
  it("endError builds the envelope body; a normal exit has none", () => {
    expect(endError("deadline", "ran out")).toEqual({ type: "harness_error", code: "timeout", message: "ran out", param: null, detail: null });
    expect(endError("exit")).toBeNull();
  });
});

describe("taxonomy", () => {
  it("vendor codes carry pai_ and every UHP code added is known", () => {
    for (const c of ["invalid_input", "session_not_found", "file_not_found", "file_too_large", "harness_error", "insufficient_scope", "unsupported_base"]) expect(isUhpErrorCode(c)).toBe(true);
    expect(errorTypeOf("pai_merge_conflict")).toBe("harness_error");
    expect(errorTypeOf("rate_limited")).toBe("rate_limit_error");
    expect(errorTypeOf("missing_credential")).toBe("authentication_error");
    expect(errorTypeOf("something_new")).toBe("server_error");
    expect(paiError("invalid_input", "x", { param: "input" }).param).toBe("input");
  });
  it("retry table: quota_exhausted is never retried", () => {
    expect(retriable("rate_limited")).toBe(true);
    expect(retriable("harness_unavailable")).toBe(true);
    expect(retriable("quota_exhausted")).toBe(false);
    expect(retriable("invalid_input")).toBe(false);
  });
});
