/**
 * readSpecPrompt("-", …) reads fd 0 (stdin) — mocked here, since a real
 * `readFileSync(0, …)` in the test process would read the test runner's own
 * stdin rather than anything under test control.
 */

import { describe, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => ({ readFileSync: vi.fn() }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: mocks.readFileSync };
});

import { readSpecPrompt } from "./specfile.js";

describe("readSpecPrompt('-') reads stdin", () => {
  it("returns stdin's content byte-for-byte", () => {
    mocks.readFileSync.mockReturnValue("piped content\n");
    expect(readSpecPrompt("-", "/tmp")).toBe("piped content\n");
    expect(mocks.readFileSync).toHaveBeenCalledWith(0, "utf8");
  });

  it("throws when stdin is empty", () => {
    mocks.readFileSync.mockReturnValue("");
    expect(() => readSpecPrompt("-", "/tmp")).toThrow("stdin was empty");
  });

  it("throws with a clear message when stdin cannot be read", () => {
    mocks.readFileSync.mockImplementation(() => {
      throw new Error("EAGAIN");
    });
    expect(() => readSpecPrompt("-", "/tmp")).toThrow("could not read stdin");
  });
});
