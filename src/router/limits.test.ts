import { describe, it, expect } from "vitest";
import { modelServed } from "./limits.js";

describe("modelServed", () => {
  it("decides by served model id, not by the shared port", () => {
    const served = ["qwen36-35b"];
    expect(modelServed(served, ["qwen36-35b"])).toBe(true);
    expect(modelServed(served, ["glm47-flash", "glm47"])).toBe(false);
  });
  it("falls back to the port when the server lists nothing", () => {
    expect(modelServed(undefined, ["glm47"])).toBe(true);
  });
});
