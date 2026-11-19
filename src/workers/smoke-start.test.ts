import { describe, expect, it } from "vitest";
import { smokeStart } from "./smoke-start.js";

const stub = { serve: async () => ({ url: "http://127.0.0.1:1/v1", close: async () => {} }), addProvider: () => {}, removeProvider: () => {} };

describe("smokeStart", () => {
  it("a start that throws reads as a failure with the first error line", async () => {
    const r = await smokeStart({ cwd: "." }, { ...stub, start: async () => { throw new Error("Cannot access 'toolFold' before initialization\n at x"); } });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Cannot access 'toolFold' before initialization");
  });

  it("a non-zero exit is a failure", async () => {
    const r = await smokeStart({ cwd: "." }, { ...stub, start: async () => ({ rc: 1, id: "nope" }) });
    expect(r).toMatchObject({ ok: false, error: "worker run exited 1" });
  });
});
