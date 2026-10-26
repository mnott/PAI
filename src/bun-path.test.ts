import { describe, expect, it } from "vitest";
import { withBunOnPath } from "./bun-path.js";

describe("withBunOnPath", () => {
  it("appends the bun bin dir when it exists and is missing from PATH", () => {
    const env = withBunOnPath({ PATH: "/usr/bin:/bin" }, "/h", () => true);
    expect(env.PATH).toBe("/usr/bin:/bin:/h/.bun/bin");
  });
  it("sets PATH when it was unset", () => {
    expect(withBunOnPath({}, "/h", () => true).PATH).toBe("/h/.bun/bin");
  });
  it("does not duplicate an entry already on PATH", () => {
    expect(withBunOnPath({ PATH: "/h/.bun/bin:/usr/bin" }, "/h", () => true).PATH).toBe("/h/.bun/bin:/usr/bin");
  });
  it("leaves PATH alone when the dir does not exist", () => {
    expect(withBunOnPath({ PATH: "/usr/bin" }, "/h", () => false).PATH).toBe("/usr/bin");
  });
});
