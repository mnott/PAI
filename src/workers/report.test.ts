/**
 * Tests for the worker contract report — parsing the final JSON message and
 * rendering the compact block. Pure functions only.
 */

import { describe, it, expect } from "vitest";
import { makeColor } from "./render.js";
import { OPERATOR_MARK, parseWorkerReport, renderReport, WORKER_CONTRACT_PROMPT } from "./report.js";

const sample = {
  changed: [{ path: "src/a.ts", summary: "added the guard" }],
  commands: ["npm test"],
  checks: [
    { name: "tests", ok: true, detail: "12 passed" },
    { name: "lint", ok: false, detail: "1 new error" },
  ],
  open: ["decide the retry count"],
  notes: "guard added, lint needs a look",
};

describe("parseWorkerReport", () => {
  it("parses a bare JSON final message", () => {
    expect(parseWorkerReport(JSON.stringify(sample))?.notes).toBe("guard added, lint needs a look");
  });

  it("parses a ```json fenced final message", () => {
    const text = "```json\n" + JSON.stringify(sample, null, 2) + "\n```";
    const r = parseWorkerReport(text);
    expect(r?.changed).toEqual([{ path: "src/a.ts", summary: "added the guard" }]);
    expect(r?.checks?.[1]).toEqual({ name: "lint", ok: false, detail: "1 new error" });
  });

  it("parses JSON embedded in prose (first { to last })", () => {
    const text = "Done!\n" + JSON.stringify(sample) + "\nThat's all.";
    expect(parseWorkerReport(text)?.open).toEqual(["decide the retry count"]);
  });

  it("accepts a partial report (any of changed/checks/notes is the fingerprint)", () => {
    expect(parseWorkerReport('{"changed":[],"notes":"x"}')?.notes).toBe("x");
    expect(parseWorkerReport('{"changed":[],"checks":[]}')?.changed).toEqual([]);
  });

  it("rejects JSON that does not look like the contract", () => {
    expect(parseWorkerReport('{"foo":1,"bar":[2]}')).toBeNull();
    expect(parseWorkerReport('["changed","checks"]')).toBeNull();
  });

  it("returns null for plain prose", () => {
    expect(parseWorkerReport("All done, tests green.")).toBeNull();
    expect(parseWorkerReport("")).toBeNull();
  });
});

describe("renderReport", () => {
  const c = makeColor(false); // plain: assert the text, not the colors
  const r = parseWorkerReport(JSON.stringify(sample))!;

  it("renders changed paths, checks with marks, notes", () => {
    const lines = renderReport(c, "  ", r, "/repo").join("\n");
    expect(lines).toContain("changed");
    expect(lines).toContain("src/a.ts — added the guard");
    expect(lines).toContain("✓ tests");
    expect(lines).toContain("12 passed");
    expect(lines).toContain("✗ lint");
    expect(lines).toContain("1 new error");
    expect(lines).toContain("open");
    expect(lines).toContain("decide the retry count");
    expect(lines).toContain("guard added, lint needs a look");
  });

  it("shortens changed paths against cwd", () => {
    const lines = renderReport(c, "", { ...r, changed: [{ path: "/repo/src/a.ts", summary: "s" }] }, "/repo");
    expect(lines.join("\n")).toContain("src/a.ts — s");
    expect(lines.join("\n")).not.toContain("/repo/src/a.ts");
  });

  it("skips empty sections, keeps the notes line labelled", () => {
    const lines = renderReport(c, "", { changed: [], commands: [], checks: [], open: [], notes: "nothing" }, "");
    expect(lines.join("\n")).toBe("notes  nothing");
  });
});

describe("WORKER_CONTRACT_PROMPT", () => {
  it("names the exact JSON keys the parser expects", () => {
    expect(WORKER_CONTRACT_PROMPT).toContain('"changed"');
    expect(WORKER_CONTRACT_PROMPT).toContain('"checks"');
    expect(WORKER_CONTRACT_PROMPT).toContain('"notes"');
    expect(WORKER_CONTRACT_PROMPT).toContain("final message");
  });

  it("tells the worker to answer [operator] messages first, then continue", () => {
    expect(WORKER_CONTRACT_PROMPT).toContain(OPERATOR_MARK);
    expect(WORKER_CONTRACT_PROMPT).toContain("Answer it FIRST");
    expect(WORKER_CONTRACT_PROMPT).toContain("then continue the");
  });

  it("bans shell heredocs: write a script file, then run it", () => {
    expect(WORKER_CONTRACT_PROMPT).toMatch(/heredoc/i);
    expect(WORKER_CONTRACT_PROMPT).toContain("Write tool");
    expect(WORKER_CONTRACT_PROMPT).toMatch(/write the script to a file/);
  });

  it("bans inline interpreter one-liners: permission layer denies them, write a script file or use jq", () => {
    expect(WORKER_CONTRACT_PROMPT).toMatch(/python3 -c/);
    expect(WORKER_CONTRACT_PROMPT).toMatch(/node -e/);
    expect(WORKER_CONTRACT_PROMPT).toMatch(/ruby -e/);
    expect(WORKER_CONTRACT_PROMPT).toMatch(/permission layer\s+denies/i);
    expect(WORKER_CONTRACT_PROMPT).toMatch(/command denied by permission rules/);
    expect(WORKER_CONTRACT_PROMPT).toMatch(/python3 script\.py/);
    expect(WORKER_CONTRACT_PROMPT).toMatch(/use jq/);
  });
});
