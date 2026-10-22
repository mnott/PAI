import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// vitest does not rewrite ".js" to ".ts" for a source that is not yet built, so read the
// module's source and pull WIN_TREE_JS out of it; the string is the whole contract here.
const src = readFileSync(fileURLToPath(new URL("./win/tree.ts", import.meta.url)), "utf8");
const m = src.match(/export const WIN_TREE_JS = String\.raw`([\s\S]*?)`;/);
if (!m) throw new Error("WIN_TREE_JS not found in win/tree.ts");
// new Function returns a factory: call it to get the helpers. `leaf` is also a vitest
// assertion name, so the builders are wrapped under local names.
const api = (new Function(`${m[1]}\nreturn {leaf:leaf,split:split,normalize:normalize,renorm:renorm,findLeaf:findLeaf,parentOf:parentOf,ids:ids,removeLeaf:removeLeaf};`) as any)();
const leaf = (id: string) => api.leaf(id);
const split = (d: string, ch: any[], sz: number[]) => api.split(d, ch, sz);
const { normalize, findLeaf, parentOf, ids, removeLeaf } = api;

describe("win tree", () => {
  it("a one-child split collapses to the child", () => {
    const t = split("r", [split("r", [leaf("a")], [1])], [1]);
    const n = normalize(t);
    expect(n).toEqual(leaf("a"));
  });

  it("same-direction nesting merges with weights multiplied", () => {
    const inner = split("r", [leaf("b"), leaf("c")], [0.25, 0.75]);
    const t = split("r", [leaf("a"), inner], [0.5, 0.5]);
    const n = normalize(t);
    expect(n.k).toBe("s");
    expect(n.d).toBe("r");
    expect(ids(n)).toEqual(["a", "b", "c"]);
    expect(n.sz).toEqual([0.5, 0.125, 0.375]);
    expect(n.sz.reduce((a: number, b: number) => a + b, 0)).toBeCloseTo(1);
  });

  it("opposite-direction nesting is kept", () => {
    const inner = split("c", [leaf("b"), leaf("c")], [0.5, 0.5]);
    const t = split("r", [leaf("a"), inner], [0.5, 0.5]);
    const n = normalize(t);
    expect(n.ch[1].d).toBe("c");
    expect(ids(n)).toEqual(["a", "b", "c"]);
  });

  it("weights renormalize to sum 1", () => {
    const t = split("r", [leaf("a"), leaf("b")], [2, 2]);
    expect(normalize(t).sz).toEqual([0.5, 0.5]);
  });

  it("a zero-weight child is dropped and the rest renormalize", () => {
    const t = split("r", [leaf("a"), leaf("b"), leaf("c")], [0.5, 0, 0.5]);
    const n = normalize(t);
    expect(ids(n)).toEqual(["a", "c"]);
    expect(n.sz).toEqual([0.5, 0.5]);
  });

  it("removing the last child of a band removes the band", () => {
    const band = split("c", [split("r", [leaf("a"), leaf("b")], [0.5, 0.5])], [400]);
    const n = removeLeaf(band, "a");
    expect(n).toEqual(leaf("b"));
    const gone = removeLeaf(n, "b");
    expect(gone).toBeNull();
  });

  it("removeLeaf keeps the tree normalized and sz aligned", () => {
    const t = split("c", [leaf("a"), split("r", [leaf("b"), leaf("c")], [0.5, 0.5])], [300, 400]);
    const n = removeLeaf(t, "b");
    expect(n.ch[1]).toEqual(leaf("c"));
    expect(n.sz.length).toBe(n.ch.length);
    // root band sizes are px, not weights: untouched
    expect(n.sz).toEqual([300, 400]);
  });

  it("ids order is reading order: left to right, top to bottom", () => {
    const row = split("r", [leaf("l"), leaf("r")], [0.5, 0.5]);
    const t = split("c", [row, leaf("below")], [300, 200]);
    expect(ids(t)).toEqual(["l", "r", "below"]);
  });

  it("findLeaf and parentOf", () => {
    const inner = split("r", [leaf("b"), leaf("c")], [0.5, 0.5]);
    const t = split("c", [leaf("a"), inner], [300, 400]);
    expect(findLeaf(t, "c")).toEqual(leaf("c"));
    expect(findLeaf(t, "zz")).toBeNull();
    expect(parentOf(t, "a")).toBe(t);
    expect(parentOf(t, "b")).toBe(inner);
    expect(parentOf(leaf("a"), "a")).toBeNull();
  });

  it("a root column keeps band px; a weight split renormalizes", () => {
    const t = split("c", [leaf("a"), leaf("b")], [300, 400]);
    expect(normalize(t).sz).toEqual([300, 400]);
    const w = split("c", [leaf("a"), leaf("b")], [0.3, 0.7]);
    expect(normalize(w).sz).toEqual([0.3, 0.7]);
  });

  it("removeLeaf on a group-body column renormalizes weights (isRoot=false)", () => {
    const body = split("c", [leaf("a"), leaf("b"), leaf("c")], [0.2, 0.3, 0.5]);
    const n = removeLeaf(body, "b", false);
    expect(ids(n)).toEqual(["a", "c"]);
    expect(n.sz[0]).toBeCloseTo(0.2 / 0.7);
    expect(n.sz[1]).toBeCloseTo(0.5 / 0.7);
  });

  it("removeLeaf on a root column keeps band px", () => {
    const t = split("c", [leaf("a"), leaf("b"), leaf("c")], [300, 400, 200]);
    const n = removeLeaf(t, "b");
    expect(n.sz).toEqual([300, 200]);
  });

  it("a root column merge of px bands keeps px and multiplies nested weights", () => {
    const inner = split("c", [leaf("b"), leaf("c")], [0.25, 0.75]);
    const t = split("c", [leaf("a"), inner], [300, 400]);
    const n = normalize(t, true);
    // the nested column merges into the root column: px band sizes multiply the weights
    expect(n.d).toBe("c");
    expect(ids(n)).toEqual(["a", "b", "c"]);
    expect(n.sz).toEqual([300, 100, 300]);
    // px bands are not renormalized to weights
    expect(n.sz.reduce((a: number, b: number) => a + b, 0)).toBe(700);
  });

  it("normalize is idempotent", () => {
    const t = split("r", [split("r", [leaf("a"), leaf("b")], [1, 3]), leaf("c")], [0.5, 0.5]);
    const once = normalize(t);
    const twice = normalize(once);
    expect(twice).toEqual(once);
  });
});
