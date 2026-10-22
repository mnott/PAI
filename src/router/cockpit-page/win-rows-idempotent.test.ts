import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Frozen layout: a band's heights come from needs only, so a fit that reads the rendered boxes back never ratchets them up.
const treeSrc = readFileSync(fileURLToPath(new URL("./win/tree.ts", import.meta.url)), "utf8");
const laySrc = readFileSync(fileURLToPath(new URL("./win/layout.ts", import.meta.url)), "utf8");
const tm = treeSrc.match(/export const WIN_TREE_JS = String\.raw`([\s\S]*?)`;/)!;
const lm = laySrc.match(/export const WIN_LAYOUT_JS = String\.raw`([\s\S]*?)`;/)!;
const api = (new Function(`${tm[1]}\n${lm[1]}\nreturn {leaf:leaf,split:split,layout:layout};`) as any)();
const { leaf, split, layout } = api;

const cfg: any = {
  HEAD_H: 28, GAP: 8, GUTTER: 8, minW: 220, defaultH: 300,
  types: {
    metric: { minW: 120, minH: 76, defaultH: 96 },
    chart: { minW: 300, minH: 150, defaultH: 220 },
    table: { minW: 220, minH: 80, defaultH: 220 },
  },
};
const TYPE: Record<string, string> = { t1: "metric", t2: "metric", t3: "metric", t4: "metric", ch: "chart", tb: "table" };
/** What the runtime reads: a tile and a table report their content, a chart (draws at the body size) reports the box it has. */
const reading = (rects: any, id: string) => (TYPE[id] === "chart" ? rects[id].h : TYPE[id] === "table" ? 130 : 60);
const run = (tree: any, kids: any, content: Record<string, number> | undefined) => {
  const c = { ...cfg, leafTypes: TYPE, content };
  return layout(tree, kids, { w: 1100 }, {}, c);
};
const heights = (r: any, ids: string[]) => Object.fromEntries(ids.map((i) => [i, r.rects[i].h]));
const fit = (tree: any, kids: any, ids: string[], rounds: number) => {
  let content: Record<string, number> | undefined;
  const out: any[] = [];
  for (let i = 0; i < rounds; i++) {
    const r = run(tree, kids, content);
    out.push({ h: heights(r, [...ids, "band"]), height: r.height });
    content = Object.fromEntries(ids.map((id) => [id, reading(r.rects, id)]));
  }
  return out;
};

describe("frozen band heights are idempotent under fit", () => {
  const row = () => split("r", [leaf("t1"), leaf("t2"), leaf("t3"), leaf("t4")], [0.25, 0.25, 0.25, 0.25]);
  const mixed = () => split("c", [leaf("band")], [520]);
  const mixedKids = () => ({ band: split("c", [row(), leaf("ch"), leaf("tb")], [0.3, 0.4, 0.3]) });

  it("a band with stat tiles, a chart and a table: five fits give identical heights", () => {
    const out = fit(mixed(), mixedKids(), ["t1", "t2", "t3", "t4", "ch", "tb"], 5);
    for (let i = 1; i < out.length; i++) expect(out[i]).toEqual(out[1]);
    expect(out[1].h.band).toBe(out[0].h.band);
  });

  it("a stat tile never takes the leftover; the chart does, the table keeps its content", () => {
    const out = fit(mixed(), mixedKids(), ["t1", "ch", "tb"], 3);
    expect(out[2].h.t1).toBeLessThanOrEqual(76 + 60);
    expect(out[2].h.tb).toBe(130);
    expect(out[2].h.ch).toBeGreaterThan(out[2].h.tb);
  });

  it("a band of only stat tiles is as tall as its content need, whatever its px", () => {
    const tiles = (px: number) => split("c", [leaf("band")], [px]);
    const kids = { band: split("c", [row(), split("r", [leaf("t1"), leaf("t2")], [0.5, 0.5])], [0.5, 0.5]) };
    const small = fit(tiles(10), kids, ["t1", "t2", "t3", "t4"], 4);
    const big = fit(tiles(900), kids, ["t1", "t2", "t3", "t4"], 4);
    for (let i = 1; i < small.length; i++) expect(small[i]).toEqual(small[1]);
    for (let i = 1; i < big.length; i++) expect(big[i]).toEqual(big[1]);
    // the need is the tiles' least heights (2 lines + header + gap), the saved px only raises it, a fit never does
    expect(small[1].h.band).toBe(28 + 2 * 76 + 8);
    expect(big[1].h.band).toBe(big[0].h.band);
  });
});
