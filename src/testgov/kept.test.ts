/**
 * kept.test.ts — the append-only ledger writer behind `pai tests keep`
 * (2026-11-23: a local model rewrote tests/KEPT.md wholesale twice, dropping
 * 8 then ~40 rows; the verb exists so nobody edits the ledger by hand).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { appendKept, keptLedgerPath, parseKept, renderKept, KEPT_HEADER, type KeptEntry } from "./kept.js";

describe("appendKept — one row, never a rewrite", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join("/tmp", "kept-"));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("appends to an existing ledger and keeps every prior row byte-identical", () => {
    const before: KeptEntry[] = [
      { file: "tests/a.test.ts", classes: ["a"], evidence: "guarded the off-by-one in #123" },
      { file: "tests/b.test.ts", classes: ["b", "c"], evidence: "pins the destructive-op block" },
    ];
    mkdirSync(join(base, "tests"), { recursive: true });
    writeFileSync(join(base, "tests", "KEPT.md"), renderKept(before));
    const r = appendKept(base, "tests/c.test.ts", ["c"], "pins the MCP contract");
    expect(r.added).toBe(true);
    expect(r.path).toBe(join(base, "tests", "KEPT.md"));
    const text = readFileSync(join(base, "tests", "KEPT.md"), "utf8");
    // every prior row byte-identical: the old file is a prefix of the new one
    expect(text.startsWith(renderKept(before))).toBe(true);
    expect(text).toContain("| tests/c.test.ts | c | pins the MCP contract |");
    expect(parseKept(text)).toEqual([...before, { file: "tests/c.test.ts", classes: ["c"], evidence: "pins the MCP contract" }]);
  });

  it("refuses a duplicate: prints the existing row, writes nothing", () => {
    const before: KeptEntry[] = [{ file: "tests/a.test.ts", classes: ["a"], evidence: "guarded #1" }];
    mkdirSync(join(base, "tests"), { recursive: true });
    writeFileSync(join(base, "tests", "KEPT.md"), renderKept(before));
    const r = appendKept(base, "tests/a.test.ts", ["b"], "different evidence");
    expect(r.added).toBe(false);
    expect(r.existing).toEqual({ file: "tests/a.test.ts", classes: ["a"], evidence: "guarded #1" });
    expect(readFileSync(join(base, "tests", "KEPT.md"), "utf8")).toBe(renderKept(before));
  });

  it("creates a missing ledger with its header and the one row", () => {
    const r = appendKept(base, "tests/new.test.ts", ["a"], "guarded the crash in #9");
    expect(r.added).toBe(true);
    expect(r.path).toBe(join(base, "tests", "KEPT.md"));
    expect(existsSync(join(base, "tests"))).toBe(true);
    const text = readFileSync(r.path, "utf8");
    expect(text.startsWith(KEPT_HEADER)).toBe(true);
    expect(parseKept(text)).toEqual([{ file: "tests/new.test.ts", classes: ["a"], evidence: "guarded the crash in #9" }]);
  });

  it("appends to an existing Tests/KEPT.md (case-insensitive volumes resolve to the same file)", () => {
    const before: KeptEntry[] = [{ file: "Tests/x.test.ts", classes: ["b"], evidence: "pins a guard" }];
    mkdirSync(join(base, "Tests"));
    writeFileSync(join(base, "Tests", "KEPT.md"), renderKept(before));
    const r = appendKept(base, "Tests/y.test.ts", ["c"], "pins a contract");
    // on a case-insensitive volume both spellings are the same file; the row must land once
    expect(r.added).toBe(true);
    const text = readFileSync(join(base, "Tests", "KEPT.md"), "utf8");
    expect(parseKept(text)).toEqual([...before, { file: "Tests/y.test.ts", classes: ["c"], evidence: "pins a contract" }]);
    expect(text).toContain("| Tests/y.test.ts | c | pins a contract |");
  });

  it("keptLedgerPath falls back to tests/KEPT.md when neither exists", () => {
    expect(keptLedgerPath(base)).toBe(join(base, "tests", "KEPT.md"));
  });
});

describe("KEPT.md merges with the union driver", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join("/tmp", "kept-merge-"));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const git = (args: string[]) => execFileSync("git", ["-C", base, ...args], { encoding: "utf8" });

  it("two branches appending different rows merge cleanly with both rows present", () => {
    git(["init", "-q"]);
    git(["config", "user.email", "t@t.t"]);
    git(["config", "user.name", "t"]);
    mkdirSync(join(base, "tests"), { recursive: true });
    writeFileSync(join(base, ".gitattributes"), "tests/KEPT.md merge=union\n");
    writeFileSync(join(base, "tests", "KEPT.md"), renderKept([{ file: "tests/base.test.ts", classes: ["a"], evidence: "base row" }]));
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "base"]);
    git(["checkout", "-q", "-b", "side1"]);
    appendKept(base, "tests/one.test.ts", ["a"], "row from side1");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "side1 row"]);
    git(["checkout", "-q", "master"]);
    appendKept(base, "tests/two.test.ts", ["b"], "row from side2");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "side2 row"]);
    git(["merge", "-q", "side1"]); // union driver: no conflict
    const text = readFileSync(join(base, "tests", "KEPT.md"), "utf8");
    expect(text).not.toContain("<<<<<<<");
    expect(parseKept(text)).toEqual([
      { file: "tests/base.test.ts", classes: ["a"], evidence: "base row" },
      { file: "tests/two.test.ts", classes: ["b"], evidence: "row from side2" },
      { file: "tests/one.test.ts", classes: ["a"], evidence: "row from side1" },
    ]);
  });
});
