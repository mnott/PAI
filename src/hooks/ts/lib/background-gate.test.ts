import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { BACKGROUND_DENY_MESSAGE, backgroundReason } from "./background-gate.js";

const bg = (command: string, env: Record<string, string> = {}) => backgroundReason({ command, run_in_background: true }, env);

describe("backgroundReason", () => {
  it.each(["npx vitest run", "sleep 600", "nohup ./serve.sh &", "pai worker ps", "pai pane runx -- a", "echo pai pane run"])("denies bare background %s", (c) => {
    expect(bg(c)).toBe(BACKGROUND_DENY_MESSAGE);
  });
  it.each([
    "pai pane run --label t -- sleep 1",
    "pai worker run --class simple -p x",
    "pai plan run plan.yaml",
    "pai build run -- make",
    "pai build lock -- make",
    "cd /tmp && pai pane run -- ls",
    "FOO=1 /usr/local/bin/pai pane run -- ls",
  ])("allows %s", (c) => {
    expect(bg(c)).toBeNull();
  });
  it("foreground and workers are untouched", () => {
    expect(backgroundReason({ command: "npx vitest run" }, {})).toBeNull();
    expect(backgroundReason({ command: "npx vitest run", run_in_background: false }, {})).toBeNull();
    expect(bg("npx vitest run", { PAI_WORKER: "1" })).toBeNull();
  });
});

describe("hook entry", () => {
  const hook = (command: string, bgFlag: boolean): string => {
    const { PAI_WORKER: _drop, ...env } = process.env;
    return execFileSync("bun", ["src/hooks/ts/pre-tool-use/block-sleep-poll.ts"], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command, ...(bgFlag ? { run_in_background: true } : {}) } }),
      encoding: "utf8",
      timeout: 15_000,
      env,
    });
  };
  it("denies a bare background command with the pane message", () => {
    const out = JSON.parse(hook("npx vitest run", true)).hookSpecificOutput;
    expect(out.permissionDecision).toBe("deny");
    expect(out.permissionDecisionReason).toContain(BACKGROUND_DENY_MESSAGE);
  });
  it("allows pai pane run in the background and leaves the foreground alone", () => {
    expect(hook("pai pane run -- sleep 1", true)).toBe("");
    expect(hook("npx vitest run", false)).toBe("");
  });
});
