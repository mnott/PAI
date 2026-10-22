import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Invariant: cards in one container never intersect (1 px tolerance), at any width, with any width share.
const src = (f: string, name: string) => {
  const s = readFileSync(fileURLToPath(new URL(`./win/${f}.ts`, import.meta.url)), "utf8");
  const m = s.match(new RegExp(`export const ${name} = String\\.raw\`([\\s\\S]*?)\`;`));
  if (!m) throw new Error(`${name} not found`);
  return m[1];
};
const api = (new Function(
  `${src("tree", "WIN_TREE_JS")}\n${src("layout", "WIN_LAYOUT_JS")}\nreturn {leaf:leaf,split:split,layout:layout};`,
) as any)();
const { leaf, split, layout } = api;
const cfg = {
  HEAD_H: 28, GAP: 8, GUTTER: 8, minW: 220, defaultH: 300, narrowW: 480, fit: true, derive: true,
  types: { metric: { minW: 120, minH: 80, defaultH: 120 }, chart: { minW: 300, minH: 150, defaultH: 260 } },
};
const eq = (n: number) => Array.from({ length: n }, () => 1 / n);
const names = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${i}`);
const rowOf = (ids: string[]) => split("r", ids.map(leaf), eq(ids.length));
const rows = [names("a", 5), names("b", 5), names("c", 4)];
const kids = {
  g: split("c", rows.map(rowOf), [1 / 3, 1 / 3, 1 / 3]),
};
const leafTypes: any = {};
rows.flat().forEach((id) => (leafTypes[id] = "metric"));
const tree = split("c", [leaf("g")], [300]);
const tallTree = split("c", [leaf("g")], [1400]);

const hit = (a: any, b: any) =>
  a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1;

/** Pairwise intersections among the cards of one container (the leaves of one kid tree). */
export function overlaps(rects: any, ids: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const a = rects[ids[i]], b = rects[ids[j]];
      if (a && b && hit(a, b)) out.push(`${ids[i]}x${ids[j]}`);
    }
  return out;
}

describe("win layout: cards never overlap", () => {
  for (const w of [360, 540, 800, 1100, 1500])
    for (const sp of [0, 2, 3, 4])
      for (const min of [false, true]) {
        it(`w=${w} share=${sp} minimized=${min}`, () => {
          const st: any = {};
          if (sp) st.a0 = { sp };
          if (min) st.a1 = { min: 1 };
          const { rects } = layout(tree, kids, { w }, st, { ...cfg, leafTypes });
          expect(overlaps(rects, rows.flat())).toEqual([]);
          for (const id of rows.flat()) if (!(st[id] && st[id].min)) expect(rects[id].w).toBeGreaterThanOrEqual(120);
        });
      }
});

describe("win layout: every visible card holds its least width (fuzz)", () => {
  it("random shares, widths and title widths", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const bad: string[] = [];
    for (let n = 0; n < 600; n++) {
      const w = 340 + Math.floor(rnd() * 1200);
      const st: any = {}, titleW: any = {};
      for (const id of rows.flat()) {
        if (rnd() < 0.25) st[id] = { sp: [1, 2, 3, 4][Math.floor(rnd() * 4)] };
        if (rnd() < 0.5) titleW[id] = 100 + Math.floor(rnd() * 120);
      }
      const kd = { g: split("c", rows.map((r) => { const z = r.map(() => 0.2 + rnd()); const t = z.reduce((a, b) => a + b, 0); return split("r", r.map(leaf), z.map((v) => v / t)); }), [1 / 3, 1 / 3, 1 / 3]) };
      const { rects } = layout(tree, kd, { w }, st, { ...cfg, leafTypes, titleW });
      const ov = overlaps(rects, rows.flat());
      if (ov.length) bad.push(`w=${w} overlap ${ov[0]} ${JSON.stringify(st)}`);
      for (const id of rows.flat()) {
        const m = titleW[id] && titleW[id] > 120 ? Math.min(titleW[id], Math.round(120 * 1.6)) : 120;
        if (rects[id].w < m - 1) bad.push(`w=${w} ${id} ${Math.round(rects[id].w)}<${m} ${JSON.stringify(st)}`);
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });
});

describe("win layout: lines and dock", () => {
  const dockIds = ["a3", "c3"];
  for (const w of [360, 540, 800, 1100, 1500])
    for (const sp of [0, 3, 2]) {
      it(`w=${w} share=${sp}: cards on a line are equally tall; the dock sits below the last line`, () => {
        const st: any = { a3: { min: 1 }, c3: { min: 1 } };
        if (sp) st.a0 = { sp };
        const dock = { g: dockIds };
        const chipW: any = { a3: 120, c3: 120 };
        const { rects } = layout(w % 2 ? tree : tallTree, kids, { w }, st, { ...cfg, leafTypes, dock, chipW });
        const cards = rows.flat().filter((id) => !dockIds.includes(id));
        const lines: { [y: number]: number[] } = {};
        for (const id of cards) (lines[Math.round(rects[id].y)] ||= []).push(rects[id].h);
        for (const hs of Object.values(lines)) expect(Math.max(...hs) - Math.min(...hs)).toBeLessThanOrEqual(8);
        const bottom = Math.max(...cards.map((id) => rects[id].y + rects[id].h));
        for (const id of dockIds) expect(rects[id].y).toBeGreaterThanOrEqual(bottom - 1);
        expect(overlaps(rects, rows.flat())).toEqual([]);
      });
    }
});
