import { describe, expect, it } from "vitest";
import { isCi } from "./ci.js";

describe("isCi", () => {
  it("is true for CI=true or GITHUB_ACTIONS=true", () => {
    expect(isCi({ CI: "true" })).toBe(true);
    expect(isCi({ GITHUB_ACTIONS: "true" })).toBe(true);
  });
  it("is false otherwise", () => {
    expect(isCi({})).toBe(false);
    expect(isCi({ CI: "false", GITHUB_ACTIONS: "" })).toBe(false);
  });
});
