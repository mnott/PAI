import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolFold, JSON_CUT_CORRECTION } from "./tool-fold.js";
import { toolErrorsPath } from "../tool-errors.js";

const setup = () => {
  const logDir = mkdtempSync(join(tmpdir(), "pai-toolfold-"));
  const injected: string[] = [];
  const fold = createToolFold({ logDir, worker: "w1", provider: "p", label: "l", cwd: logDir, inject: (t) => injected.push(t) });
  return { logDir, injected, fold };
};
const fail = (fold: ReturnType<typeof createToolFold>, n: number, text: string) => {
  fold.onToolUse({ id: `t${n}`, name: "Edit", input: { file_path: "a.ts" } });
  fold.onToolResult({ tool_use_id: `t${n}`, is_error: true, content: text });
};

describe("createToolFold", () => {
  it("records every error and corrects the third identical failure once", () => {
    const { logDir, injected, fold } = setup();
    for (let i = 1; i <= 4; i++) fail(fold, i, "boom");
    expect(readFileSync(toolErrorsPath(logDir), "utf8").trim().split("\n").length).toBe(4);
    expect(injected.length).toBe(1);
  });
  it("a success between failures resets the streak", () => {
    const { injected, fold } = setup();
    fail(fold, 1, "boom");
    fail(fold, 2, "boom");
    fold.onToolUse({ id: "ok", name: "Read", input: {} });
    fold.onToolResult({ tool_use_id: "ok", content: "fine" });
    fail(fold, 3, "boom");
    expect(injected.length).toBe(0);
  });
  it("a cut-off JSON input gets the split-it correction", () => {
    const { injected, fold } = setup();
    for (let i = 1; i <= 3; i++) fail(fold, i, "InputValidationError: Edit was called with input that could not be parsed as JSON");
    expect(injected).toEqual([JSON_CUT_CORRECTION]);
  });
});
