import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolFold } from "./tool-fold.js";
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
  it("records every error and injects no repeat-failure correction (loop-watch owns it)", () => {
    const { logDir, injected, fold } = setup();
    for (let i = 1; i <= 4; i++) fail(fold, i, "boom");
    expect(readFileSync(toolErrorsPath(logDir), "utf8").trim().split("\n").length).toBe(4);
    expect(injected).toEqual([]);
  });
});
