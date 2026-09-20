import { describe, it, expect } from "vitest";
import { applyHandoverBudget, HANDOVER_CHAR_BUDGET } from "./handover-budget.js";

const SOURCE = "/tmp/TODO.md";

function field(key: string, charCount: number): string {
  return `${key}=${"x".repeat(Math.max(0, charCount - key.length - 1))}`;
}

describe("applyHandoverBudget", () => {
  it("returns the body unchanged when under budget", () => {
    const body = "T\ng=finish the thing\nz=all good";
    const result = applyHandoverBudget(body, SOURCE, 2400);
    expect(result).toEqual({ body, elided: [], truncated: false });
  });

  it("elides only d= when that alone brings the body under budget", () => {
    const budget = 200;
    const body = ["T", "g=goal line", field("d", 300), "z=state"].join("\n");
    const result = applyHandoverBudget(body, SOURCE, budget);
    expect(result.elided).toEqual(["d"]);
    expect(result.truncated).toBe(false);
    expect(result.body).toContain(`d= elided, 300 chars; full text in ${SOURCE} (## Continue)`);
    expect(result.body).toContain("g=goal line");
    expect(result.body).toContain("z=state");
    expect(result.body.length).toBeLessThanOrEqual(budget);
  });

  it("elides both d= and t= when d= alone is not enough", () => {
    const budget = 200;
    const body = ["T", "g=goal line", field("d", 300), field("t", 300), "z=state"].join("\n");
    const result = applyHandoverBudget(body, SOURCE, budget);
    expect(result.elided).toEqual(["d", "t"]);
    expect(result.truncated).toBe(false);
    expect(result.body).toContain(`d= elided, 300 chars; full text in ${SOURCE} (## Continue)`);
    expect(result.body).toContain(`t= elided, 300 chars; full text in ${SOURCE} (## Continue)`);
    expect(result.body).toContain("g=goal line");
    expect(result.body).toContain("z=state");
  });

  it("hard-truncates prose with no Agentish fields", () => {
    const budget = 50;
    const body = "This is a long plain-prose handover with no fields at all, just text. ".repeat(5);
    const result = applyHandoverBudget(body, SOURCE, budget);
    expect(result.truncated).toBe(true);
    expect(result.elided).toEqual([]);
    expect(result.body.startsWith(body.slice(0, budget))).toBe(true);
    expect(result.body).toContain(`[handover truncated at ${budget} chars; full text in ${SOURCE} (## Continue)]`);
  });

  it("hard-truncates when eliding d= and t= still leaves the body over budget", () => {
    const budget = 60;
    const body = ["T", "g=goal line", field("d", 300), field("t", 300), "z=state"].join("\n");
    const result = applyHandoverBudget(body, SOURCE, budget);
    expect(result.elided).toEqual(["d", "t"]);
    expect(result.truncated).toBe(true);
    expect(result.body).toContain(`[handover truncated at ${budget} chars; full text in ${SOURCE} (## Continue)]`);
  });

  it("keeps the preamble, g=, @n and z= lines verbatim", () => {
    const budget = 150;
    const body = [
      "T",
      "",
      "g=finish the audit",
      "@1=src/audit/severity.ts:190",
      field("d", 400),
      "z=part C in progress",
    ].join("\n");
    const result = applyHandoverBudget(body, SOURCE, budget);
    expect(result.body).toContain("T\n\ng=finish the audit");
    expect(result.body).toContain("@1=src/audit/severity.ts:190");
    expect(result.body).toContain("z=part C in progress");
    expect(result.elided).toEqual(["d"]);
  });

  it("drops a multi-line field (with continuation lines) as a whole when elided", () => {
    const budget = 150;
    const body = [
      "T",
      "g=goal",
      "d=did the first thing",
      `  ${"x".repeat(100)}`,
      `  ${"y".repeat(100)}`,
      "z=state",
    ].join("\n");
    const result = applyHandoverBudget(body, SOURCE, budget);
    expect(result.body).not.toContain("xxx");
    expect(result.body).not.toContain("yyy");
    expect(result.body).toContain("d= elided,");
    expect(result.elided).toEqual(["d"]);
  });

  it("uses the exported HANDOVER_CHAR_BUDGET as the default budget", () => {
    const body = "z=" + "x".repeat(HANDOVER_CHAR_BUDGET * 2);
    const result = applyHandoverBudget(body, SOURCE);
    expect(result.truncated).toBe(true);
    expect(result.body.length).toBeLessThan(body.length);
  });

  it("with realistic ~2300-char body and default 1600 budget: elides d= only, keeps g= and z= verbatim", () => {
    const preamble = "T";
    const i = "i=" + "x".repeat(23);
    const g = "g=" + "x".repeat(358);
    const d = "d=" + "x".repeat(968);
    const t = "t=" + "x".repeat(238);
    const pointers = [
      "@1=" + "x".repeat(33),
      "@2=" + "x".repeat(33),
      "@3=" + "x".repeat(33),
      "@4=" + "x".repeat(33),
      "@5=" + "x".repeat(33),
    ];
    const z = "z=" + "x".repeat(528);
    const body = [preamble, i, g, d, t, ...pointers, z].join("\n");
    const result = applyHandoverBudget(body, SOURCE);
    expect(result.elided).toEqual(["d"]);
    expect(result.truncated).toBe(false);
    expect(result.body).toContain(g);
    expect(result.body).toContain(z);
    expect(result.body).toContain("d= elided,");
    expect(result.body.length).toBeLessThanOrEqual(HANDOVER_CHAR_BUDGET);
  });
});
