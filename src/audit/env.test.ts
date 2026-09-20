import { describe, it, expect } from "vitest";
import { isClaudeProcess, extractToolsArg, extractMcpConfigArg, classifyDeferral } from "./env.js";

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

describe("extractToolsArg", () => {
  it("parses a space-separated --tools value", () => {
    expect(extractToolsArg("/bin/claude --tools Bash,Read,Grep,Glob,Agent -p hi")).toBe("Bash,Read,Grep,Glob,Agent");
  });

  it("parses an --tools=value form including ToolSearch", () => {
    expect(extractToolsArg("/bin/claude --tools=A,B,ToolSearch")).toBe("A,B,ToolSearch");
  });

  it("returns null when --tools is missing", () => {
    expect(extractToolsArg("/bin/claude -p hi")).toBeNull();
  });

  it("returns an empty string for an explicit empty --tools value", () => {
    expect(extractToolsArg('/bin/claude --tools "" -p hi')).toBe("");
    expect(extractToolsArg("/bin/claude --tools= -p hi")).toBe("");
  });
});

describe("extractMcpConfigArg", () => {
  it("parses a space-separated --mcp-config value", () => {
    expect(extractMcpConfigArg("/bin/claude --mcp-config /tmp/foo.json -p hi")).toBe("/tmp/foo.json");
  });

  it("parses an --mcp-config=value form", () => {
    expect(extractMcpConfigArg("/bin/claude --mcp-config=/tmp/foo.json")).toBe("/tmp/foo.json");
  });

  it("returns null when --mcp-config is missing", () => {
    expect(extractMcpConfigArg("/bin/claude -p hi")).toBeNull();
  });
});

describe("classifyDeferral", () => {
  it("is on when --tools is absent (CLI default includes ToolSearch)", () => {
    expect(classifyDeferral(null)).toBe("on");
  });

  it("is on when the explicit list includes ToolSearch", () => {
    expect(classifyDeferral("Bash,Read,ToolSearch")).toBe("on");
  });

  it("is OFF when an explicit non-empty list omits ToolSearch", () => {
    expect(classifyDeferral("Bash,Read,Grep,Glob,Agent")).toBe("OFF");
  });

  it("is n/a when --tools is explicitly empty", () => {
    expect(classifyDeferral("")).toBe("n/a");
    expect(classifyDeferral("   ")).toBe("n/a");
  });
});
