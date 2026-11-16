import { describe, it, expect } from "vitest";
import { decideDelegationGate, latestOperatorPromptFromJsonl, L0_ROUTE_REASON, MODEL_OVERRIDE_REASON, PANE_REASON, SEARCH_ROOT_REASON, DELEGATION_BLOCK } from "./delegation-gate.js";

const L0 = {} as NodeJS.ProcessEnv;
const W = { PAI_WORKER: "1" } as NodeJS.ProcessEnv;
const d = (c: string, e = L0, p?: string) => decideDelegationGate(c, e, p);

describe("L0 routes", () => {
  for (const cls of ["implement", "simple", "orchestrate", "plan"]) {
    it(`allows --class ${cls}`, () => expect(d(`pai worker run --class ${cls} -p x`).decision).toBe("allow"));
  }
  it("allows --class=implement", () => expect(d("pai worker run --class=implement -p x").decision).toBe("allow"));
  for (const c of ["pai worker run --class research -p x", "pai worker run -p x", "pai worker run --class spotcheck"]) {
    it(`denies ${c}`, () => expect(d(c)).toEqual({ decision: "deny", reason: L0_ROUTE_REASON }));
  }
  it("exempts a worker", () => expect(d("pai worker run --class research -p x", W).decision).toBe("allow"));
  it("ignores other pai commands", () => expect(d("pai worker ps").decision).toBe("allow"));
  for (const c of ["pai worker run --help", "pai worker run -h", "cd /x && pai worker run --help"]) {
    it(`allows ${c} from L0`, () => expect(d(c).decision).toBe("allow"));
  }
});

describe("pane rule", () => {
  for (const c of [
    "pai worker run --class implement --no-pane -p x",
    "PAI_WORKER_AUTOPANE=0 pai worker run --class implement",
    "PAI_WORKER= pai worker resume abc",
    "touch ~/x/headless-ok",
    "PAI_HEADLESS_OK_FILE=/tmp/f ls",
  ]) it(`denies ${c}`, () => expect(d(c)).toEqual({ decision: "deny", reason: PANE_REASON }));
  it("exempts a worker", () => expect(d("pai worker run --no-pane", W).decision).toBe("allow"));
  it("allows a plain resume", () => expect(d("pai worker resume abc").decision).toBe("allow"));
});

describe("model override rule", () => {
  const c = "pai worker run --class orchestrate --model claude-opus-5-5 -p x";
  it("denies --model with no prompt", () => expect(d(c)).toEqual({ decision: "deny", reason: MODEL_OVERRIDE_REASON }));
  it("denies --model with an unrelated prompt", () => expect(d(c, L0, "fix the bug")).toEqual({ decision: "deny", reason: MODEL_OVERRIDE_REASON }));
  it("allows when the operator names the family word", () => expect(d(c, L0, "run it on opus").decision).toBe("allow"));
  it(`denies --provider glm with prompt "use kimi"`, () => expect(d("pai worker run --class implement --provider glm -p x", L0, "use kimi")).toEqual({ decision: "deny", reason: MODEL_OVERRIDE_REASON }));
  it(`allows --provider glm with prompt "do it on glm"`, () => expect(d("pai worker run --class implement --provider glm -p x", L0, "do it on glm").decision).toBe("allow"));
  it("denies the --model=X form", () => expect(d("pai worker run --class orchestrate --model=claude-opus-5-5 -p x")).toEqual({ decision: "deny", reason: MODEL_OVERRIDE_REASON }));
  it("exempts a worker", () => expect(d(c, W, undefined).decision).toBe("allow"));
  it("leaves a run without --model/--provider unchanged", () => expect(d("pai worker run --class orchestrate -p x", L0, "fix the bug").decision).toBe("allow"));
  it('"claude" in a prompt does not authorise claude-opus-5-5', () => expect(d(c, L0, "use claude for this").decision).toBe("deny"));
  it("denies on resume too", () => expect(d("pai worker resume abc --model claude-opus-5-5")).toEqual({ decision: "deny", reason: MODEL_OVERRIDE_REASON }));
});

describe("transcript tail extractor", () => {
  const u = (content: unknown) => JSON.stringify({ type: "user", message: { role: "user", content } });
  const a = (text: string) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
  it("takes the last plain-text user entry", () => {
    expect(latestOperatorPromptFromJsonl([u("first"), a("ok"), u("fix the bug"), JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "out" }] } })].join("\n"))).toBe("fix the bug");
  });
  it("takes a text block among tool_results", () => {
    expect(latestOperatorPromptFromJsonl(u([{ type: "text", text: "run it on opus" }, { type: "tool_result", content: "x" }]))).toBe("run it on opus");
  });
  it("skips notifications and other sessions", () => {
    const j = [u("real one"), u("<task-notification>done</task-notification>"), u("[SYSTEM NOTIFICATION] ping"), u("[Session: abc] hi from another session")].join("\n");
    expect(latestOperatorPromptFromJsonl(j)).toBe("real one");
  });
  it("undefined when nothing genuine", () => expect(latestOperatorPromptFromJsonl([a("x"), JSON.stringify({ type: "user", isMeta: true, message: { content: "meta" } })].join("\n"))).toBeUndefined());
});

describe("search roots", () => {
  for (const c of ["find / -name x", "find ~ -name x", "rg foo ~/", "grep -rn foo $HOME", 'grep -r foo "$HOME"', "du -sh /Users/someone", "mdfind -onlyin ~ x", "cd x && find / -name y"]) {
    it(`denies ${c}`, () => expect(d(c)).toEqual({ decision: "deny", reason: SEARCH_ROOT_REASON }));
    it(`denies in a worker too: ${c}`, () => expect(d(c, W).decision).toBe("deny"));
  }
  for (const c of ["find ~/dev -name x", "rg foo src", "grep -rn foo .", "echo 'find / -x'", "grep foo file ~", "cat <<EOF\nfind / -x\nEOF"]) {
    it(`allows ${c}`, () => expect(d(c).decision).toBe("allow"));
  }
});

describe("session-start block", () => {
  it("carries routes, mode, run line and visibility", () => {
    for (const s of ["--class implement", "--class orchestrate", "pai worker mode", "--output-format json", "pai worker ps", "run_in_background"]) expect(DELEGATION_BLOCK).toContain(s);
  });
  it("carries the provider and tools rules after the Start line", () => {
    const lines = DELEGATION_BLOCK.split("\n");
    const start = lines.findIndex((l) => l.startsWith("- Start:"));
    expect(lines[start + 1]).toContain("No `--model`/`--provider` unless the operator names that model or provider in the request");
    expect(lines[start + 1]).toContain("The Agent tool is denied in this session");
    expect(lines[start + 2]).toContain("`--tools` lists keep ToolSearch");
    expect(lines[start + 2]).toContain("WebSearch,WebFetch to --allowedTools");
  });
});

import { stripDelegationSection } from "../../../cli/commands/setup/steps/04-claude-md.js";
describe("setup strips the delegation section", () => {
  it("removes the heading section only", () => {
    const t = "# A\n\n## ABSOLUTE RULE: all delegation goes through `pai worker run`\n\nx\ny\n\n## Keep\nz\n";
    expect(stripDelegationSection(t)).toBe("# A\n\n## Keep\nz\n");
  });
  it("removes a marked block", () => {
    expect(stripDelegationSection("a\n<!-- PAI:delegation:start -->\nq\n<!-- PAI:delegation:end -->\nb")).toBe("a\nb");
  });
});
