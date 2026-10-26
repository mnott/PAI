import { describe, it, expect } from "vitest";
import { evaluate, type GuardContext } from "./evaluate.js";
import { emptyLoopState, REVERT_STOP_AT, type LoopState } from "../hooks/ts/lib/loop-guard.js";
import { loadRules, allRuleDirs } from "../hooks/ts/lib/rules/load.js";
import type { Rule } from "../hooks/ts/lib/rules/types.js";

const cwd = process.cwd();
const rules = loadRules(allRuleDirs(cwd)).rules;
const fired: unknown[] = [];
const base = (): GuardContext => ({ env: {}, record: (f) => fired.push(f) });

const bash = (command: string) => ({ kind: "tool_call" as const, tool: "Bash", input: { command }, cwd });

/** Feeds Write calls through evaluate, threading the loop state like the hook does. */
function writes(contents: string[]) {
  let state: LoopState = emptyLoopState();
  return contents.map((content) => {
    const d = evaluate({ kind: "tool_call", tool: "Write", input: { file_path: "/tmp/out/a.py", content }, cwd }, { ...base(), loop: { state, now: 1 } });
    state = d.loop!.state;
    return d;
  });
}

describe("evaluate", () => {
  it("denies a command matching a shell rule", () => {
    const d = evaluate(bash("git reset --hard HEAD~1"), { ...base(), shellRules: rules });
    expect(d.action).toBe("deny");
    expect(d.mode).toBe("enforce");
    expect(d.rule?.severity).toBeDefined();
    expect(fired).toContainEqual(expect.objectContaining({ id: d.patternId, category: "shell", action: "deny", mode: "enforce" }));
  });

  it("allows an ordinary command", () => {
    expect(evaluate(bash("ls -la"), { ...base(), shellRules: rules })).toEqual({ action: "allow" });
  });

  it("notes an identical Write repeat", () => {
    const d = writes(["x = 1\n", "x = 1\n"])[1];
    expect(d).toMatchObject({ action: "note", patternId: "identical-write", mode: "enforce" });
    expect(d.message).toContain("already contains exactly this content");
  });

  it("stops an A,B,A,B revert oscillation", () => {
    const ds = writes(Array.from({ length: REVERT_STOP_AT + 2 }, (_, i) => (i % 2 ? "B" : "A")));
    expect(ds[ds.length - 1]).toMatchObject({ action: "stop", patternId: "revert", mode: "enforce" });
    expect(ds.slice(0, -1).every((d) => d.action !== "stop")).toBe(true);
  });

  it("continues on a final text that is an unparsed tool call", () => {
    const d = evaluate({ kind: "final_text", text: "Done.\n<invoke name=\"Bash\"><parameter name=\"command\">ls</parameter></invoke>", cwd }, base());
    expect(d).toMatchObject({ action: "continue", patternId: "unparsed-tool-call", mode: "enforce", unparsed: { name: "Bash" } });
    expect(evaluate({ kind: "final_text", text: "All done.", cwd }, base())).toEqual({ action: "allow" });
  });

  it("records a monitor-mode rule and lets the command through", () => {
    const monitorRule: Rule = { id: "demo-monitor", severity: "block", match: "\\bdemo-danger\\b", reason: "demo", mode: "monitor" };
    const before = fired.length;
    const d = evaluate(bash("demo-danger now"), { ...base(), shellRules: [monitorRule] });
    expect(d).toMatchObject({ action: "allow", patternId: "demo-monitor", mode: "monitor" });
    expect(fired.slice(before)).toEqual([expect.objectContaining({ id: "demo-monitor", action: "deny", mode: "monitor" })]);
  });
});
