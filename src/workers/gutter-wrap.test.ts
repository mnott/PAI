import { describe, it, expect } from "vitest";
import { makeColor } from "./render.js";
import { gutterFor } from "./render.js";
import { gutterBody } from "./viewer.js";
import { cellWidth, expandTabs, visibleWidth } from "./chatui.js";

const plain = makeColor(false);
const gutter = gutterFor(plain, { _ts: "2026-10-24T10:00:00Z" }, undefined, 0)!;
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

/** every row starts with the gutter (time or blank + bar) and fits the width */
function check(body: string[], width: number): string[] {
  const rows = gutterBody(body, gutter, width);
  for (const r of rows) {
    const t = strip(r);
    expect(t.slice(0, gutter.width)).toMatch(/^[\d: ]{8} │ $/);
    expect(visibleWidth(t)).toBeLessThanOrEqual(width);
    expect(t).not.toContain("\n");
    expect(t).not.toContain("\t");
  }
  return rows;
}

describe("gutter wrap keeps continuation rows under the gutter", () => {
  it("measures width: wide = 2, marks = 0, tabs expand", () => {
    expect(cellWidth("日".codePointAt(0)!)).toBe(2);
    expect(cellWidth("😀".codePointAt(0)!)).toBe(2);
    expect(cellWidth("ä".codePointAt(0)!)).toBe(1);
    expect(cellWidth(0x301)).toBe(0);
    expect(visibleWidth("日本")).toBe(4);
    expect(expandTabs("a\tb")).toBe("a       b");
  });
  it("(a) ANSI colour codes", () => {
    const c = makeColor(true);
    check([c("red", "word ".repeat(30)), c("dim", "x".repeat(80))], 40);
  });
  it("(b) wide and multi-byte characters", () => {
    const rows = check(["│ — äöü 😀 日本語日本語日本語日本語日本語日本語 ".repeat(4)], 40);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.join("")).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/); // no split surrogate
    check(["😀".repeat(40), "日".repeat(40)], 30);
  });
  it("(c) tabs", () => {
    check(["a\tb\tc\t" + "word\t".repeat(20)], 40);
  });
  it("(d) one unbroken token longer than the width", () => {
    const rows = check(["y".repeat(200)], 40);
    expect(rows.length).toBeGreaterThan(5);
  });
  it("(e) embedded newlines", () => {
    const rows = check(["first line\nsecond line\n\nthird " + "z".repeat(60)], 40);
    expect(strip(rows[0]!)).toContain("first line");
    expect(rows.length).toBeGreaterThanOrEqual(5);
  });
  it("(f) width changes between lines", () => {
    for (const w of [80, 50, 30, 24, 80]) check(["one two three ".repeat(10), "日本語 ".repeat(15)], w);
  });
  it("width at or under the gutter does not wrap or throw", () => {
    expect(gutterBody(["abc"], gutter, gutter.width)).toHaveLength(1);
  });
});
