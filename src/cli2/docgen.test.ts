import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GROUPS } from "./registry.js";
import { renderPages, writePages } from "./docgen.js";

describe("pai doc --dir pages", () => {
  const dir = mkdtempSync(join(tmpdir(), "pai-docs-"));
  mkdirSync(join(dir, "_examples"));
  writeFileSync(join(dir, "_examples", "kg.md"), "```sh\npai kg stats\n```\n");
  writeFileSync(join(dir, "stale.md"), "old");

  it("writes one page per top-level command plus an index, keeps _examples, drops stale pages", () => {
    writePages(dir, renderPages(GROUPS, join(dir, "_examples")));
    const files = readdirSync(dir);
    expect(files).toEqual(expect.arrayContaining(["kg.md", "memory.md", "audit.md", "README.md", "_examples"]));
    expect(files).not.toContain("stale.md");
    expect(readFileSync(join(dir, "kg.md"), "utf8")).toContain("## Examples");
    const index = readFileSync(join(dir, "README.md"), "utf8");
    expect(index).toContain("`pai audit tokens mcp`");
    expect(index).toContain("`pai memory backend detect`");
  });
  it("is deterministic", () => {
    expect(renderPages(GROUPS)).toEqual(renderPages(GROUPS));
  });
});
