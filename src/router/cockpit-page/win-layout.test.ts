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
  `${tm[1]}\n${lm[1]}\nreturn {leaf:leaf,split:split,layout:layout};`,
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
const bounded = (w: number, h: number) => ({ w, h });

describe("win layout (spec 3.2)", () => {
  it("two-up row 50/50 with the gutter between", () => {
    const t = split("r", [leaf("a"), leaf("b")], [0.5, 0.5]);
    const { rects } = layout(t, {}, bounded(1008, 400), {}, cfg);
    expect(rects.a).toEqual({ x: 0, y: 0, w: 500, h: 400, body: { w: 500, h: 372 } });
    expect(rects.b.x).toBe(508);
    expect(rects.b.w).toBe(500);
    // the gutter is exactly GAP between the two boxes
    expect(rects.b.x - (rects.a.x + rects.a.w)).toBe(cfg.GAP);
  });

  it("root bands in px; height is the sum of bands plus gutters", () => {
    const t = split("c", [leaf("a"), leaf("b")], [300, 200]);
    const { rects, height } = layout(t, {}, root(1000), {}, cfg);
    expect(rects.a).toEqual({ x: 0, y: 0, w: 1000, h: 300, body: { w: 1000, h: 272 } });
    expect(rects.b.y).toBe(308);
    expect(rects.b.h).toBe(200);
    expect(height).toBe(300 + 8 + 200);
  });

  it("a minimized leaf in a bounded column gives its space to the siblings by weight", () => {
    const t = split("c", [leaf("a"), leaf("b"), leaf("c")], [0.2, 0.3, 0.5]);
    const { rects } = layout(t, {}, bounded(600, 500), { b: { min: 1 } }, cfg);
    expect(rects.b.h).toBe(cfg.HEAD_H);
    const avail = 500 - 2 * cfg.GAP - cfg.HEAD_H;
    expect(rects.a.h).toBeCloseTo((0.2 / 0.7) * avail);
    expect(rects.c.h).toBeCloseTo((0.5 / 0.7) * avail);
    expect(rects.c.y).toBeCloseTo(rects.a.h + cfg.GAP + cfg.HEAD_H + cfg.GAP);
  });

  it("a minimized leaf in a root band shrinks only itself; the band keeps its px", () => {
    const row = split("r", [leaf("a"), leaf("b")], [0.5, 0.5]);
    const t = split("c", [row, leaf("below")], [400, 200]);
    const { rects, height } = layout(t, {}, root(1000), { a: { min: 1 } }, cfg);
    expect(rects.a.h).toBe(cfg.HEAD_H);
    expect(rects.a.y).toBe(0); // aligned to the top
    expect(rects.b.h).toBe(400); // the band keeps its size
    expect(rects.below.y).toBe(408);
    expect(height).toBe(400 + 8 + 200);
  });

  it("an all-minimized root band shrinks to HEAD_H", () => {
    const row = split("r", [leaf("a"), leaf("b")], [0.5, 0.5]);
    const t = split("c", [row, leaf("below")], [400, 200]);
    const { rects, height } = layout(t, {}, root(1000), { a: { min: 1 }, b: { min: 1 } }, cfg);
    expect(rects.a.h).toBe(cfg.HEAD_H);
    expect(rects.b.h).toBe(cfg.HEAD_H);
    expect(rects.below.y).toBe(cfg.HEAD_H + cfg.GAP);
    expect(height).toBe(cfg.HEAD_H + cfg.GAP + 200);
  });

  it("only min===1 collapses a card; a truthy min of another type takes its full space", () => {
    const t = split("c", [leaf("a"), leaf("b")], [0.5, 0.5]);
    const strict = layout(t, {}, bounded(600, 500), { a: { min: 1 } }, cfg);
    expect(strict.rects.a.h).toBe(cfg.HEAD_H);
    // winMin is the strict test: min true / "1" / 2 are not minimized (the store normalises them on load)
    for (const bad of [true, "1", 2]) {
      const { rects } = layout(t, {}, bounded(600, 500), { a: { min: bad } }, cfg);
      expect(rects.a.h).toBeCloseTo((500 - cfg.GAP) / 2);
      expect(rects.b.h).toBeCloseTo((500 - cfg.GAP) / 2);
    }
  });

  it("narrow width stacks a row using defaultH (root) and an equal share (bounded)", () => {
    // bounded: each child would be 196 < chart minW 300 -> stacked, equal share of (500-8)/2
    const row = split("r", [leaf("a"), leaf("b")], [0.5, 0.5]);
    const { rects: r2 } = layout(row, {}, bounded(400, 500), {}, cfg);
    expect(r2.a.y).toBe(0);
    expect(r2.a.h).toBe((500 - 8) / 2);
    expect(r2.b.y).toBe((500 - 8) / 2 + 8);
    expect(r2.a.w).toBe(400);
    // root: a band row at width 200 stacks; each child gets its own defaultH (cfg 300)
    const { rects: r3 } = layout(split("c", [row], [600]), {}, root(200), {}, cfg);
    expect(r3.a.h).toBe(300);
    expect(r3.b.y).toBe(308);
    expect(r3.b.h).toBe(300);
    // the band shrinks to the stacked content, not its px size
    expect(r3.b.y + r3.b.h).toBe(608);
  });

  it("ghosts are skipped and take no space", () => {
    const t = split("c", [leaf("a"), leaf("g"), leaf("b")], [300, 300, 200]);
    const { rects, height } = layout(t, {}, root(1000), { g: { seen: 123 } }, cfg);
    expect(rects.g).toBeUndefined();
    expect(rects.b.y).toBe(308);
    expect(height).toBe(300 + 8 + 200);
  });

  it("a group lays its kids in its body box; kid rects are relative to the body", () => {
    const kids = { grp: split("r", [leaf("k1"), leaf("k2")], [0.5, 0.5]) };
    const t = split("c", [leaf("grp")], [400]);
    const { rects } = layout(t, kids, root(1008), {}, cfg);
    expect(rects.grp).toEqual({ x: 0, y: 0, w: 1008, h: 400, body: { w: 1008, h: 372 } });
    // body 1008 x 372; two children share 1008 - 8 = 1000
    expect(rects.k1).toEqual({ x: 0, y: 0, w: 500, h: 372, body: { w: 500, h: 344 } });
    expect(rects.k2.x).toBe(508);
  });

  it("a minimized group does not lay its kids", () => {
    const kids = { grp: leaf("k1") };
    const { rects } = layout(leaf("grp"), kids, root(1000), { grp: { min: 1 } }, cfg);
    expect(rects.grp.h).toBe(cfg.HEAD_H);
    expect(rects.k1).toBeUndefined();
  });

  it("same input twice gives identical rects", () => {
    const kids = { g: split("c", [leaf("x"), leaf("y")], [0.5, 0.5]) };
    const t = split("c", [split("r", [leaf("a"), leaf("g")], [0.6, 0.4]), leaf("b")], [400, 200]);
    const st = { a: { min: 1 }, b: { px: 250 } };
    const r1 = layout(t, kids, root(1200), st, cfg);
    const r2 = layout(t, kids, root(1200), st, cfg);
    expect(r2).toEqual(r1);
    // remembered px overrides the band size for a leaf
    expect(r1.rects.b.h).toBe(250);
  });

  it("no overlap, all inside the container, area accounted (round trip)", () => {
    const kids = { g: split("r", [leaf("k1"), leaf("k2")], [0.5, 0.5]) };
    // types with minW 0 so the 1000-wide row never falls into narrow mode
    const t = split("c", [split("r", [leaf("a"), leaf("g")], [0.6, 0.4]), leaf("b")], [400, 200]);
    const cfg2 = { ...cfg, types: { ...cfg.types, leaf: { minW: 0 }, group: { minW: 0 } } };
    const { rects, height } = layout(t, kids, root(1000), {}, cfg2);
    for (const r of Object.values(rects)) {
      expect(r.w).toBeGreaterThan(0);
      expect(r.h).toBeGreaterThanOrEqual(cfg.HEAD_H);
    }
    // group kids sit inside the group body (kid rects are body-relative)
    for (const id of ["k1", "k2"]) {
      expect(rects[id].x + rects[id].w).toBeLessThanOrEqual(rects.g.body.w);
      expect(rects[id].y + rects[id].h).toBeLessThanOrEqual(rects.g.body.h);
    }
    // no two rects of the same container overlap (kids are body-relative)
    const top = ["a", "g", "b"].map((id) => rects[id]);
    for (let i = 0; i < top.length; i++)
      for (let j = i + 1; j < top.length; j++) {
        const a = top[i], b = top[j];
        const over = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(over).toBe(false);
      }
    // every card inside the container width; height accounted
    for (const r of Object.values(rects)) expect(r.x + r.w).toBeLessThanOrEqual(1000);
    expect(rects.b.y + rects.b.h).toBe(height);
    // the band row fills the band px; the group body is the band minus HEAD_H
    expect(rects.a.h).toBe(400);
    expect(rects.g.h).toBe(400);
    expect(rects.g.body.h).toBe(400 - cfg.HEAD_H);
    // area accounted per container: band = width x band px minus its row gutter;
    // group body = body box minus its row gutter (kids fill the body)
    expect(rects.a.w + rects.g.w + cfg.GAP).toBe(1000);
    expect(rects.k1.h).toBe(rects.g.body.h);
    expect(rects.k1.w + rects.k2.w + cfg.GAP).toBe(rects.g.body.w);
    let area = 0;
    for (const r of Object.values(rects)) area += r.w * r.h;
    expect(area).toBeCloseTo(
      rects.a.w * 400 +
        rects.g.w * 400 + // band 1: cards fill the band px
        rects.k1.w * rects.k1.h + rects.k2.w * rects.k2.h + // group body: kids fill it
        rects.b.w * rects.b.h, // band 2
    );
  });

  it("D1: a narrow-stacked root band grows past its px and the next band starts below it", () => {
    // band row at width 200 stacks; each child gets defaultH 300 -> the band is 608, not 400
    const row = split("r", [leaf("a"), leaf("b")], [0.5, 0.5]);
    const t = split("c", [row, leaf("below")], [400, 200]);
    const { rects, height } = layout(t, {}, root(200), {}, cfg);
    expect(rects.a.h).toBe(300);
    expect(rects.b.y).toBe(308);
    expect(rects.b.y + rects.b.h).toBe(608);
    // the band must not clip to its px: below starts after the stacked content, no overlap
    expect(rects.below.y).toBe(616);
    expect(rects.below.h).toBe(200);
    expect(rects.below.y).toBeGreaterThanOrEqual(rects.b.y + rects.b.h + cfg.GAP);
    expect(height).toBe(616 + 200);
  });

  it("D2: a column nested under a row inside a root band lays its sz as weights, not px", () => {
    // root band (400 px) > row > column [a,b] weights 0.25/0.75 -> heights 98 / 294 of the
    // band's 400, not 0.25/0.75 px
    const col = split("c", [leaf("a"), leaf("b")], [0.25, 0.75]);
    const t = split("c", [split("r", [col, leaf("side")], [0.5, 0.5])], [400]);
    const { rects } = layout(t, {}, root(1000), {}, cfg);
    const avail = 400 - cfg.GAP;
    expect(rects.a.h).toBeCloseTo(0.25 * avail);
    expect(rects.b.h).toBeCloseTo(0.75 * avail);
    expect(rects.b.y).toBeCloseTo(rects.a.h + cfg.GAP);
    expect(rects.a.h).toBeGreaterThan(cfg.HEAD_H);
  });

  it("D3: a bare root row gives its children defaultH, not the empty box height", () => {
    const { rects } = layout(split("r", [leaf("a"), leaf("b")], [0.5, 0.5]), {}, root(1000), {}, cfg);
    expect(rects.a.h).toBe(cfg.defaultH);
    expect(rects.b.h).toBe(cfg.defaultH);
    expect(rects.a.h).toBeGreaterThan(0);
  });

  it("D4: row weights renormalize over the visible children; ghosts take no space", () => {
    // a and b visible (0.3 + 0.7 = 1), g a ghost: the two share the whole width, not 30/70%
    const t = split("r", [leaf("a"), leaf("g"), leaf("b")], [0.3, 0.2, 0.7]);
    const { rects } = layout(t, {}, bounded(1008, 400), { g: { seen: 123 } }, cfg);
    expect(rects.g).toBeUndefined();
    expect(rects.a.w).toBeCloseTo(0.3 * 1000);
    expect(rects.b.w).toBeCloseTo(0.7 * 1000);
    expect(rects.b.x - (rects.a.x + rects.a.w)).toBe(cfg.GAP);
  });

  it("D5: a card's type drives minW and defaultH (fallback to the cfg defaults)", () => {
    const kids = { a: { type: "chart" }, b: { type: "metric" } };
    // row at width 400: chart minW 300 -> narrow mode; metric defaultH 120, chart 260
    const row = split("r", [leaf("a"), leaf("b")], [0.5, 0.5]);
    const { rects } = layout(row, kids, root(400), {}, cfg);
    expect(rects.a.h).toBe(260); // chart defaultH, not cfg.defaultH 300
    expect(rects.b.h).toBe(120); // metric defaultH
    expect(rects.b.y).toBe(268);
    // minW from the type: width 250 < chart minW 300 stacks; width 620 >= 300 stays a row
    const wide = layout(row, kids, root(620), {}, cfg);
    expect(wide.rects.a.y).toBe(0);
    expect(wide.rects.b.y).toBe(0);
    expect(wide.rects.b.x).toBeGreaterThan(0);
    // a type with no entries falls back to cfg minW/defaultH
    const plain = layout(row, { a: { type: "unknown" }, b: { type: "unknown" } }, root(400), {}, cfg);
    expect(plain.rects.a.h).toBe(cfg.defaultH);
  });

  it("E1: a root band whose cards are all ghosts takes no space", () => {
    // the band's only child is a ghost -> no visible card -> no HEAD_H+GAP for the band
    const t = split("c", [split("r", [leaf("g"), leaf("h")], [0.5, 0.5]), leaf("below")], [400, 200]);
    const { rects, height } = layout(t, {}, root(1000), { g: { seen: 1 }, h: { seen: 2 } }, cfg);
    expect(rects.g).toBeUndefined();
    expect(rects.h).toBeUndefined();
    expect(rects.below.y).toBe(0);
    expect(height).toBe(200);
  });

  it("E2: a bare root leaf as the whole tree gets its type's defaultH, not 0", () => {
    const { rects, height } = layout(leaf("a"), { a: { type: "metric" } }, root(1000), {}, cfg);
    expect(rects.a.h).toBe(120); // metric defaultH
    expect(rects.a.body.h).toBe(120 - cfg.HEAD_H);
    expect(height).toBe(120);
    // no type entry -> cfg defaultH
    const r2 = layout(leaf("b"), {}, root(1000), {}, cfg);
    expect(r2.rects.b.h).toBe(cfg.defaultH);
  });

  it("D6: extra content fields on kids cannot change the rects", () => {
    const tree = split("c", [split("r", [leaf("a"), leaf("g")], [0.6, 0.4]), leaf("b")], [400, 200]);
    const kids = { g: split("r", [leaf("k1"), leaf("k2")], [0.5, 0.5]) };
    const box = root(1200);
    const st = {};
    const r1 = layout(tree, kids, box, st, cfg);
    const r2 = layout(tree, kids, box, st, cfg);
    expect(r2).toEqual(r1);
    // the same tree and kids, but the kid entries carry content fields
    const loaded = {
      g: split("r", [leaf("k1"), leaf("k2")], [0.5, 0.5]),
      a: { type: "metric", value: 42, rows: [1, 2, 3], title: "cpu load" },
      b: { type: "chart", series: [9, 9], html: "<div>long content</div>" },
      k1: { value: 7 },
      k2: { value: 8 },
    };
    const r3 = layout(tree, loaded, box, st, cfg);
    expect(r3).toEqual(r1);
  });
});
