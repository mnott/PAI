import { describe, it, expect } from "vitest";
import { routeModelKey } from "./pick.js";

describe("routeModelKey", () => {
  it("sends a project row to the model step", () => {
    expect(routeModelKey({ dir: "/x" })).toEqual({ action: "model" });
  });
  it("refuses a live row with a status line", () => {
    expect(routeModelKey({ dir: "/x", live: {} as never })).toEqual({ flash: "live session — model fixed" });
  });
  it("ignores a row without a directory", () => {
    expect(routeModelKey({})).toBeNull();
  });
});
