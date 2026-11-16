import { mkdirSync, mkdtempSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { latestMergeGateLog, MERGE_GATE_KEEP, parseGateFailure, saveMergeGateLog } from "./gate-log.js";

describe("parseGateFailure", () => {
  it("parses vitest", () => {
    const out = " FAIL  src/a.test.ts > suite > does x\nAssertionError: expected 1 to be 2\n  at foo\n";
    const f = parseGateFailure(out);
    expect(f.names).toEqual(["src/a.test.ts > suite > does x"]);
    expect(f.assert).toBe("AssertionError: expected 1 to be 2");
  });
  it("parses node:test TAP (error block before not ok)", () => {
    const out = "AssertionError [ERR_ASSERTION]: boom\n    at x\nnot ok 3 - the thing\n";
    const f = parseGateFailure(out);
    expect(f.names).toEqual(["the thing"]);
    expect(f.assert).toContain("AssertionError");
  });
  it("parses node:test YAML error block", () => {
    const f = parseGateFailure("not ok 1 - t\n  ---\n  error: |-\n    Expected values to be strictly equal:\n  name: 'AssertionError'\n");
    expect(f.assert).toBe("Expected values to be strictly equal:");
  });
  it("parses pytest", () => {
    const out = "FAILED tests/test_a.py::test_b - assert 1 == 2\nE   assert 1 == 2\n";
    const f = parseGateFailure(out);
    expect(f.names).toEqual(["tests/test_a.py::test_b"]);
    expect(f.assert).toBe("E   assert 1 == 2".trim());
  });
  it("caps the assertion line at 400 chars", () => {
    expect(parseGateFailure(`FAIL a > b\nError: ${"x".repeat(900)}\n`).assert.length).toBe(400);
  });
  it("hints a stale dist/", () => {
    const repo = mkdtempSync(join(tmpdir(), "gl-"));
    mkdirSync(join(repo, "dist"));
    mkdirSync(join(repo, "src"));
    utimesSync(join(repo, "dist"), 1000, 1000);
    const f = parseGateFailure(`FAIL a > b\nError: x at ${join(repo, "dist")}/m.js\n`, repo);
    expect(f.hints).toEqual(["dist/ is older than src/: run the build first"]);
  });
});

describe("saveMergeGateLog", () => {
  it("writes the full output and keeps the last runs", () => {
    const dir = mkdtempSync(join(tmpdir(), "gl-"));
    let p = "";
    for (let i = 0; i < MERGE_GATE_KEEP + 3; i++) p = saveMergeGateLog(dir, "w1", `run ${i}`, new Date(2026, 0, 1, 0, 0, i))!;
    expect(readFileSync(p, "utf8")).toBe(`run ${MERGE_GATE_KEEP + 2}`);
    expect(latestMergeGateLog(dir, "w1")).toBe(p);
    expect(p).toContain("w1.merge-gate-");
  });
});
