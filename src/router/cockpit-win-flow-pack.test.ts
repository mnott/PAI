/**
 * Row flow packs cards onto one line while their least widths fit: a stored width share is a preference that yields
 * before a card is pushed to the next line. Pure: layout() on a row at 540 px.
 */

import { describe, expect, it } from "vitest";
import { WIN_LAYOUT_JS } from "./cockpit-page/win/layout.js";
import { WIN_TREE_JS } from "./cockpit-page/win/tree.js";

type Lay = (t: unknown, k: unknown, box: { w: number }, st: unknown, cfg: unknown) => { rects: Record<string, { x: number; y: number; w: number }> };
const api = new Function(`${WIN_TREE_JS}\n${WIN_LAYOUT_JS}\nreturn {leaf:leaf,split:split,layout:layout};`)() as { leaf: (id: string) => unknown; split: (d: string, ch: unknown[], sz: number[]) => unknown; layout: Lay };
const cfg = { HEAD_H: 28, GAP: 8, GUTTER: 8, minW: 120 };

/** Line assignment: ids grouped by y, in x order. */
const lines = (ids: string[], sz: number[], st: unknown, w: number) => {
  const t = api.split("r", ids.map((i) => api.leaf(i)), sz);
  const r = api.layout(t, {}, { w }, st, cfg);
  const ys = [...new Set(ids.map((i) => r.rects[i]!.y))].sort((a, b) => a - b);
  return ys.map((y) => ids.filter((i) => r.rects[i]!.y === y).sort((a, b) => r.rects[a]!.x - r.rects[b]!.x));
};

describe("row flow packing (pure, 540 px)", () => {
  const ids = ["memory", "swap", "wired", "compressed"];
  it("memory 1/3 then three autos stay on one line (shares yield)", () => {
    const l = lines(ids, [0.25, 0.25, 0.25, 0.25], { memory: { sp: 3 } }, 540);
    console.log("LINES " + JSON.stringify(l));
    expect(l).toEqual([ids]);
  });
  it("four autos with one share on each of two cards stay on one line", () => {
    expect(lines(ids, [0.25, 0.25, 0.25, 0.25], { memory: { sp: 3 }, swap: { sp: 3 } }, 540)).toEqual([ids]);
  });
  it("widths fill the row and hold the least width", () => {
    const t = api.split("r", ids.map((i) => api.leaf(i)), [0.25, 0.25, 0.25, 0.25]);
    const r = api.layout(t, {}, { w: 540 }, { memory: { sp: 3 } }, cfg);
    const ws = ids.map((i) => r.rects[i]!.w);
    expect(ws.every((x) => x >= 120 - 0.01)).toBe(true);
    expect(Math.round(ws.reduce((a, b) => a + b, 0) + 24)).toBe(540);
  });
  it("when even the least widths do not fit, the last card wraps", () => {
    expect(lines(ids, [0.25, 0.25, 0.25, 0.25], { memory: { sp: 3 } }, 440)).toEqual([["memory", "swap", "wired"], ["compressed"]]);
  });
  it("a 1/2 share keeps its half when the rest fits", () => {
    const t = api.split("r", ["a", "b", "c"].map((i) => api.leaf(i)), [1, 1, 1]);
    const r = api.layout(t, {}, { w: 900 }, { a: { sp: 2 } }, cfg);
    expect(Math.round(r.rects.a!.w)).toBe(446);
  });
});
