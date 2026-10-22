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
const api = (new Function(
  `${tm[1]}\n${lm[1]}\nreturn {leaf:leaf,split:split,layout:layout,winColSpan:winColSpan};`,
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

const cfg = {
  HEAD_H: 28,
  GAP: 8,
  GUTTER: 8,
  minW: 220,
  defaultH: 300,
  types: {
    metric: { minW: 120, minH: 80, defaultH: 120 },
    chart: { minW: 300, minH: 150, defaultH: 260 },
  },
};
const root = (w: number) => ({ w });
const fit = (o: Record<string, number>) => ({ ...cfg, fit: o });

// Heights are content-driven: a card is as tall as its reading (cfg.fit) or its type's defaultH, a line as tall as its
// tallest card, the next line starts below it. Tests that pinned band px, weights of a bounded height, narrow defaultH
// stacking or the stretch of a row to its band were removed or rewritten: heights are now content-driven.
describe("win layout: content-driven heights", () => {
  it("two-up row: widths by weight with the gap between; every card the line height", () => {
    const t = split("r", [leaf("a"), leaf("b")], [0.5, 0.5]);
    const { rects } = layout(t, {}, root(1008), {}, fit({ a: 100, b: 180 }));
    expect(rects.a).toEqual({ x: 0, y: 0, w: 500, h: 180, body: { w: 500, h: 152 } }); // was h 100, body 72
    expect(rects.b.x).toBe(508);
    expect(rects.b.w).toBe(500);
    expect(rects.a.h).toBe(180); // the line height is the tallest card's
    expect(rects.b.h).toBe(180);
    expect(rects.b.x - (rects.a.x + rects.a.w)).toBe(cfg.GAP);
  });

  it("a column stacks its cards at their readings; height is the sum plus gaps", () => {
    const t = split("c", [leaf("a"), leaf("b")], [300, 200]);
    const { rects, height } = layout(t, {}, root(1000), {}, fit({ a: 90, b: 140 }));
    expect(rects.a).toEqual({ x: 0, y: 0, w: 1000, h: 90, body: { w: 1000, h: 62 } });
    expect(rects.b.y).toBe(98);
    expect(rects.b.h).toBe(140);
    expect(height).toBe(90 + 8 + 140);
  });

  it("the sz of a column are ignored (no band px, no weight of a height)", () => {
    const a = layout(split("c", [leaf("a"), leaf("b")], [1, 1]), {}, root(600), {}, fit({ a: 60, b: 70 }));
    const b = layout(split("c", [leaf("a"), leaf("b")], [900, 5]), {}, root(600), {}, fit({ a: 60, b: 70 }));
    expect(b).toEqual(a);
  });

  it("a card without a reading takes its type's defaultH", () => {
    const { rects } = layout(split("c", [leaf("a"), leaf("b")], [1, 1]), { a: { type: "metric" } }, root(600), {}, cfg);
    expect(rects.a.h).toBe(120);
    expect(rects.b.h).toBe(cfg.defaultH);
  });

  it("a minimized card is HEAD_H tall and its line is as tall as the rest of the line", () => {
    const row = split("r", [leaf("a"), leaf("b")], [0.5, 0.5]);
    const t = split("c", [row, leaf("below")], [400, 200]);
    const { rects, height } = layout(t, {}, root(1000), { a: { min: 1 } }, fit({ b: 150, below: 60 }));
    expect(rects.a.h).toBe(cfg.HEAD_H);
    expect(rects.a.y).toBe(0);
    expect(rects.b.h).toBe(150);
    expect(rects.below.y).toBe(158);
    expect(height).toBe(158 + 60);
  });

  it("an all-minimized line is HEAD_H tall", () => {
    const row = split("r", [leaf("a"), leaf("b")], [0.5, 0.5]);
    const t = split("c", [row, leaf("below")], [400, 200]);
    const { rects, height } = layout(t, {}, root(1000), { a: { min: 1 }, b: { min: 1 } }, fit({ below: 60 }));
    expect(rects.below.y).toBe(cfg.HEAD_H + cfg.GAP);
    expect(height).toBe(cfg.HEAD_H + cfg.GAP + 60);
  });

  it("only min===1 collapses a card; a truthy min of another type takes its full height", () => {
    const t = split("c", [leaf("a"), leaf("b")], [0.5, 0.5]);
    expect(layout(t, {}, root(600), { a: { min: 1 } }, fit({ a: 90, b: 90 })).rects.a.h).toBe(cfg.HEAD_H);
    for (const bad of [true, "1", 2]) expect(layout(t, {}, root(600), { a: { min: bad } }, fit({ a: 90, b: 90 })).rects.a.h).toBe(90);
  });

  it("a row under its least width wraps into a grid; a line is as tall as its tallest card", () => {
    // width 200: each of the two charts (minW 300) is under its least width -> one per line
    const row = split("r", [leaf("a"), leaf("b")], [0.5, 0.5]);
    const kids = { a: { type: "chart" }, b: { type: "chart" } };
    const { rects } = layout(split("c", [row], [600]), kids, root(200), {}, fit({ a: 80, b: 110 }));
    expect(rects.a.h).toBe(80);
    expect(rects.b.y).toBe(88);
    expect(rects.b.h).toBe(110);
    expect(rects.a.w).toBe(200);
  });

  it("ghosts are skipped and take no space", () => {
    const t = split("c", [leaf("a"), leaf("g"), leaf("b")], [300, 300, 200]);
    const { rects, height } = layout(t, {}, root(1000), { g: { seen: 123 } }, fit({ a: 100, b: 100 }));
    expect(rects.g).toBeUndefined();
    expect(rects.b.y).toBe(108);
    expect(height).toBe(208);
  });

  it("a group is HEAD_H plus its kids; kid rects are relative to the body", () => {
    const kids = { grp: split("r", [leaf("k1"), leaf("k2")], [0.5, 0.5]) };
    const { rects, height } = layout(split("c", [leaf("grp")], [400]), kids, root(1008), {}, fit({ k1: 100, k2: 60 }));
    expect(rects.grp).toEqual({ x: 0, y: 0, w: 1008, h: 28 + 100, body: { w: 1008, h: 100 } });
    expect(rects.k1).toEqual({ x: 0, y: 0, w: 500, h: 100, body: { w: 500, h: 72 } });
    expect(rects.k2.x).toBe(508);
    expect(rects.k2.h).toBe(100); // was 60: the line height
    expect(height).toBe(128);
  });

  it("a minimized group does not lay its kids", () => {
    const kids = { grp: leaf("k1") };
    const { rects } = layout(leaf("grp"), kids, root(1000), { grp: { min: 1 } }, cfg);
    expect(rects.grp.h).toBe(cfg.HEAD_H);
    expect(rects.k1).toBeUndefined();
  });

  it("a user height (st.h) is the card's height, floored at the header plus 40; siblings on its line take the line height", () => {
    const row = split("r", [leaf("a"), leaf("b")], [0.5, 0.5]);
    const c = fit({ a: 100, b: 100 });
    const r = layout(row, {}, root(1000), { a: { h: 260 } }, c).rects;
    expect(r.a.h).toBe(260);
    expect(r.b.h).toBe(260);
    expect(layout(row, {}, root(1000), { a: { h: 10 } }, c).rects.a.h).toBe(100); // floored at HEAD_H+40 = 68, then the line height (was 68);
  });

  it("same input twice gives identical rects", () => {
    const kids = { g: split("c", [leaf("x"), leaf("y")], [0.5, 0.5]) };
    const t = split("c", [split("r", [leaf("a"), leaf("g")], [0.6, 0.4]), leaf("b")], [400, 200]);
    const st = { a: { min: 1 }, b: { h: 250 } };
    const r1 = layout(t, kids, root(1200), st, cfg);
    expect(layout(t, kids, root(1200), st, cfg)).toEqual(r1);
    expect(r1.rects.b.h).toBe(250);
  });

  it("no overlap, all inside the container, height is the bottom of the last card", () => {
    const kids = { g: split("r", [leaf("k1"), leaf("k2")], [0.5, 0.5]) };
    const t = split("c", [split("r", [leaf("a"), leaf("g")], [0.6, 0.4]), leaf("b")], [400, 200]);
    const cfg2 = { ...fit({ a: 90, k1: 70, k2: 50, b: 120 }), types: { ...cfg.types, leaf: { minW: 0 }, group: { minW: 0 } } };
    const { rects, height } = layout(t, kids, root(1000), {}, cfg2);
    const top = ["a", "g", "b"].map((id) => rects[id]);
    for (let i = 0; i < top.length; i++)
      for (let j = i + 1; j < top.length; j++) {
        const a = top[i], b = top[j];
        expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false);
      }
    for (const r of Object.values(rects)) expect(r.x + r.w).toBeLessThanOrEqual(1000);
    for (const id of ["k1", "k2"]) expect(rects[id].y + rects[id].h).toBeLessThanOrEqual(rects.g.body.h);
    expect(rects.b.y + rects.b.h).toBe(height);
    // the group is its header plus the taller kid, no empty band below it
    expect(rects.g.h).toBe(cfg.HEAD_H + 70);
    expect(rects.b.y).toBe(Math.max(rects.a.h, rects.g.h) + cfg.GAP);
  });

  it("row weights renormalize over the visible children; ghosts take no space", () => {
    const t = split("r", [leaf("a"), leaf("g"), leaf("b")], [0.3, 0.2, 0.7]);
    const { rects } = layout(t, {}, root(1008), { g: { seen: 123 } }, cfg);
    expect(rects.g).toBeUndefined();
    expect(rects.a.w).toBeCloseTo(0.3 * 1000);
    expect(rects.b.w).toBeCloseTo(0.7 * 1000);
    expect(rects.b.x - (rects.a.x + rects.a.w)).toBe(cfg.GAP);
  });

  it("a card's type drives minW and defaultH (fallback to the cfg defaults)", () => {
    const kids = { a: { type: "chart" }, b: { type: "metric" } };
    const row = split("r", [leaf("a"), leaf("b")], [0.5, 0.5]);
    const { rects } = layout(row, kids, root(400), {}, cfg);
    expect(rects.a.h).toBe(260);
    expect(rects.b.h).toBe(120);
    expect(rects.b.y).toBe(268);
    const wide = layout(row, kids, root(620), {}, cfg);
    expect(wide.rects.a.y).toBe(0);
    expect(wide.rects.b.y).toBe(0);
    expect(wide.rects.b.x).toBeGreaterThan(0);
    expect(layout(row, { a: { type: "unknown" }, b: { type: "unknown" } }, root(400), {}, cfg).rects.a.h).toBe(cfg.defaultH);
  });

  it("a line whose cards are all ghosts takes no space", () => {
    const t = split("c", [split("r", [leaf("g"), leaf("h")], [0.5, 0.5]), leaf("below")], [400, 200]);
    const { rects, height } = layout(t, {}, root(1000), { g: { seen: 1 }, h: { seen: 2 } }, fit({ below: 70 }));
    expect(rects.below.y).toBe(0);
    expect(height).toBe(70);
  });

  it("a bare root leaf gets its type's defaultH", () => {
    const { rects, height } = layout(leaf("a"), { a: { type: "metric" } }, root(1000), {}, cfg);
    expect(rects.a.h).toBe(120);
    expect(rects.a.body.h).toBe(120 - cfg.HEAD_H);
    expect(height).toBe(120);
    expect(layout(leaf("b"), {}, root(1000), {}, cfg).rects.b.h).toBe(cfg.defaultH);
  });

  it("extra content fields on kids cannot change the rects", () => {
    const tree = split("c", [split("r", [leaf("a"), leaf("g")], [0.6, 0.4]), leaf("b")], [400, 200]);
    const kids = { g: split("r", [leaf("k1"), leaf("k2")], [0.5, 0.5]) };
    const r1 = layout(tree, kids, root(1200), {}, cfg);
    const loaded = { ...kids, a: { type: "metric", value: 42, rows: [1, 2, 3] }, b: { type: "chart", series: [9] }, k1: { value: 7 } };
    expect(layout(tree, loaded, root(1200), {}, cfg).rects.g).toEqual(r1.rects.g);
    expect(layout(tree, kids, root(1200), {}, cfg)).toEqual(r1);
  });
});

describe("win layout: dock and line invariants", () => {
  const rectsHit = (a: any, b: any) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  it("a group's dock is a flow row after its last line: below every card, wrapping to more rows when chips do not fit", () => {
    const kids = { grp: split("r", [leaf("k1"), leaf("k2"), leaf("m1"), leaf("m2"), leaf("m3")], [1, 1, 1, 1, 1]) };
    const st = { m1: { seen: 1 }, m2: { seen: 1 }, m3: { seen: 1 } };
    const dock = { grp: ["m1", "m2", "m3"] };
    const c = { ...fit({ k1: 90, k2: 60 }), dock, chipW: { m1: 120, m2: 120, m3: 120 } };
    const wide = layout(leaf("grp"), kids, root(500), st, c).rects;
    const last = Math.max(wide.k1.y + wide.k1.h, wide.k2.y + wide.k2.h);
    expect(Math.min(wide.m1.y, wide.m2.y, wide.m3.y)).toBeGreaterThanOrEqual(last);
    expect(wide.m1.y).toBe(wide.m3.y); // 3 x 120 + gaps fit one row of 500
    expect(wide.grp.h).toBe(cfg.HEAD_H + last + cfg.GAP + 22); // the group ends at the dock: no empty space
    const narrow = layout(leaf("grp"), kids, root(300), st, c).rects;
    expect(narrow.m3.y).toBeGreaterThan(narrow.m1.y); // 300 px: two rows of chips
    expect(narrow.grp.h).toBe(cfg.HEAD_H + (narrow.m3.y + 22));
    const none = layout(leaf("grp"), kids, root(500), st, { ...fit({ k1: 90, k2: 60 }), dock: {} }).rects;
    expect(none.grp.h).toBe(cfg.HEAD_H + 90); // no chips: no dock area
  });

  it("no two cards intersect, at any width, with mixed heights, shares and a user height", () => {
    const t = split("c", [split("r", [leaf("a"), leaf("b"), leaf("c"), leaf("d")], [1, 1, 1, 1]), split("r", [leaf("e"), leaf("f")], [1, 1])], [1, 1]);
    const st = { b: { sp: 2 }, e: { h: 200 } };
    for (const w of [200, 360, 540, 900, 1100]) {
      const { rects, height } = layout(t, {}, root(w), st, fit({ a: 60, b: 150, c: 80, d: 90, e: 70, f: 110 }));
      const all = Object.values(rects) as any[];
      for (let i = 0; i < all.length; i++) {
        expect(all[i].x + all[i].w).toBeLessThanOrEqual(w + 0.001);
        expect(all[i].y + all[i].h).toBeLessThanOrEqual(height);
        for (let j = i + 1; j < all.length; j++) expect(rectsHit(all[i], all[j])).toBe(false);
      }
    }
  });
});

describe("win layout: width steps of the handle", () => {
  const span = api.winColSpan as (c: number, g: number, m: number, t: number) => number;
  it("snaps to whole column units of the container (N from the least tile width) and lays out at exactly k columns", () => {
    // 1008 wide, minW 220, gap 8: N = 4 columns of 246
    expect(span(1008, 8, 220, 100)).toBe(4); // 1 column = 1/4
    expect(span(1008, 8, 220, 500)).toBe(2); // 2 of 4
    expect(span(1008, 8, 220, 760)).toBeCloseTo(4 / 3); // 3 of 4
    expect(span(1008, 8, 220, 5000)).toBe(1); // whole row
    expect(span(300, 8, 220, 100)).toBeCloseTo(4 / 3); // was 1 (N columns): now the nearest 12-unit step holding minW, 9 units = 223
    // 12-unit grid: steps 3,4,6,8,9,12 units; the nearest step at least minW, both ways
    expect(span(1008, 8, 100, 300)).toBe(3); // 4 units (331) is nearer to 300 than 3 units (246)
    expect(span(1008, 8, 100, 240)).toBe(4); // 3 units
    expect(span(1008, 8, 100, 330)).toBe(3);
    expect(span(1008, 8, 100, 700)).toBeCloseTo(1.5); // 8 units = 2/3
    expect(span(1008, 8, 300, 200)).toBe(3); // 3 units (246) is under minW 300: 4 units (331)
    const row = split("r", [leaf("a"), leaf("b")], [1, 1]);
    const { rects } = layout(row, {}, root(1008), { a: { sp: span(1008, 8, 220, 760) }, b: { sp: 4 } }, fit({ a: 80, b: 80 }));
    expect(rects.a.w).toBeCloseTo(3 * 246 + 2 * 8); // three whole columns
    expect(rects.b.x).toBeCloseTo(rects.a.w + 8);
  });
});
