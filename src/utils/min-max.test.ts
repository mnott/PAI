import { describe, expect, it } from "vitest";
import { maxOf, minOf } from "./min-max.js";

describe("minOf/maxOf", () => {
  it("handle 200k elements where spread throws", () => {
    const a = Array.from({ length: 200_000 }, (_, i) => i - 5);
    expect(() => Math.min(...a)).toThrow(RangeError);
    expect(minOf(a)).toBe(-5);
    expect(maxOf(a)).toBe(199_994);
  });
  it("empty matches Math.min()/Math.max()", () => {
    expect(minOf([])).toBe(Infinity);
    expect(maxOf([])).toBe(-Infinity);
  });
  it("accepts iterables", () => {
    expect(maxOf(new Map([["a", 3], ["b", 7]]).values())).toBe(7);
  });
});
