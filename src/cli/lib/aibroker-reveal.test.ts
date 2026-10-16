import { describe, it, expect } from "vitest";
import { buildRevealScript, itermUniqueId } from "./aibroker-client.js";

describe("iTerm reveal by session id", () => {
  it("extracts the unique id after the colon", () => {
    expect(itermUniqueId("w0t1p0:ABC-123")).toBe("ABC-123");
    expect(itermUniqueId("iterm:ABC-123")).toBe("ABC-123");
  });
  it("builds a script matching unique id, no index access", () => {
    const s = buildRevealScript("ABC-123");
    expect(s).toContain('(unique id of s) is "ABC-123"');
    expect(s).not.toMatch(/item \d|tab \d|window \d/);
    expect(s).toContain("not-found");
  });
});
