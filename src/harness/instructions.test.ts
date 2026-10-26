import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INSTRUCTIONS_TEMPLATE, renderInstructions } from "./instructions.js";

const claudeMd = readFileSync(new URL("../../templates/claude-md.template.md", import.meta.url), "utf8");

describe("renderInstructions", () => {
  it("keeps only the blocks of the target harness and strips every marker", () => {
    const cc = renderInstructions("claude-code");
    const oc = renderInstructions("opencode");
    expect(cc).toContain("### Harness: Claude Code");
    expect(cc).not.toContain("### Harness: OpenCode");
    expect(oc).toContain("### Harness: OpenCode");
    expect(oc).not.toContain("### Harness: Claude Code");
    for (const t of [cc, oc]) expect(t).not.toMatch(/<!-- \/?only/);
  });

  it("the MCP server text is the claude-code rendering of the shared source", () => {
    expect(renderInstructions("claude-code")).toContain(INSTRUCTIONS_TEMPLATE.split("<!-- only")[0]!.trim());
  });

  it("renders the CLAUDE.md template per harness: file name, home, no Claude-only wording in OpenCode's", () => {
    const oc = renderInstructions("opencode", claudeMd, "/home/u");
    const cc = renderInstructions("claude-code", claudeMd, "/home/u");
    expect(oc.split("\n")[0]).toBe("# AGENTS.md - PAI Global Configuration");
    expect(cc.split("\n")[0]).toBe("# CLAUDE.md - PAI Global Configuration");
    for (const t of [oc, cc]) {
      expect(t).not.toContain("${HOME}");
      expect(t).not.toContain("{{");
      expect(t).not.toMatch(/<!-- \/?only/);
    }
    expect(oc).toContain("pai_worker_run");
    expect(oc).not.toMatch(/Task\(|Task tool/);
    expect(cc).toContain("`Task` tool");
  });
});
