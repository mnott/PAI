import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// win-drop.test.ts was rewritten for the CSS grid: positions are CSS grid now, a drop only changes the order and the parent.
// Same extraction trick as win-tree.test.ts: the string is the whole contract here.
const read = (f: string, name: string) => {
  const mm = readFileSync(fileURLToPath(new URL(`./win/${f}.ts`, import.meta.url)), "utf8").match(new RegExp(`export const ${name} = String\\.raw\`([\\s\\S]*?)\`;`));
  if (!mm) throw new Error(`${name} not found`);
  return mm[1];
};
const api = (new Function(
  `${read("tree", "WIN_TREE_JS")}\n${read("drop", "WIN_DROP_JS")}\nreturn {leaf:leaf,split:split,ids:ids,zoneAt:zoneAt,moveCard:moveCard,neighbor:neighbor};`,
) as any)();
const leaf = (id: string) => api.leaf(id);
const col = (...ids: string[]) => api.split("c", ids.map(leaf), ids.map(() => 1 / ids.length));
const zoneAt = api.zoneAt as (R: any, p: any) => string;
const move = api.moveCard as (root: any, kids: any, d: string, t: string, z: string) => { tree: any; kids: any } | null;
const order = (t: any) => (t ? api.ids(t) : []);

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
    expect(zoneAt(R, { x: 390, y: 190 })).toBe("right"); // corner tie -> horizontal
    expect(zoneAt(R, { x: -5, y: 100 })).toBe("none"); // outside the rect
  });

  it("left/top puts the card before the target, right/bottom after it", () => {
    const t = col("a", "b", "c");
    expect(order(move(t, {}, "c", "a", "left")!.tree)).toEqual(["c", "a", "b"]);
    expect(order(move(t, {}, "c", "b", "top")!.tree)).toEqual(["a", "c", "b"]);
    expect(order(move(t, {}, "a", "c", "right")!.tree)).toEqual(["b", "c", "a"]);
    expect(order(move(t, {}, "a", "b", "bottom")!.tree)).toEqual(["b", "a", "c"]);
  });

  it("a drop that changes nothing, onto itself, an unknown card or the middle returns null", () => {
    const t = col("a", "b", "c");
    expect(move(t, {}, "a", "b", "top")).toBe(null); // a is already right before b
    expect(move(t, {}, "a", "a", "left")).toBe(null);
    expect(move(t, {}, "a", "zz", "left")).toBe(null);
    expect(move(t, {}, "a", "b", "none")).toBe(null);
  });

  it("a card is reordered inside its own section only: a drop next to a card of another container is refused", () => {
    const root = col("g", "h");
    const kids = { g: col("a", "b"), h: col("c", "d") };
    expect(move(root, kids, "a", "d", "right")).toBe(null);
    expect(order(move(root, kids, "a", "b", "right")!.kids.g)).toEqual(["b", "a"]);
  });

  it("'into' is refused for a card of another container; a group header keeps its own cards", () => {
    const root = col("a", "g");
    const kids = { g: col("b", "c") };
    expect(move(root, kids, "a", "g", "into")).toBe(null);
    expect(move(root, kids, "b", "g", "into")).toBe(null); // already first: nothing changes
    expect(order(move(root, kids, "c", "g", "into")!.kids.g)).toEqual(["c", "b"]);
    expect(move(root, kids, "a", "b", "into")).toBe(null); // b is not a group
  });

  it("a card can not leave its group: dropping it on the root is refused", () => {
    const root = col("a", "g");
    expect(move(root, { g: col("b") }, "b", "a", "left")).toBe(null);
  });

  it("a group can not be dropped into itself or a group inside it", () => {
    const root = col("g", "x");
    const kids = { g: col("h", "a"), h: col("b", "c") };
    expect(move(root, kids, "g", "b", "right")).toBe(null);
    expect(move(root, kids, "g", "h", "into")).toBe(null);
    expect(move(root, kids, "g", "x", "right")).not.toBe(null);
  });

  it("property: random drops keep the id set with no duplicates", () => {
    let seed = 7;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const zones = ["left", "right", "top", "bottom"];
    let root: any = col("g1", "g2", "z");
    let kids: any = { g1: col("a", "b", "c"), g2: col("d", "e") };
    const all = ["g1", "g2", "z", "a", "b", "c", "d", "e"];
    for (let i = 0; i < 300; i++) {
      const d = all[rnd(all.length)], t = all[rnd(all.length)];
      const r = move(root, kids, d, t, zones[rnd(4)]);
      if (!r) continue;
      root = r.tree; kids = r.kids;
      const got = [...order(root), ...Object.values(kids).flatMap((k) => order(k))].sort();
      expect(got).toEqual([...all].sort());
    }
  });

  it("neighbor finds the nearest visible card per direction", () => {
    const rects = {
      a: { x: 0, y: 0, w: 100, h: 100 },
      b: { x: 120, y: 0, w: 100, h: 100 }, // right of a, gap 20
      c: { x: 300, y: 0, w: 100, h: 100 }, // right of a, gap 200
      d: { x: 0, y: 120, w: 100, h: 100 }, // below a
      e: { x: 50, y: 400, w: 100, h: 100 },
      f: { x: 200, y: 50, w: 50, h: 50 },
    };
    expect(api.neighbor(rects, "a", "right")).toBe("b");
    expect(api.neighbor(rects, "a", "down")).toBe("d");
    expect(api.neighbor(rects, "b", "left")).toBe("a");
    expect(api.neighbor(rects, "a", "up")).toBe(null);
    expect(api.neighbor(rects, "f", "left")).toBe("a");
    expect(api.neighbor(rects, "e", "up")).toBe("d");
  });
});
