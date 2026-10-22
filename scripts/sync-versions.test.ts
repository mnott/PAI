import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
// @ts-expect-error plain .mjs script without types
import { manifestPaths } from "./sync-versions.mjs";

const pkg = JSON.parse(readFileSync("package.json", "utf8")).version;

describe("plugin manifest versions", () => {
  const paths: string[] = manifestPaths();
  it("covers the four top-level manifests", () => {
    for (const p of [".claude-plugin/plugin.json", "pai-plugin.json", "gemini-extension.json", ".cursor/plugin.json"]) {
      expect(paths).toContain(p);
    }
  });
  it.each(paths)("%s equals package.json's version", (p) => {
    expect(JSON.parse(readFileSync(p, "utf8")).version).toBe(pkg);
  });
});
