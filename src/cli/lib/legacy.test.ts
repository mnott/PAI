import { describe, expect, it } from "vitest";
import { legacy } from "./legacy.js";

describe("legacy", () => {
  it("returns 0 when the function leaves exitCode unset", async () => {
    expect(await legacy(() => undefined)).toBe(0);
  });
  it("returns the exitCode the function set, and resets it", async () => {
    expect(
      await legacy(async () => {
        process.exitCode = 3;
      }),
    ).toBe(3);
    expect(process.exitCode).toBeUndefined();
  });
});
