/**
 * Tests for --spec file/stdin prompt loading (specfile.ts).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSpecPrompt, resolveSpecPath } from "./specfile.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pai-specfile-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveSpecPath", () => {
  it("resolves a relative path against cwd", () => {
    expect(resolveSpecPath("spec.txt", dir)).toBe(join(dir, "spec.txt"));
  });

  it("leaves an absolute path untouched", () => {
    const abs = join(dir, "spec.txt");
    expect(resolveSpecPath(abs, "/somewhere/else")).toBe(abs);
  });

  it("passes '-' through unchanged (stdin marker)", () => {
    expect(resolveSpecPath("-", dir)).toBe("-");
  });
});

describe("readSpecPrompt", () => {
  it("reads the file's exact bytes as the prompt", () => {
    const content = "line one\nline two\nline three\n";
    const path = join(dir, "spec.txt");
    writeFileSync(path, content, "utf8");
    expect(readSpecPrompt(path, dir)).toBe(content);
  });

  it("resolves a relative path against the given cwd", () => {
    const content = "the task";
    writeFileSync(join(dir, "rel.txt"), content, "utf8");
    expect(readSpecPrompt("rel.txt", dir)).toBe(content);
  });

  it("throws naming the path when the file does not exist", () => {
    const missing = join(dir, "missing.txt");
    expect(() => readSpecPrompt(missing, dir)).toThrow(missing);
  });

  it("throws naming the path when the file is empty", () => {
    const path = join(dir, "empty.txt");
    writeFileSync(path, "", "utf8");
    expect(() => readSpecPrompt(path, dir)).toThrow(path);
  });
});
