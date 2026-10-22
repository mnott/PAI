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

  it("a stored min is normalised to 1 when truthy, else to 0", () => {
    const s = new MemStorage();
    s.setItem(
      "pai.cockpit.win.v2",
      saved({ v: 2, tree: split("c", [leaf("a")], [300]), kids: {}, st: { a: { min: true }, b: { min: "1" }, c: { min: 2 }, g1: { min: 0 } } }),
    );
    const r = loadWin(s, defaults(), KNOWN, NOW);
    expect(r.st.a).toEqual({ min: 1 });
    expect(r.st.b).toEqual({ min: 1 });
    expect(r.st.c).toEqual({ min: 1 });
    expect(r.st.g1).toEqual({ min: 0 }); // an explicit restore stays 0
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

describe("served default layout (a device with no layout of its own)", () => {
  const served = () => ({ v: 2, t: 1, tree: split("c", [leaf("c"), leaf("b"), leaf("a")], [100, 200, 300]), kids: {}, st: {} });

  it("a fresh device starts from the served default, not the built-in", () => {
    const s = new MemStorage();
    const l = loadWin(s, { ...defaultsNoGroup(), served: served() }, KNOWN_NO_GROUP, NOW);
    expect(ids(l.tree)).toEqual(["c", "b", "a"]);
  });

  it("a device with its own layout keeps it", () => {
    const s = new MemStorage();
    saveWin(s, split("c", [leaf("b"), leaf("a"), leaf("c")], [1, 2, 3]), {}, {}, false);
    const l = loadWin(s, { ...defaultsNoGroup(), served: served() }, KNOWN_NO_GROUP, NOW);
    expect(ids(l.tree)).toEqual(["b", "a", "c"]);
  });

  it("no served default, or an invalid one: the built-in", () => {
    for (const bad of [undefined, null, { v: 1, tree: {} }, { v: 2 }]) {
      const l = loadWin(new MemStorage(), { ...defaultsNoGroup(), served: bad }, KNOWN_NO_GROUP, NOW);
      expect(ids(l.tree)).toEqual(ids(defaultsNoGroup().tree));
    }
  });

  it("reset (storage cleared) restores the served default", () => {
    const s = new MemStorage();
    const d = { ...defaultsNoGroup(), served: served() };
    saveWin(s, split("c", [leaf("b"), leaf("a"), leaf("c")], [1, 2, 3]), {}, {}, false);
    s.removeItem("pai.cockpit.win.v2");
    expect(ids(loadWin(s, d, KNOWN_NO_GROUP, NOW).tree)).toEqual(["c", "b", "a"]);
  });
});

describe("tokens group migration", () => {
  const tokDefaults = () => ({
    tree: split("c", [leaf("a"), leaf("tokens-group")], [300, 600]),
    kids: { "tokens-group": split("c", [leaf("tokens"), leaf("daily")], [0.5, 0.5]) },
    stDefaults: {},
  });
  const K = ["a", "tokens-group", "tokens", "daily"];
  it("default tree has the group with both cards", () => {
    const d = tokDefaults();
    expect(ids(d.tree)).toContain("tokens-group");
    expect(ids(d.kids["tokens-group"])).toEqual(["tokens", "daily"]);
  });
  it("wraps both root-level cards into the group at the first one's place, keeping heights", () => {
    const saved = { v: 2, tree: split("c", [leaf("a"), leaf("tokens"), leaf("daily")], [300, 200, 400]), kids: {}, st: {} };
    const r = reconcileSaved(saved, tokDefaults(), K, NOW);
    expect(ids(r.tree)).toEqual(["a", "tokens-group"]);
    expect(r.tree.sz).toEqual([300, 600]);
    expect(ids(r.kids["tokens-group"])).toEqual(["tokens", "daily"]);
    expect(r.kids["tokens-group"].sz[0]).toBeCloseTo(1 / 3);
  });
  it("leaves an already grouped tree alone", () => {
    const kids = { "tokens-group": split("c", [leaf("daily"), leaf("tokens")], [0.3, 0.7]) };
    const saved = { v: 2, tree: split("c", [leaf("tokens-group"), leaf("a")], [500, 300]), kids, st: {} };
    const r = reconcileSaved(saved, tokDefaults(), K, NOW);
    expect(ids(r.tree)).toEqual(["tokens-group", "a"]);
    expect(ids(r.kids["tokens-group"])).toEqual(["daily", "tokens"]);
    expect(r.kids["tokens-group"].sz).toEqual([0.3, 0.7]);
  });
  it("does not insert the group over cards the user placed inside another group", () => {
    const saved = { v: 2, tree: split("c", [leaf("x"), leaf("a")], [200, 300]), kids: { x: split("c", [leaf("tokens"), leaf("daily")], [0.5, 0.5]) }, st: {} };
    const r = reconcileSaved(saved, tokDefaults(), K, NOW);
    expect(ids(r.tree)).toEqual(["x", "a"]);
    expect(r.kids["tokens-group"]).toBeUndefined();
    expect(ids(r.kids.x)).toEqual(["tokens", "daily"]);
  });
  it("a lone root card (old: left at root) moves into the group", () => {
    const saved = { v: 2, tree: split("c", [leaf("tokens"), leaf("a")], [200, 300]), kids: { x: leaf("daily") }, st: {} };
    const r = reconcileSaved(saved, tokDefaults(), K, NOW);
    expect(ids(r.tree)).toEqual(["tokens-group", "a"]);
    expect(r.tree.sz).toEqual([200, 300]);
  });
});

describe("every mapped root card migrates into its group", () => {
  const defs = () => ({
    tree: split("c", [leaf("a"), leaf("tokens-group"), leaf("perf-group")], [100, 800, 700]),
    kids: {
      "tokens-group": split("c", [leaf("tokens"), leaf("daily"), leaf("speed")], [0.4, 0.3, 0.3]),
      "perf-group": split("c", [leaf("runs"), leaf("sessions"), leaf("pause")], [0.4, 0.3, 0.3]),
    },
    stDefaults: {},
  });
  const K2 = ["a", "tokens-group", "tokens", "daily", "speed", "perf-group", "runs", "sessions", "pause"];
  it("default tree has no root-level leaf card, only groups", () => {
    const d = defs();
    expect(d.tree.ch.filter((c: any) => c.k === "c" && !(d.kids as any)[c.id] && c.id !== "a")).toEqual([]);
  });
  it.each([
    ["speed", "tokens-group"],
    ["runs", "perf-group"],
    ["sessions", "perf-group"],
    ["pause", "perf-group"],
  ])("%s at root moves into %s keeping its height", (card, grp) => {
    const saved = { v: 2, tree: split("c", [leaf("a"), leaf(card)], [100, 250]), kids: {}, st: {} };
    const r = reconcileSaved(saved, defs(), K2, NOW);
    expect(ids(r.tree)).toContain(grp);
    expect(ids(r.tree)).not.toContain(card);
    expect(ids(r.kids[grp])).toContain(card);
    expect(r.tree.sz[ids(r.tree).indexOf(grp)]).toBe(250);
  });
  it("performance cards at root become one group at the first one's place", () => {
    const saved = { v: 2, tree: split("c", [leaf("pause"), leaf("a"), leaf("runs"), leaf("sessions")], [100, 50, 300, 200]), kids: {}, st: {} };
    const r = reconcileSaved(saved, defs(), K2, NOW);
    expect(ids(r.tree).filter((i: string) => i !== "tokens-group")).toEqual(["perf-group", "a"]);
    expect(r.tree.sz.slice(0, 2)).toEqual([600, 50]);
    expect(ids(r.kids["perf-group"])).toEqual(["pause", "runs", "sessions"]);
  });
  it("a mapped card inside a user group stays there", () => {
    const saved = { v: 2, tree: split("c", [leaf("a"), leaf("mine")], [100, 250]), kids: { mine: split("c", [leaf("pause"), leaf("runs")], [0.5, 0.5]) }, st: {} };
    const r = reconcileSaved(saved, defs(), K2, NOW);
    expect(ids(r.kids.mine)).toEqual(["pause", "runs"]);
    expect(ids(r.tree)).not.toContain("perf-group");
  });
});
