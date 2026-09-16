import { describe, it, expect } from "vitest";
import { contentToText, isNoiseFilePath, preferCwdFiles } from "./transcript-text.js";

// ---------------------------------------------------------------------------
// contentToText — bug 1: "[object Object]" from a stringified nested array
// ---------------------------------------------------------------------------

describe("contentToText", () => {
  it("returns a plain string unchanged", () => {
    expect(contentToText("hello")).toBe("hello");
  });

  it("concatenates the text of type:text blocks", () => {
    expect(
      contentToText([
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ])
    ).toBe("first second");
  });

  it("BUG 1: ignores a tool_result block instead of stringifying its nested content array", () => {
    // This is the exact shape a tool_result user-turn takes: content is an
    // ARRAY of blocks, not a string or a .text field. The old code fell back
    // to String(c.content) here, producing "[object Object],[object Object]".
    const content = [
      {
        type: "tool_result",
        tool_use_id: "abc",
        content: [
          { type: "text", text: "some tool output" },
          { type: "text", text: "more tool output" },
        ],
      },
    ];
    const result = contentToText(content);
    expect(result).not.toContain("[object Object]");
    expect(result).toBe(""); // tool_result is ignored entirely, not partially stringified
  });

  it("ignores tool_use and image blocks", () => {
    const content = [
      { type: "tool_use", name: "Edit", input: { file_path: "/x.ts" } },
      { type: "image", source: { data: "..." } },
      { type: "text", text: "the actual request" },
    ];
    expect(contentToText(content)).toBe("the actual request");
  });

  it("returns empty string for non-string, non-array content", () => {
    expect(contentToText(null)).toBe("");
    expect(contentToText(undefined)).toBe("");
    expect(contentToText(42)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// isNoiseFilePath — bug 2: tmp/jobs paths crowding out real source files
// ---------------------------------------------------------------------------

describe("isNoiseFilePath", () => {
  it("excludes a tmp/ path segment", () => {
    expect(isNoiseFilePath("/Users/me/project/jobs/42/tmp/msg8.txt")).toBe(true);
  });

  it("excludes a jobs/ path segment even without a nested tmp/", () => {
    expect(isNoiseFilePath("/Users/me/project/jobs/42/attachment.txt")).toBe(true);
  });

  it("excludes a scratchpad/ path segment", () => {
    expect(isNoiseFilePath("/private/tmp/claude-501/proj/scratchpad/notes.md")).toBe(true);
  });

  it("excludes anything under an explicit scratchpad dir even without the word in the path", () => {
    expect(isNoiseFilePath("/private/tmp/claude-501/proj/work/sess/draft.txt", "/private/tmp/claude-501/proj/work/sess")).toBe(true);
  });

  it("does not exclude a real source file", () => {
    expect(isNoiseFilePath("/Users/me/project/src/hooks/ts/pre-compact/context-compression-hook.ts")).toBe(false);
  });

  it("does not false-positive on a directory merely containing 'tmp' as a substring", () => {
    expect(isNoiseFilePath("/Users/me/project/src/attempt/file.ts")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// preferCwdFiles — bug 2 continued: don't let noise crowd the last-10 slice
// ---------------------------------------------------------------------------

describe("preferCwdFiles", () => {
  it("orders cwd files before non-cwd files", () => {
    const files = [
      "/other/repo/a.ts",
      "/Users/me/project/src/real.ts",
      "/other/repo/b.ts",
      "/Users/me/project/src/other-real.ts",
    ];
    const result = preferCwdFiles(files, "/Users/me/project");
    expect(result).toEqual([
      "/Users/me/project/src/real.ts",
      "/Users/me/project/src/other-real.ts",
      "/other/repo/a.ts",
      "/other/repo/b.ts",
    ]);
  });

  it("returns the list unchanged when cwd is not provided", () => {
    const files = ["/a.ts", "/b.ts"];
    expect(preferCwdFiles(files)).toEqual(files);
  });

  it("real regression case: real source files survive a slice(-10) after noise filtering + cwd preference", () => {
    // Reproduces the reported digest: 8 tmp/jobs paths plus 2 real source
    // files. isNoiseFilePath already drops the 8 at collection time in the
    // hook, so this only has the 2 real files left — they must not be pushed
    // out of a 10-slot slice by anything.
    const realFiles = [
      "/Users/me/project/src/a.ts",
      "/Users/me/project/src/b.ts",
    ];
    const result = preferCwdFiles(realFiles, "/Users/me/project").slice(-10);
    expect(result).toEqual(realFiles);
  });
});
