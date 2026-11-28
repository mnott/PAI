import { describe, expect, it } from "vitest";
import { isTestCommand } from "./hang-probe.js";

describe("isTestCommand", () => {
  it("ignores a runner name inside quoted grep arguments", () => {
    expect(isTestCommand('ps -axo pid,etime,command | grep -E "worker merge|vitest|merge-gate" | grep -v grep | head')).toBe(false);
    expect(isTestCommand("echo 'a; vitest run' && ls")).toBe(false);
  });
  it("detects executed runners", () => {
    expect(isTestCommand("npx vitest run x")).toBe(true);
    expect(isTestCommand("FOO=1 npm test")).toBe(true);
    expect(isTestCommand("cd a && bun test")).toBe(true);
    expect(isTestCommand('grep "x|y" f | npx vitest run')).toBe(true);
  });
});
