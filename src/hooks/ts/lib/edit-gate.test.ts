import { describe, it, expect } from "vitest";
import { isProseEdit, decideEditGate, type EditGateContext } from "./edit-gate.js";

describe("isProseEdit", () => {
  it.each([
    ["Notes/TODO.md", true],
    ["notes/x.md", true],
    ["README.md", true],
    ["docs/commands/worker.md", true],
    ["src/workers/run.ts", false],
    ["package.json", false],
    ["scripts/build-hooks.mjs", false],
    ["src/foo.md", true],
  ])("%s -> %s", (filePath, expected) => {
    expect(isProseEdit(filePath)).toBe(expected);
  });
});

describe("decideEditGate", () => {
  function ctx(overrides: Partial<EditGateContext>): EditGateContext {
    return {
      filePath: "/repo/src/workers/run.ts",
      isPaiWorker: false,
      isExemptPrefix: false,
      isGitWorkTree: true,
      ...overrides,
    };
  }

  it("allows a prose path even inside a git work tree", () => {
    expect(decideEditGate(ctx({ filePath: "/repo/Notes/TODO.md" }))).toEqual({ decision: "allow" });
  });

  it("blocks a code path inside a git work tree with the standing message", () => {
    const out = decideEditGate(ctx({}));
    expect(out.decision).toBe("block");
    expect((out as { reason: string }).reason).toContain("main session does not edit code");
    expect((out as { reason: string }).reason).toContain("pai worker run");
  });

  it("tells the session this is a standing policy, not a one-off error, and names the next step", () => {
    const out = decideEditGate(ctx({}));
    const reason = (out as { reason: string }).reason;
    expect(reason).toContain("standing policy for the whole session");
    expect(reason).toContain("retrying Edit/Write");
    expect(reason).toContain("--provider anthropic");
    expect(reason).toContain(ctx({}).filePath);
  });

  it("allows worker sessions regardless of path", () => {
    expect(decideEditGate(ctx({ isPaiWorker: true }))).toEqual({ decision: "allow" });
  });

  it("allows exempt prefixes regardless of path", () => {
    expect(decideEditGate(ctx({ isExemptPrefix: true }))).toEqual({ decision: "allow" });
  });

  it("allows paths outside any git work tree", () => {
    expect(decideEditGate(ctx({ isGitWorkTree: false }))).toEqual({ decision: "allow" });
  });
});
