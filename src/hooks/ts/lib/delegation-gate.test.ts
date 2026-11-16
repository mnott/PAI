import { describe, it, expect } from "vitest";
import { decideDelegationGate, L0_ROUTE_REASON, PANE_REASON, SEARCH_ROOT_REASON, DELEGATION_BLOCK } from "./delegation-gate.js";

const L0 = {} as NodeJS.ProcessEnv;
const W = { PAI_WORKER: "1" } as NodeJS.ProcessEnv;
const d = (c: string, e = L0) => decideDelegationGate(c, e);

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
    expect(lines[start + 1]).toContain("No `--provider` unless the operator names one");
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
