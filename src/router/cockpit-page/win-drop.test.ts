import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Same extraction trick as win-tree.test.ts: the string is the whole contract here.
const src = readFileSync(fileURLToPath(new URL("./win/drop.ts", import.meta.url)), "utf8");
const m = src.match(/export const WIN_DROP_JS = String\.raw`([\s\S]*?)`;/);
if (!m) throw new Error("WIN_DROP_JS not found in win/drop.ts");
const read = (f: string, name: string) => {
  const mm = readFileSync(fileURLToPath(new URL(`./win/${f}.ts`, import.meta.url)), "utf8").match(new RegExp(`export const ${name} = String\\.raw\`([\\s\\S]*?)\`;`));
  if (!mm) throw new Error(`${name} not found`);
  return mm[1];
};
// drop.ts owns only the drop ops; the tree and layout helpers come from their own modules
const api = (new Function(
  `${read("tree", "WIN_TREE_JS")}\n${read("layout", "WIN_LAYOUT_JS")}\n${m[1]}\nreturn {leaf:leaf,split:split,ids:ids,zoneAt:zoneAt,moveCard:moveCard,dropTry:dropTry,neighbor:neighbor,canDrop:canDrop,layout:layout};`,
) as any)();
const leaf = (id: string) => api.leaf(id);
const split = (d: string, ch: any[], sz: number[]) => api.split(d, ch, sz);
const zoneAt = api.zoneAt as (R: any, p: any) => string;
const moveCard = api.moveCard as (t: any, d: string, tg: string, z: string, o: any) => any;

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
// leaf/group fall back to cfg minW 220; boxes are wide enough that only real refusals refuse
const wide = { w: 1000, h: 1000 };
const opts = (kids: any, st: any, box: any) => ({ kids: kids || {}, state: st || {}, cfg, box: box || wide });

describe("win drop (spec 3.3)", () => {
  it("zoneAt: four edge bands, corners to the nearer edge, middle none", () => {
    const R = { x: 0, y: 0, w: 400, h: 200 }; // bands: 100 wide, 50 tall
    expect(zoneAt(R, { x: 10, y: 100 })).toBe("left");
    expect(zoneAt(R, { x: 390, y: 100 })).toBe("right");
    expect(zoneAt(R, { x: 200, y: 10 })).toBe("top");
    expect(zoneAt(R, { x: 200, y: 190 })).toBe("bottom");
    expect(zoneAt(R, { x: 200, y: 100 })).toBe("none"); // middle
    expect(zoneAt(R, { x: 50, y: 10 })).toBe("top"); // corner: dy 10 < dx 50
    expect(zoneAt(R, { x: 10, y: 50 })).toBe("left"); // corner: dx 10 < dy 50
    expect(zoneAt(R, { x: 390, y: 190 })).toBe("right"); // corner: dx 10 = dy 10 tie -> horizontal
    expect(zoneAt(R, { x: 390, y: 10 })).toBe("right"); // corner: dx 10 = dy 10 tie -> horizontal
    expect(zoneAt(R, { x: 10, y: 190 })).toBe("left");
    expect(zoneAt(R, { x: -5, y: 100 })).toBe("none"); // outside the rect
    expect(zoneAt(R, { x: 200, y: 250 })).toBe("none");
  });

  it("drop right of a root-band card makes a row 0.5/0.5; the band keeps its px", () => {
    const t = split("c", [leaf("a"), leaf("b")], [400, 200]);
    const nt = moveCard(t, "b", "a", "right", opts({}, {}, { w: 1000 }));
    expect(nt.k).toBe("s");
    expect(nt.d).toBe("c");
    expect(nt.ch[0].k).toBe("s");
    expect(nt.ch[0].d).toBe("r");
    expect(api.ids(nt.ch[0])).toEqual(["a", "b"]);
    expect(nt.ch[0].sz).toEqual([0.5, 0.5]);
    expect(nt.sz[0]).toBe(400); // the band keeps T's px
    expect(nt.sz.length).toBe(1); // b's old band is gone (its leaf was removed)
    // the input tree is untouched
    expect(api.ids(t)).toEqual(["a", "b"]);
    expect(t.ch[0].k).toBe("c");
  });

  it("drop top of a card inside a row makes a column in the row cell", () => {
    // D comes from the same row, so its removal leaves [a,b] with b's weight renormalized
    const row = split("r", [leaf("a"), leaf("b"), leaf("c")], [0.25, 0.5, 0.25]);
    const t = split("c", [row], [400]);
    const nt = moveCard(t, "c", "b", "top", opts({}, {}, wide));
    expect(nt.d).toBe("c");
    const r = nt.ch[0];
    expect(r.d).toBe("r");
    expect(r.ch[0].k).toBe("c");
    expect(r.ch[0].id).toBe("a");
    const col = r.ch[1];
    expect(col.k).toBe("s");
    expect(col.d).toBe("c");
    expect(api.ids(col)).toEqual(["c", "b"]);
    expect(col.sz).toEqual([0.5, 0.5]);
  });

  it("drop bottom of a root card makes a new band (heights are content-driven: the weight is unused)", () => {
    const t = split("c", [leaf("a"), leaf("b")], [400, 200]);
    const nt = moveCard(t, "b", "a", "bottom", opts({}, {}, { w: 1000 }));
    expect(nt.d).toBe("c");
    expect(api.ids(nt)).toEqual(["a", "b"]);
  });

  it("removal collapses the old split", () => {
    const row = split("r", [leaf("a"), leaf("b")], [0.5, 0.5]);
    const t = split("c", [row, leaf("z")], [400, 200]);
    const nt = moveCard(t, "a", "z", "bottom", opts({}, {}, wide));
    // a's row had one child left -> collapsed to the bare leaf b
    expect(nt.d).toBe("c");
    expect(nt.ch[0].k).toBe("c");
    expect(nt.ch[0].id).toBe("b");
    expect(api.ids(nt)).toEqual(["b", "z", "a"]);
  });

  it("a drop is never refused for room; only impossible drops return null; canDrop agrees", () => {
    const row = split("r", [leaf("a"), leaf("b")], [0.5, 0.5]);
    const t = split("c", [row], [600]);
    const kids = { a: { type: "chart" }, b: { type: "chart" } };
    // bounded column 300 tall, drop top of b: each would be 146 < chart minH 150, still applied
    const col = split("c", [leaf("a"), leaf("b")], [0.5, 0.5]);
    const t2 = split("c", [col], [600]);
    const short = { w: 1000, h: 300 };
    expect(moveCard(t2, "a", "b", "top", opts(kids, {}, short))).not.toBe(null);
    expect(api.canDrop(t2, kids, {}, cfg, "a", "b", "top", short)).toBe(true);
    // a 196 px cell for a chart (minW 300), still applied
    expect(moveCard(t, "a", "b", "right", opts(kids, {}, { w: 400, h: 1000 }))).not.toBe(null);
    // impossible drops
    expect(moveCard(t, "a", "a", "right", opts(kids, {}, wide))).toBe(null);
    expect(moveCard(t, "a", "b", "none", opts(kids, {}, wide))).toBe(null);
    expect(api.canDrop(t, kids, {}, cfg, "a", "a", "right", wide)).toBe(false);
  });


  it("no-op returns the same tree object", () => {
    const row = split("r", [leaf("a"), leaf("b")], [0.5, 0.5]);
    const t = split("c", [row], [400]);
    const nt = moveCard(t, "a", "b", "left", opts({}, {}, wide));
    expect(nt).toBe(t);
    // a drop that changes weights is not a no-op
    const nt2 = moveCard(t, "b", "a", "left", opts({}, {}, wide));
    expect(nt2).not.toBe(t);
    expect(api.ids(nt2)).toEqual(["b", "a"]);
  });

  it("a stacking drop (top/bottom of a card in a row) works — the old code could not stack", () => {
    const row = split("r", [leaf("a"), leaf("b"), leaf("c")], [0.25, 0.5, 0.25]);
    const t = split("c", [row], [400]);
    const nt = moveCard(t, "a", "b", "bottom", opts({}, {}, wide));
    expect(nt).not.toBe(null);
    const col = nt.ch[0].ch[0];
    expect(col.d).toBe("c");
    expect(api.ids(col)).toEqual(["b", "a"]);
    // layout: a sits above b inside the row cell
    const { rects } = api.layout(nt, {}, wide, {}, cfg);
    expect(rects.b.y + rects.b.h).toBeLessThan(rects.a.y);
    expect(rects.a.x).toBeCloseTo(rects.b.x);
  });

  it("neighbor finds the nearest visible card per direction", () => {
    const rects = {
      a: { x: 0, y: 0, w: 100, h: 100 },
      b: { x: 120, y: 0, w: 100, h: 100 }, // right of a, gap 20
      c: { x: 300, y: 0, w: 100, h: 100 }, // right of a, gap 200
      d: { x: 0, y: 120, w: 100, h: 100 }, // below a
      e: { x: 50, y: 400, w: 100, h: 100 }, // below a, no horizontal overlap with a? overlaps x 50..150 vs 0..100 -> yes
      f: { x: 200, y: 50, w: 50, h: 50 }, // right, no vertical overlap with a
    };
    expect(api.neighbor(rects, "a", "right")).toBe("b");
    expect(api.neighbor(rects, "a", "down")).toBe("d");
    expect(api.neighbor(rects, "b", "left")).toBe("a");
    expect(api.neighbor(rects, "a", "up")).toBe(null);
    expect(api.neighbor(rects, "f", "left")).toBe("a"); // a overlaps f vertically (y 50..100), nearest left
    expect(api.neighbor(rects, "e", "up")).toBe("d"); // same column band (x overlap), nearest above
  });

  it("property: random trees and random drops keep the id set, no duplicates", () => {
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    let nextId = 0; // every card id is unique within a tree
    const makeTree = (depth: number): any => {
      if (depth <= 0 || rnd() < 0.4) return leaf("n" + nextId++);
      const d = rnd() < 0.5 ? "r" : "c";
      const n = 2 + Math.floor(rnd() * 3);
      const ch = [];
      const sz = [];
      for (let i = 0; i < n; i++) {
        ch.push(makeTree(depth - 1));
        sz.push(0.2 + rnd());
      }
      return split(d, ch, sz);
    };
    const zones = ["left", "right", "top", "bottom"];
    let runs = 0, accepted = 0;
    for (let trial = 0; trial < 300; trial++) {
      nextId = 0;
      const t = makeTree(3);
      const before = api.ids(t);
      const drag = before[Math.floor(rnd() * before.length)];
      const target = before[Math.floor(rnd() * before.length)];
      const zone = zones[Math.floor(rnd() * zones.length)];
      const nt = moveCard(t, drag, target, zone, opts({}, {}, wide));
      runs++;
      if (nt === null) continue; // refused
      accepted++;
      const after = api.ids(nt);
      expect(new Set(after).size).toBe(after.length); // no duplicates
      expect(after.sort()).toEqual(before.slice().sort()); // same set
      // invariants: no one-child split, no same-direction nesting, sz matches ch
      const check = (n: any) => {
        if (!n || n.k === "c") return;
        expect(n.ch.length).toBeGreaterThanOrEqual(n === nt && n.d === "c" ? 1 : 2); // a root column may hold one band
        expect(n.sz.length).toBe(n.ch.length);
        for (const c of n.ch) {
          expect(c.k === "s" ? c.d !== n.d : true).toBe(true);
          check(c);
        }
      };
      check(nt);
    }
    expect(runs).toBe(300);
    expect(accepted).toBeGreaterThan(50); // most random drops are accepted
  });
});

describe("win drop: a drop that leaves a card narrow is applied, then the layout wraps it", () => {
  it("a third chart in a 700 px row is applied; afterwards no visible card is below its minW", () => {
    const t = split("c", [split("r", [leaf("a"), leaf("b")], [0.5, 0.5]), leaf("c")], [300, 200]);
    const kids = { a: { type: "chart" }, b: { type: "chart" }, c: { type: "chart" } };
    const box = { w: 700, h: 1000 };
    const r = api.dropTry(t, "c", "b", "right", opts(kids, {}, box));
    expect(r.tree).not.toBe(null);
    expect(r.why).toBe("");
    expect(api.canDrop(t, kids, {}, cfg, "c", "b", "right", box)).toBe(true);
    expect(api.ids(r.tree).sort()).toEqual(["a", "b", "c"]);
    const lay = api.layout(r.tree, kids, box, {}, cfg);
    for (const id of ["a", "b", "c"]) expect(lay.rects[id].w, id).toBeGreaterThanOrEqual(300);
  });
});
