import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Same approach as win-tree.test.ts: read the module source, build the ES5 string with
// new Function. removeLeaf comes from win/tree.ts — store.ts uses it as a page global.
const storeSrc = readFileSync(fileURLToPath(new URL("./win/store.ts", import.meta.url)), "utf8");
const sm = storeSrc.match(/export const WIN_STORE_JS = String\.raw`([\s\S]*?)`;/);
if (!sm) throw new Error("WIN_STORE_JS not found in win/store.ts");
const treeSrc = readFileSync(fileURLToPath(new URL("./win/tree.ts", import.meta.url)), "utf8");
const tm = treeSrc.match(/export const WIN_TREE_JS = String\.raw`([\s\S]*?)`;/);
if (!tm) throw new Error("WIN_TREE_JS not found in win/tree.ts");
const api = (new Function(
  `${tm[1]}\n${sm[1]}\nreturn {leaf:leaf,split:split,ids:ids,findLeaf:findLeaf,parentOf:parentOf,loadWin:loadWin,reconcileSaved:reconcileSaved,saveWin:saveWin,resetWin:resetWin};`,
) as any)();
const leaf = (id: string) => api.leaf(id);
const split = (d: string, ch: any[], sz: number[]) => api.split(d, ch, sz);
const { ids, findLeaf, parentOf, loadWin, reconcileSaved, saveWin, resetWin } = api;

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_760_000_000_000;

class MemStorage {
  map = new Map<string, string>();
  setCalls = 0;
  getItem(k: string): string | null {
    return this.map.has(k) ? (this.map.get(k) as string) : null;
  }
  setItem(k: string, v: string) {
    this.setCalls += 1;
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

// static default layout: a root column of two bands; the second band is a row [b, c];
// the group "g" body is a column [g1, g2]. "d" is a default card the page does not carry
// (not in knownIds) and must never be inserted.
const defaults = () => ({
  tree: split("c", [leaf("a"), split("r", [leaf("b"), leaf("c")], [0.5, 0.5])], [300, 400]),
  kids: { g: split("c", [leaf("g1"), leaf("g2")], [0.5, 0.5]) },
  stDefaults: { a: { min: 1 } },
});
const KNOWN = ["a", "b", "c", "g1", "g2"];
const KNOWN_NO_GROUP = ["a", "b", "c"];
// the default layout without the group, and the ids it knows: tests whose saved tree carries
// no group card use these, so the group's static ids are not "missing" there.
const defaultsNoGroup = () => ({
  tree: split("c", [leaf("a"), split("r", [leaf("b"), leaf("c")], [0.5, 0.5])], [300, 400]),
  kids: {},
  stDefaults: { a: { min: 1 } },
});

const saved = (obj: unknown) => JSON.stringify(obj);

describe("win store (spec 6)", () => {
  it("invalid JSON -> defaults", () => {
    const s = new MemStorage();
    s.setItem("pai.cockpit.win.v2", "{not json");
    const r = loadWin(s, defaults(), KNOWN, NOW);
    expect(r.tree).toEqual(defaults().tree);
    expect(r.kids).toEqual(defaults().kids);
    expect(r.st).toEqual({ a: { min: 1 } });
  });

  it("no stored value -> defaults", () => {
    const r = loadWin(new MemStorage(), defaults(), KNOWN, NOW);
    expect(r.tree).toEqual(defaults().tree);
  });

  it("v1 -> defaults and the old keys are removed", () => {
    const s = new MemStorage();
    s.setItem("pai.cockpit.layout.v1", '[["a","b"]]');
    s.setItem("pai.cockpit.tiles.v1", '{"g":["g2"]}');
    s.setItem("pai.cockpit.collapsed", '["system"]');
    s.setItem("pai.cockpit.win.v2", saved({ v: 1, tree: leaf("x"), kids: {}, st: {} }));
    const r = loadWin(s, defaults(), KNOWN, NOW);
    expect(r.tree).toEqual(defaults().tree);
    expect(s.map.has("pai.cockpit.layout.v1")).toBe(false);
    expect(s.map.has("pai.cockpit.tiles.v1")).toBe(false);
    expect(s.map.has("pai.cockpit.collapsed")).toBe(false);
  });

  it("missing or non-number v -> defaults", () => {
    const s = new MemStorage();
    s.setItem("pai.cockpit.win.v2", saved({ tree: leaf("a"), kids: {}, st: {} }));
    expect(loadWin(s, defaults(), KNOWN, NOW).tree).toEqual(defaults().tree);
  });

  it("unknown ids are kept as ghosts; a 31-day-old ghost is pruned", () => {
    const s = new MemStorage();
    s.setItem(
      "pai.cockpit.win.v2",
      saved({
        v: 2,
        tree: split("c", [leaf("a"), leaf("ghost-new"), leaf("ghost-old")], [300, 200, 200]),
        kids: {},
        st: { "ghost-new": { seen: NOW - DAY }, "ghost-old": { seen: NOW - 31 * DAY } },
      }),
    );
    const r = loadWin(s, defaultsNoGroup(), KNOWN_NO_GROUP, NOW);
    expect(ids(r.tree)).toEqual(["a", "ghost-new", "b", "c"]); // b,c re-inserted: static cards never disappear
    expect(r.st["ghost-old"]).toBeUndefined();
    expect(r.st["ghost-new"]).toEqual({ seen: NOW - DAY });
  });

  it("a ghost with no seen stamp is kept (treated as just seen)", () => {
    const s = new MemStorage();
    s.setItem("pai.cockpit.win.v2", saved({ v: 2, tree: split("c", [leaf("a"), leaf("ghost")], [300, 200]), kids: {}, st: {} }));
    const r = loadWin(s, defaultsNoGroup(), KNOWN_NO_GROUP, NOW);
    expect(ids(r.tree)).toEqual(["a", "ghost", "b", "c"]);
  });

  it("a new static id is inserted next to its default neighbour", () => {
    const s = new MemStorage();
    // saved tree lacks "c"; default puts c right after b (in the row)
    s.setItem(
      "pai.cockpit.win.v2",
      saved({ v: 2, tree: split("c", [leaf("a"), split("r", [leaf("b"), leaf("zz")], [0.5, 0.5])], [300, 400]), kids: {}, st: { zz: { seen: NOW } } }),
    );
    const r = loadWin(s, defaultsNoGroup(), KNOWN_NO_GROUP, NOW);
    expect(ids(r.tree)).toEqual(["a", "b", "zz", "c"]); // zz is a fresh ghost (no seen stamp)
    // c sits right after its default neighbour b; the unknown ghost zz stays where it was
    expect(findLeaf(r.tree, "c")).toBeTruthy();
    const p = parentOf(r.tree, "c");
    expect(p.k).toBe("s");
    expect(p.d).toBe("r");
    expect(ids(p)).toEqual(["b", "zz", "c"]);
  });

  it("a new static id with no known neighbour becomes a new band at the end", () => {
    const s = new MemStorage();
    // saved tree lacks "b"; default neighbour c is also gone -> no known neighbour
    s.setItem("pai.cockpit.win.v2", saved({ v: 2, tree: split("c", [leaf("a"), leaf("zz")], [300, 200]), kids: {}, st: { zz: { seen: NOW } } }));
    const r = loadWin(s, defaultsNoGroup(), KNOWN_NO_GROUP, NOW);
    expect(ids(r.tree)).toEqual(["a", "zz", "b", "c"]);
    expect(r.tree.d).toBe("c");
    expect(r.tree.ch[2].k).toBe("c");
    expect(r.tree.ch[2].id).toBe("b");
    expect(r.tree.ch[3].k).toBe("c");
    expect(r.tree.ch[3].id).toBe("c");
  });

  it("reconcileSaved inserts a missing static id after its default predecessor", () => {
    const r = reconcileSaved({ tree: split("c", [leaf("a"), leaf("b")], [300, 400]), kids: {}, st: {} }, defaultsNoGroup(), KNOWN_NO_GROUP, NOW);
    expect(ids(r.tree)).toEqual(["a", "b", "c"]);
    expect(r.st.a).toEqual({ min: 1 });
  });

  it("a missing id inside a group body is inserted in that body, not the root", () => {
    const s = new MemStorage();
    s.setItem(
      "pai.cockpit.win.v2",
      saved({ v: 2, tree: split("c", [leaf("a"), leaf("b"), leaf("c")], [300, 200, 200]), kids: { g: leaf("g1") }, st: {} }),
    );
    const r = loadWin(s, defaults(), KNOWN, NOW);
    expect(ids(r.kids.g)).toEqual(["g1", "g2"]);
    expect(ids(r.tree)).toEqual(["a", "b", "c"]);
  });

  it("a default card the page does not carry is not inserted", () => {
    const s = new MemStorage();
    s.setItem("pai.cockpit.win.v2", saved({ v: 2, tree: split("c", [leaf("a"), leaf("b"), leaf("c")], [300, 200, 200]), kids: {}, st: {} }));
    const r = loadWin(s, defaultsNoGroup(), ["a", "b", "c", "g1", "g2"], NOW);
    expect(ids(r.tree)).toEqual(["a", "b", "c"]);
  });

  it("saved state wins over default min flags; defaults fill the rest", () => {
    const s = new MemStorage();
    s.setItem(
      "pai.cockpit.win.v2",
      saved({ v: 2, tree: split("c", [leaf("a")], [300]), kids: {}, st: { a: { min: 0 }, b: { min: 1 } } }),
    );
    const r = loadWin(s, defaults(), KNOWN, NOW);
    expect(r.st.a).toEqual({ min: 0 }); // explicit restore beats default min:1
    expect(r.st.b).toEqual({ min: 1 });
    expect(r.st.c).toBeUndefined();
  });

  it("saveWin writes the whole object in a single setItem", () => {
    const s = new MemStorage();
    saveWin(s, leaf("a"), { g: leaf("g1") }, { a: { min: 1 } });
    expect(s.setCalls).toBe(1);
    const obj = JSON.parse(s.map.get("pai.cockpit.win.v2") as string);
    expect(obj.v).toBe(2);
    expect(obj.tree).toEqual(leaf("a"));
    expect(obj.kids).toEqual({ g: leaf("g1") });
    expect(obj.st).toEqual({ a: { min: 1 } });
  });

  it("load -> save -> load round-trips", () => {
    const s = new MemStorage();
    const r1 = loadWin(s, defaults(), KNOWN, NOW);
    saveWin(s, r1.tree, r1.kids, r1.st);
    const r2 = loadWin(s, defaults(), KNOWN, NOW);
    expect(r2.tree).toEqual(r1.tree);
    expect(r2.kids).toEqual(r1.kids);
    expect(r2.st).toEqual(r1.st);
  });

  it("resetWin returns fresh defaults with reset state", () => {
    const r = resetWin(defaults());
    expect(r.tree).toEqual(defaults().tree);
    expect(r.kids).toEqual(defaults().kids);
    expect(r.st).toEqual({ a: { min: 1 } });
    // defaults() was not mutated
    expect(defaults().tree).toEqual(defaults().tree);
  });

  it("load does not mutate the defaults object", () => {
    const d = defaults();
    const s = new MemStorage();
    s.setItem("pai.cockpit.win.v2", saved({ v: 2, tree: leaf("a"), kids: {}, st: {} }));
    const r = loadWin(s, d, KNOWN, NOW);
    expect(r.tree).not.toBe(d.tree);
    expect(d.tree).toEqual(defaults().tree);
  });
});
