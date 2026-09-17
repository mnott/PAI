/**
 * Tests for the codex engine — argument building, dropped-flag detection and
 * the event folding from recorded `codex exec --json` JSONL lines into the
 * claude-code-shaped events the viewer already renders. Pure functions; the
 * codex CLI itself is never invoked.
 */

import { describe, it, expect } from "vitest";
import { buildCodexArgs, codexDroppedFlags, emptyCodexResult, foldCodexLine, parseCodexLine } from "./codex.js";

describe("buildCodexArgs", () => {
  it("builds exec --json with the model and the prompt", () => {
    expect(buildCodexArgs("fix the bug", "gpt-5.2-codex")).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-m",
      "gpt-5.2-codex",
      "--",
      "fix the bug",
    ]);
  });

  it("omits -m when the caller brought a model", () => {
    expect(buildCodexArgs("task", undefined)).not.toContain("-m");
  });
});

describe("codexDroppedFlags", () => {
  it("detects claude-only flags and their values", () => {
    expect(
      codexDroppedFlags(["-p", "task", "--allowedTools", "Read,Edit", "--mcp-config", "/tmp/x.json"])
    ).toEqual(["--allowedTools", "--mcp-config"]);
  });

  it("handles = forms and leaves other flags alone", () => {
    expect(codexDroppedFlags(["--allowedTools=Read", "--verbose", "-p", "t"])).toEqual(["--allowedTools"]);
  });
});

describe("foldCodexLine", () => {
  it("captures the thread id from thread.started", () => {
    const r = emptyCodexResult();
    foldCodexLine(parseCodexLine('{"type":"thread.started","thread_id":"th_9"}'), r);
    expect(r.threadId).toBe("th_9");
  });

  it("agent_message counts a turn and becomes an assistant text event", () => {
    const r = emptyCodexResult();
    foldCodexLine(
      parseCodexLine(
        '{"type":"item.completed","item":{"type":"agent_message","text":"Fixed the guard."}}'
      ),
      r
    );
    expect(r.turns).toBe(1);
    expect(r.finalText).toBe("Fixed the guard.");
    expect(r.events).toEqual([
      { type: "assistant", message: { content: [{ type: "text", text: "Fixed the guard." }] } },
    ]);
  });

  it("command_execution becomes a Bash tool_use + tool_result pair", () => {
    const r = emptyCodexResult();
    foldCodexLine(
      parseCodexLine(
        '{"type":"item.completed","item":{"type":"command_execution","command":"npm test","exit_code":0,"aggregated_output":"12 passed"}}'
      ),
      r
    );
    expect(r.tools).toBe(1);
    expect(r.events[0]).toEqual({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] },
    });
    expect(r.events[1].type).toBe("user");
    const result = (r.events[1].message as { content: Array<Record<string, unknown>> }).content[0];
    expect(result.is_error).toBe(false);
    expect(result.content).toBe("12 passed");
  });

  it("a failing command marks its tool_result as error", () => {
    const r = emptyCodexResult();
    foldCodexLine(
      parseCodexLine(
        '{"type":"item.completed","item":{"type":"command_execution","command":"exit 3","exit_code":3,"aggregated_output":"boom"}}'
      ),
      r
    );
    const result = (r.events[1].message as { content: Array<Record<string, unknown>> }).content[0];
    expect(result.is_error).toBe(true);
  });

  it("file_change becomes a Write tool_use with the touched files", () => {
    const r = emptyCodexResult();
    foldCodexLine(
      parseCodexLine(
        '{"type":"item.completed","item":{"type":"file_change","changes":[{"path":"src/a.ts"},{"path":"src/b.ts"}]}}'
      ),
      r
    );
    expect(r.tools).toBe(1);
    expect(r.events).toEqual([
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "src/a.ts, src/b.ts" } }] },
      },
    ]);
  });

  it("turn.completed records the context tokens (input+cached+output)", () => {
    const r = emptyCodexResult();
    foldCodexLine(
      parseCodexLine(
        '{"type":"turn.completed","usage":{"input_tokens":120,"cached_input_tokens":8000,"output_tokens":45}}'
      ),
      r
    );
    expect(r.contextTokens).toBe(8165);
  });

  it("turn.failed flags the run as error with the message", () => {
    const r = emptyCodexResult();
    foldCodexLine(parseCodexLine('{"type":"turn.failed","error":{"message":"quota exceeded"}}'), r);
    expect(r.isError).toBe(true);
    expect(r.last).toBe("quota exceeded");
  });

  it("ignores blanks and non-JSON noise", () => {
    expect(parseCodexLine("")).toBeNull();
    expect(parseCodexLine("not json at all")).toBeNull();
  });
});
