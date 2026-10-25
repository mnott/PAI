import { describe, expect, it } from "vitest";
import { applyTraceEnv, childTraceparent, newTraceparent, parseTraceparent, parseTracestate, traceEnv, traceId } from "./tracecontext.js";

const TP = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("traceparent", () => {
  it.each([
    [TP, true],
    [TP.toUpperCase(), false],
    ["00-00000000000000000000000000000000-00f067aa0ba902b7-01", false],
    ["00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01", false],
    ["ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", false],
    [TP + "-extra", false],
    ["01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-future", true],
    ["00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7", false],
    ["garbage", false],
  ])("%s valid=%s", (v, ok) => {
    expect(parseTraceparent(v) !== null).toBe(ok);
  });
  it("child keeps the trace id and flags, new span", () => {
    const c = childTraceparent(TP);
    expect(traceId(c)).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(c).not.toBe(TP);
    expect(parseTraceparent(c)?.flags).toBe("01");
    expect(parseTraceparent(childTraceparent("bad"))).not.toBeNull();
    expect(parseTraceparent(newTraceparent())).not.toBeNull();
  });
});

describe("tracestate", () => {
  it("limits", () => {
    expect(parseTracestate("a=1,b=2")).toBe("a=1,b=2");
    expect(parseTracestate("a=1,a=2")).toBeNull();
    expect(parseTracestate(Array.from({ length: 33 }, (_, i) => `k${i}=v`).join(","))).toBeNull();
    expect(parseTracestate(Array.from({ length: 32 }, (_, i) => `k${i}=v`).join(","))).not.toBeNull();
    expect(parseTracestate("a=" + "x".repeat(520))).toBeNull();
    expect(parseTracestate("NoCaps=1")).toBeNull();
    expect(parseTracestate("novalue")).toBeNull();
  });
});

describe("env", () => {
  it("continues a valid caller trace, forwards tracestate, drops baggage; bad caller -> new root, no tracestate", () => {
    const env: Record<string, string | undefined> = { BAGGAGE: "x=y" };
    applyTraceEnv(env, { PAI_TRACEPARENT: TP, PAI_TRACESTATE: "v=1" } as never);
    expect(traceId(env.TRACEPARENT)).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(env.TRACESTATE).toBe("v=1");
    expect(env.BAGGAGE).toBeUndefined();
    const bad = traceEnv({ PAI_TRACEPARENT: "nope", PAI_TRACESTATE: "v=1" } as never);
    expect(parseTraceparent(bad.TRACEPARENT)).not.toBeNull();
    expect(bad.TRACESTATE).toBeUndefined();
  });
});
