import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkMdFiles } from "./helpers.js";

describe("walkMdFiles", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pai-helpers-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips worker worktrees (full repo copies)", () => {
    mkdirSync(join(dir, "worktrees", "20260101-000000-abc", "docs"), { recursive: true });
    writeFileSync(join(dir, "worktrees", "20260101-000000-abc", "docs", "README.md"), "# hi");
    writeFileSync(join(dir, "keep.md"), "# kept");

    const files = walkMdFiles(dir);

    expect(files).toEqual([join(dir, "keep.md")]);
  });
});
