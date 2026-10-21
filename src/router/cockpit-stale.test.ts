import { describe, expect, it } from "vitest";
import { staleMark } from "./cockpit-stale.js";

describe("staleMark", () => {
  it("gives {stale:{since,reason}} for a reason and nothing for a good payload", () => {
    expect(staleMark(5, "probe timed out")).toEqual({ stale: { since: 5, reason: "probe timed out" } });
    expect(staleMark(5, null)).toEqual({});
    expect(staleMark(5, "")).toEqual({});
  });
});
