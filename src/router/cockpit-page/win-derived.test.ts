import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = (f: string, name: string) => {
  const m = readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8").match(
    new RegExp(`export const ${name} = String\\.raw\`([\\s\\S]*?)\`;`),
  );
  if (!m) throw new Error(`${name} not found in ${f}`);
  return m[1];
};
const api = (new Function(
  `${src("./win/tree.ts", "WIN_TREE_JS")}\n${src("./win/layout.ts", "WIN_LAYOUT_JS")}\nreturn {leaf:leaf,split:split,layout:layout};`,
) as any)();
const { leaf, split, layout } = api;

const cfg = (extra: object = {}) => ({
  HEAD_H: 28,
  CHIP_H: 22,
  GAP: 8,
  GUTTER: 8,
  minW: 100,
  defaultH: 100,
  types: { metric: { minW: 100, minH: 60, defaultH: 60 } },
  ...extra,
});
const row = (p: string) => split("r", [leaf(`${p}1`), leaf(`${p}2`), leaf(`${p}3`)], [1, 1, 1]);
const kids = { sys: leaf("inner"), inner: split("c", [row("a"), row("b"), row("c")], [1, 1, 1]) };
const types = () => {
  const lt: Record<string, string> = {};
  for (const p of ["a", "b", "c"]) for (const i of [1, 2, 3]) lt[`${p}${i}`] = "metric";
  return lt;
};
const bands = (px: number) => split("c", [leaf("sys"), leaf("tail")], [px, 100]);
// 3 tile rows of 60 + 2 gaps; the solo group draws no inner header: head + body
const NEED = 28 + 3 * 60 + 2 * 8;

describe("derived band heights follow the content", () => {
  it("a stored derived height far above need loads as need (derive on)", () => {
    const r = layout(bands(1200), kids, { w: 900 }, {}, cfg({ derive: true, leafTypes: types() }));
    expect(r.rects.sys.h).toBe(NEED);
    expect(r.rects.tail.y).toBe(NEED + 8);
  });
  it("a shrink under 8 px of slack is held (no jitter)", () => {
    const r = layout(bands(NEED + 6), kids, { w: 900 }, {}, cfg({ derive: true, leafTypes: types() }));
    expect(r.rects.sys.h).toBe(NEED + 6);
  });
  it("a user band height stays", () => {
    const r = layout(bands(900), kids, { w: 900 }, { sys: { ub: 1 } }, cfg({ derive: true, leafTypes: types() }));
    expect(r.rects.sys.h).toBe(900);
  });
  it("without derive (tests of px bands) the px stays", () => {
    const r = layout(bands(900), kids, { w: 900 }, {}, cfg({ leafTypes: types() }));
    expect(r.rects.sys.h).toBe(900);
  });
  it("a refit after the content shrinks shrinks the box", () => {
    const c = cfg({ derive: true, leafTypes: types() });
    const big = layout(bands(NEED + 200), kids, { w: 900 }, {}, c).rects.sys.h;
    const k2 = { sys: leaf("inner"), inner: split("c", [row("a"), row("b")], [1, 1]) };
    const small = layout(bands(NEED + 200), k2, { w: 900 }, {}, c).rects.sys.h;
    expect(big).toBe(NEED);
    expect(small).toBe(28 + 2 * 60 + 8);
  });
  it("the lone child group draws without its header", () => {
    const r = layout(bands(NEED), kids, { w: 900 }, {}, cfg({ leafTypes: types() }));
    expect(r.rects.inner.nohd).toBe(1);
    expect(r.rects.inner.y).toBe(0);
    expect(r.rects.sys.nohd).toBeUndefined();
  });
  it("3 tile rows + 4 docked chips: height = rows + dock, chips below the last row", () => {
    const dock = { sys: ["d1", "d2", "d3", "d4"] };
    const st: any = {};
    for (const d of dock.sys) st[d] = { seen: 1 };
    const c = cfg({ derive: true, leafTypes: types(), dock, chipW: { d1: 100, d2: 100, d3: 100, d4: 100 } });
    const r = layout(bands(1200), kids, { w: 900 }, st, c);
    const dockH = 22; // 4 chips of 100 fit one line at 900
    expect(r.rects.sys.h).toBe(NEED + 8 + dockH);
    const lastRow = r.rects.c1;
    expect(r.rects.d1.y).toBeGreaterThanOrEqual(lastRow.y + lastRow.h);
  });
});

describe("groups hold no empty space", () => {
  const tiles = split("c", [split("r", [leaf("t1"), leaf("t2")], [1, 1]), split("r", [leaf("t3"), leaf("t4")], [1, 1])], [1, 1]);
  const k2 = { g: leaf("gi"), gi: tiles };
  const lt = { t1: "metric", t2: "metric", t3: "metric", t4: "metric", big: "chart" };
  const tree = split("c", [split("r", [leaf("g"), leaf("big")], [1, 1])], [600]);
  const need = 28 + 2 * 60 + 8; // group head + 2 tile rows + gap
  it("a 2x2 tile group beside a taller sibling keeps its own height", () => {
    const c = cfg({ derive: true, leafTypes: lt, types: { metric: { minW: 100, minH: 60 }, chart: { minW: 100, minH: 150 } } });
    const r = layout(tree, k2, { w: 900 }, { g: { ub: 1 } }, c);
    expect(r.rects.g.h).toBe(need);
    expect(r.rects.big.h).toBeGreaterThan(need);
    expect(r.rects.g.y).toBe(0);
  });
  it("without derive the row still fills", () => {
    const r = layout(tree, k2, { w: 900 }, {}, cfg({ leafTypes: lt }));
    expect(r.rects.g.h).toBe(r.rects.big.h);
  });
});

describe("a nested chart can be made shorter by its user height", () => {
  const kc = { sys: leaf("pw"), pw: leaf("ch") };
  const tree = split("c", [leaf("sys"), leaf("tail")], [900, 100]);
  const c = () => cfg({ derive: true, leafTypes: { ch: "chart" }, types: { chart: { minW: 100, minH: 150, defaultH: 220 } } });
  it("the band follows a user height 300 and clamps at the chart minimum", () => {
    expect(layout(tree, kc, { w: 900 }, { ch: { h: 300 } }, c()).rects.sys.h).toBeLessThan(400);
    const lo = layout(tree, kc, { w: 900 }, { ch: { h: 40 } }, c()).rects;
    expect(lo.ch.h).toBeGreaterThanOrEqual(150);
    expect(lo.sys.h).toBeLessThan(250);
  });
});
