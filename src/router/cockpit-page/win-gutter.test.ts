import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Same extraction trick as win-tree.test.ts: the string is the whole contract here.
const treeSrc = readFileSync(fileURLToPath(new URL("./win/tree.ts", import.meta.url)), "utf8");
const tm = treeSrc.match(/export const WIN_TREE_JS = String\.raw`([\s\S]*?)`;/);
if (!tm) throw new Error("WIN_TREE_JS not found in win/tree.ts");
const laySrc = readFileSync(fileURLToPath(new URL("./win/layout.ts", import.meta.url)), "utf8");
const lm = laySrc.match(/export const WIN_LAYOUT_JS = String\.raw`([\s\S]*?)`;/);
if (!lm) throw new Error("WIN_LAYOUT_JS not found in win/layout.ts");
const gutSrc = readFileSync(fileURLToPath(new URL("./win/gutter.ts", import.meta.url)), "utf8");
const gm = gutSrc.match(/export const WIN_GUTTER_JS = String\.raw`([\s\S]*?)`;/);
if (!gm) throw new Error("WIN_GUTTER_JS not found in win/gutter.ts");
const api = (new Function(
  `${tm[1]}\n${lm[1]}\n${gm[1]}\nreturn {leaf:leaf,split:split,layout:layout,resizeSplit:resizeSplit,gutterAt:gutterAt,winGutterKey:winGutterKey};`,
) as any)();
const leaf = (id: string) => api.leaf(id);
const split = (d: string, ch: any[], sz: number[]) => api.split(d, ch, sz);
const layout = api.layout as (
  tree: any,
  kids: any,
  box: { w: number; h?: number },
  state: any,
  cfg: any,
) => { rects: { [id: string]: { x: number; y: number; w: number; h: number; body: { w: number; h: number } } }; height: number };
const resizeSplit = api.resizeSplit as (...a: any[]) => any;
const gutterAt = api.gutterAt as (...a: any[]) => any;
const winGutterKey = api.winGutterKey as (...a: any[]) => any;

const cfg = {
  HEAD_H: 28,
  GAP: 8,
  GUTTER: 8,
  minW: 220,
  minH: 80,
  defaultH: 300,
  types: {
    metric: { minW: 120, minH: 80, defaultH: 120 },
    chart: { minW: 300, minH: 150, defaultH: 260 },
    // plain test leaves are "leaf" cards (cfg.leafTypes below): minH 80 as spec 3.3 says
    leaf: { minW: 220, minH: 80, defaultH: 300 },
  },
};
const root = (w: number) => ({ w });
const bounded = (w: number, h: number) => ({ w, h });
// leafTypes mirrors the card runtime (card.ts cfgOf): every plain test leaf is a "leaf"
// card; the chart test passes its own map
const LT = { leafTypes: { a: "leaf", b: "leaf", c: "leaf", g: "leaf" } };
const rectsOf = (t: any, box: any, state: any, kids: any) =>
  layout(t, kids || {}, box, state || {}, Object.assign({}, cfg, LT)).rects;

describe("win gutter (spec 3.3)", () => {
  it("dragging a row gutter changes only the two neighbours' weights", () => {
    const t = split("r", [leaf("a"), leaf("b"), leaf("c")], [0.4, 0.3, 0.3]);
    const rects = rectsOf(t, bounded(1008, 400), {}, {});
    const n = resizeSplit(t, [], 0, 75, rects, {}, cfg, {});
    expect(n).not.toBeNull();
    // total = 1008 - 2 gutters = 992: a +75px, b -75px; c keeps its weight (and its px)
    expect(n.sz[0]).toBeCloseTo(0.4 + 75 / 992, 6);
    expect(n.sz[1]).toBeCloseTo(0.3 - 75 / 992, 6);
    expect(n.sz[2]).toBeCloseTo(0.3, 6);
    expect(n.ch.length).toBe(3);
    // the original tree is not mutated
    expect(t.sz).toEqual([0.4, 0.3, 0.3]);
    // layout of the new tree: only a and b move; c keeps x and w
    const r2 = rectsOf(n, bounded(1008, 400), {}, {});
    expect(r2.a.w).toBeCloseTo(396.8 + 75, 6);
    expect(r2.b.x).toBeCloseTo(396.8 + 75 + 8, 6);
    expect(r2.b.w).toBeCloseTo(297.6 - 75, 6);
    expect(r2.c.w).toBeCloseTo(297.6, 6); // c keeps its px: 0.3 * 992
    expect(r2.c.x).toBeCloseTo(396.8 + 75 + 8 + 297.6 - 75 + 8, 6);
  });

  it("a row gutter inside a group body resizes only the two neighbours' weights", () => {
    // a group's kid tree is resized as a tree of its own, laid out in the body box
    const t = split("r", [leaf("a"), leaf("b")], [0.5, 0.5]);
    const rects = rectsOf(t, bounded(1008, 372), {}, {});
    const n = resizeSplit(t, [], 0, 100, rects, {}, cfg, {});
    expect(n).not.toBeNull();
    expect(n.sz[0]).toBeCloseTo(0.6, 6);
    expect(n.sz[1]).toBeCloseTo(0.4, 6);
    expect(n.ch.length).toBe(2);
    const r2 = rectsOf(n, bounded(1008, 372), {}, {});
    expect(r2.a.w).toBeCloseTo(600, 6); // 0.6 * (1008-8)
    expect(r2.b.w).toBeCloseTo(400, 6);
  });

  it("a bounded column gutter shifts weights of the height the siblings share", () => {
    const t = split("c", [leaf("a"), leaf("b")], [0.5, 0.5]);
    const b = { ...cfg, bounded: true };
    const rects = layout(t, {}, bounded(500, 408), {}, Object.assign({}, b, LT)).rects; // 200 + 8 + 200
    const n = resizeSplit(t, [], 0, 50, rects, {}, b, {});
    expect(n.sz[0]).toBeCloseTo(0.625, 6);
    expect(resizeSplit(t, [], 0, 130, rects, {}, b, {})).toBeNull(); // b would be 70 < minH 80
  });

  it("a band px gutter changes only the band", () => {
    // bands above minH: layout grows a band to its content's need, so start at 300/200/150
    const t = split("c", [leaf("a"), leaf("b"), leaf("c")], [300, 200, 150]);
    const rects = rectsOf(t, root(1000), {}, {});
    const n = resizeSplit(t, [], 0, 50, rects, {}, cfg, {});
    expect(n).not.toBeNull();
    expect(n.sz).toEqual([350, 150, 150]); // only the two bands move
    const r2 = rectsOf(n, root(1000), {}, {});
    expect(r2.a.h).toBe(350);
    expect(r2.b.y).toBe(358);
    expect(r2.b.h).toBe(150);
    expect(r2.c.y).toBe(358 + 150 + 8); // c shifted by the same 50, size unchanged
    expect(r2.c.h).toBe(150);
  });

  it("a row gutter inside a band changes the row's weights; the band px stay", () => {
    const t = split("c", [split("r", [leaf("a"), leaf("b")], [0.5, 0.5]), leaf("c")], [300, 200]);
    const rects = rectsOf(t, root(1008), {}, {});
    const n = resizeSplit(t, [0], 0, 100, rects, {}, cfg, {});
    expect(n).not.toBeNull();
    expect(n.sz).toEqual([300, 200]); // band px untouched
    expect(n.ch[0].sz[0]).toBeCloseTo(0.6, 6);
    expect(n.ch[0].sz[1]).toBeCloseTo(0.4, 6);
    const r2 = rectsOf(n, root(1008), {}, {});
    expect(r2.a.w).toBeCloseTo(600, 6);
    expect(r2.b.w).toBeCloseTo(400, 6);
    expect(r2.c.y).toBe(rects.c.y); // band positions unchanged
  });

  it("sizes do not go below minW: a refused row move returns null and changes nothing", () => {
    const t = split("r", [leaf("a"), leaf("b")], [0.5, 0.5]); // 1008 -> 500 each
    const rects = rectsOf(t, bounded(1008, 400), {}, {});
    // total 1000, minW 220: a may shrink to 220 -> max delta 280
    expect(resizeSplit(t, [], 0, 280, rects, {}, cfg, {})).not.toBeNull();
    expect(resizeSplit(t, [], 0, 281, rects, {}, cfg, {})).toBeNull();
    expect(resizeSplit(t, [], 0, -281, rects, {}, cfg, {})).toBeNull();
    // a type's own minW wins: chart minW 300 refuses at 201
    const lt = Object.assign({}, cfg, { leafTypes: { a: "chart" } });
    expect(resizeSplit(t, [], 0, -201, rects, {}, lt, {})).toBeNull();
    expect(resizeSplit(t, [], 0, -199, rects, {}, lt, {})).not.toBeNull();
    // the kids entry's type is the fallback
    expect(resizeSplit(t, [], 0, -201, rects, {}, cfg, { a: { type: "chart" } })).toBeNull();
  });

  it("band px refuse below minH", () => {
    const t = split("c", [leaf("a"), leaf("b")], [300, 200]);
    const rects = rectsOf(t, root(1000), {}, {});
    // minH 80: b may shrink to 80 -> max delta 120
    expect(resizeSplit(t, [], 0, 120, rects, {}, cfg, {})).not.toBeNull();
    expect(resizeSplit(t, [], 0, 121, rects, {}, cfg, {})).toBeNull();
    expect(resizeSplit(t, [], 0, -221, rects, {}, cfg, {})).toBeNull();
  });

  it("a minimized neighbour takes HEAD_H and cannot be resized", () => {
    const t = split("r", [leaf("a"), leaf("b")], [0.5, 0.5]);
    const rects = rectsOf(t, bounded(1008, 400), { a: { min: 1 } }, {});
    expect(resizeSplit(t, [], 0, 40, rects, { a: { min: 1 } }, cfg, {})).toBeNull();
    expect(gutterAt(t, [], 0, { a: { min: 1 } }, rects, cfg)).toBeNull();
    expect(gutterAt(t, [], 0, {}, rects, cfg)).toEqual({ path: [], index: 0, a: "a", b: "b", cell: 1008 });
  });

  it("a ghost neighbour is skipped; an invalid path or index returns null", () => {
    const t = split("r", [leaf("a"), leaf("b"), leaf("c")], [0.4, 0.3, 0.3]);
    const rects = rectsOf(t, bounded(1008, 400), { b: { seen: 1 } }, {});
    expect(resizeSplit(t, [], 0, 40, rects, { b: { seen: 1 } }, cfg, {})).toBeNull();
    expect(resizeSplit(t, [], 2, 40, rects, {}, cfg, {})).toBeNull(); // no gutter after c
    expect(resizeSplit(t, [], -1, 40, rects, {}, cfg, {})).toBeNull();
    expect(resizeSplit(t, [0], 0, 40, rects, {}, cfg, {})).toBeNull(); // no split at [0]
    expect(resizeSplit(t, [], 0, 40, {}, {}, cfg, {})).toBeNull(); // no rects -> no cell
  });

  it("resizeSplit never touches anything but the two sz entries (deep-compare the rest)", () => {
    const t = split("c", [split("r", [leaf("a"), leaf("b")], [0.5, 0.5]), leaf("c")], [300, 200]);
    const rects = rectsOf(t, root(1008), {}, {});
    const n = resizeSplit(t, [0], 0, 100, rects, {}, cfg, {});
    expect(n).not.toBeNull();
    expect(n.sz).toEqual(t.sz);
    expect(n.ch[1]).toEqual(t.ch[1]);
    expect(n.ch[0].ch).toEqual(t.ch[0].ch);
    expect(n.ch[0].sz).not.toEqual(t.ch[0].sz);
  });

  it("keyboard resize by 16 px applies and refuses at the min", () => {
    const t = split("r", [leaf("a"), leaf("b")], [0.5, 0.5]);
    const rects = rectsOf(t, bounded(1008, 400), {}, {});
    let applied: any = null;
    const opts = {
      getTree: () => t,
      getRects: () => rects,
      getState: () => ({}),
      getKids: () => ({}),
      cfg,
      apply: (n: any) => { applied = n; },
    };
    const target = {
      closest: (sel: string) => (sel === ".wgutter" ? {
        getAttribute: (k: string) => (k === "data-path" ? "" : k === "data-index" ? "0" : "x"),
      } : null),
    };
    expect(winGutterKey({ key: "ArrowRight", target }, opts, 16)).toBe(true);
    expect(applied).not.toBeNull();
    expect(applied.sz[0]).toBeCloseTo(0.5 + 16 / 1000, 6);
    // at the min, ArrowRight is refused but still "handled" (returns true, applies nothing)
    applied = null;
    const t2 = split("r", [leaf("a"), leaf("b")], [0.25, 0.75]); // a = 250, min 220
    const r2 = rectsOf(t2, bounded(1008, 400), {}, {});
    opts.getTree = () => t2;
    opts.getRects = () => r2;
    expect(winGutterKey({ key: "ArrowLeft", target }, opts, 31)).toBe(true);
    expect(applied).toBeNull();
    expect(winGutterKey({ key: "ArrowLeft", target }, opts, 30)).toBe(true);
    expect(applied).not.toBeNull();
  });
});
