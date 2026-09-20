import { describe, it, expect } from "vitest";
import { isClaudeProcess } from "./env.js";

describe("isClaudeProcess", () => {
  it("accepts a valid claude process", () => {
    const line = "  12345    1:23      claude          /opt/homebrew/bin/claude --worker";
    expect(isClaudeProcess(line)).toBe(true);
  });

  it("accepts claude.exe on Windows", () => {
    const line = "  12345    1:23      claude.exe      C:\\Program Files\\Claude\\claude.exe";
    expect(isClaudeProcess(line)).toBe(true);
  });

  it("accepts paths ending with /claude", () => {
    const line = "  12345    1:23      /path/claude    /path/to/claude --worker";
    expect(isClaudeProcess(line)).toBe(true);
  });

  it("rejects node MCP children", () => {
    const line = "  54321    0:05      node            node /opt/mcp-server-stdio.js";
    expect(isClaudeProcess(line)).toBe(false);
  });

  it("rejects npm exec MCP children", () => {
    const line = "  54321    0:05      npm             npm exec mcp-server-something";
    expect(isClaudeProcess(line)).toBe(false);
  });

  it("rejects processes with mcp-server in args", () => {
    const line = "  12345    1:23      claude          /bin/claude --mcp-server";
    expect(isClaudeProcess(line)).toBe(false);
  });

  it("rejects unrelated processes", () => {
    const line = "  99999    5:00      bash            /bin/bash";
    expect(isClaudeProcess(line)).toBe(false);
  });

  it("rejects empty lines", () => {
    expect(isClaudeProcess("")).toBe(false);
  });

  it("rejects lines with too few fields", () => {
    const line = "  12345    1:23";
    expect(isClaudeProcess(line)).toBe(false);
  });
});
