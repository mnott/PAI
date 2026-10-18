import { describe, it, expect } from "vitest";
import { isScratchRootFile } from "./worker-scratch-name.js";

const none = new Set<string>();
describe("isScratchRootFile", () => {
  it("allows ordinary root files", () => {
    for (const n of ["notes.txt", "README.md", "pyproject.toml", "LICENSE", "package.json"]) expect(isScratchRootFile(n, none)).toBe(false);
  });
  it("denies scratch names and extensions", () => {
    for (const n of ["tmp_check.py", "scratch.js", "debug.log", "test_foo.py", "Output.txt", "a.out", "x.tmp"]) expect(isScratchRootFile(n, none)).toBe(true);
  });
  it("allows scripts in a language the repo uses, except js runners", () => {
    const py = new Set([".py"]);
    expect(isScratchRootFile("setup.py", py)).toBe(false);
    expect(isScratchRootFile("setup.py", none)).toBe(true);
    expect(isScratchRootFile("run_all.mjs", new Set([".mjs"]))).toBe(true);
    expect(isScratchRootFile("build.mjs", new Set([".mjs"]))).toBe(false);
  });
});
