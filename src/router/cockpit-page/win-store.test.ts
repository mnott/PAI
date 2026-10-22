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
  `${tm[1]}\n${sm[1]}\nreturn {leaf:leaf,split:split,ids:ids,findLeaf:findLeaf,parentOf:parentOf,loadWin:loadWin,reconcileSaved:reconcileSaved,saveWin:saveWin,resetWin:resetWin,flatDefaults:flatDefaults,flatTree:flatTree,unitsOf:unitsOf,migrateState:migrateState};`,
) as any)();
const leaf = (id: string) => api.leaf(id);
const split = (d: string, ch: any[], sz: number[]) => api.split(d, ch, sz);
const { ids, findLeaf, parentOf, loadWin, reconcileSaved, saveWin, resetWin, flatDefaults } = api;
// win-store.test.ts was updated for the CSS grid: positions are CSS grid now, a container is a flat ordered list and a row becomes width units (st.w)
const flatTree = () => flatDefaults(defaults()).tree;

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
    expect(r.tree).toEqual(flatTree());
    expect(r.kids).toEqual(defaults().kids);
    expect(r.st).toEqual({ a: { min: 1 }, b: { w: 6 }, c: { w: 6 } }); // the row of the default is two 6-unit cards
  });

  it("no stored value -> defaults", () => {
    const r = loadWin(new MemStorage(), defaults(), KNOWN, NOW);
    expect(r.tree).toEqual(flatTree());
  });

  it("v1 -> defaults and the old keys are removed", () => {
    const s = new MemStorage();
    s.setItem("pai.cockpit.layout.v1", '[["a","b"]]');
    s.setItem("pai.cockpit.tiles.v1", '{"g":["g2"]}');
    s.setItem("pai.cockpit.collapsed", '["system"]');
    s.setItem("pai.cockpit.win.v2", saved({ v: 1, tree: leaf("x"), kids: {}, st: {} }));
    const r = loadWin(s, defaults(), KNOWN, NOW);
    expect(r.tree).toEqual(flatTree());
    expect(s.map.has("pai.cockpit.layout.v1")).toBe(false);
    expect(s.map.has("pai.cockpit.tiles.v1")).toBe(false);
    expect(s.map.has("pai.cockpit.collapsed")).toBe(false);
  });

  it("missing or non-number v -> defaults", () => {
    const s = new MemStorage();
    s.setItem("pai.cockpit.win.v2", saved({ tree: leaf("a"), kids: {}, st: {} }));
    expect(loadWin(s, defaults(), KNOWN, NOW).tree).toEqual(flatTree());
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
    expect(ids(r.tree)).toEqual(["a", "b", "c", "ghost-new"]); // b,c re-inserted after a: static cards never disappear
    expect(r.st["ghost-old"]).toBeUndefined();
    expect(r.st["ghost-new"]).toEqual({ seen: NOW - DAY });
  });

  it("a ghost with no seen stamp is kept (treated as just seen)", () => {
    const s = new MemStorage();
    s.setItem("pai.cockpit.win.v2", saved({ v: 2, tree: split("c", [leaf("a"), leaf("ghost")], [300, 200]), kids: {}, st: {} }));
    const r = loadWin(s, defaultsNoGroup(), KNOWN_NO_GROUP, NOW);
    expect(ids(r.tree)).toEqual(["a", "b", "c", "ghost"]);
  });

  it("a new static id is inserted next to its default neighbour", () => {
    const s = new MemStorage();
    // saved tree lacks "c"; default puts c right after b (in the row)
    s.setItem(
      "pai.cockpit.win.v2",
      saved({ v: 2, tree: split("c", [leaf("a"), split("r", [leaf("b"), leaf("zz")], [0.5, 0.5])], [300, 400]), kids: {}, st: { zz: { seen: NOW } } }),
    );
    const r = loadWin(s, defaultsNoGroup(), KNOWN_NO_GROUP, NOW);
    expect(ids(r.tree)).toEqual(["a", "b", "c", "zz"]); // zz is a fresh ghost (no seen stamp)
    // c sits right after its default neighbour b
    expect(findLeaf(r.tree, "c")).toBeTruthy();
    expect(parentOf(r.tree, "c").d).toBe("c");
  });

  it("a new static id follows its default neighbour; the ghost keeps its place after them", () => {
    const s = new MemStorage();
    // saved tree lacks "b"; default neighbour c is also gone -> no known neighbour
    s.setItem("pai.cockpit.win.v2", saved({ v: 2, tree: split("c", [leaf("a"), leaf("zz")], [300, 200]), kids: {}, st: { zz: { seen: NOW } } }));
    const r = loadWin(s, defaultsNoGroup(), KNOWN_NO_GROUP, NOW);
    expect(ids(r.tree)).toEqual(["a", "b", "c", "zz"]);
    expect(r.tree.d).toBe("c");
    expect(r.tree.ch.map((c: any) => c.id)).toEqual(["a", "b", "c", "zz"]);
  });

  it("reconcileSaved drops the retired cache.low card and keeps its neighbour", () => {
    const saved = { tree: split("c", [leaf("a"), leaf("b")], [300, 400]), kids: { g: split("r", [leaf("cache.low"), leaf("cache.note")], [1, 1]) }, st: { "cache.low": { min: 1 } } };
    const r = reconcileSaved(saved, defaultsNoGroup(), KNOWN_NO_GROUP, NOW);
    expect(ids(r.kids.g)).toEqual(["cache.note"]);
    expect(r.st["cache.low"]).toBeUndefined();
    const t = reconcileSaved({ tree: split("c", [leaf("a"), leaf("cache.low"), leaf("b")], [1, 1, 1]), kids: {}, st: {} }, defaultsNoGroup(), KNOWN_NO_GROUP, NOW);
    expect(ids(t.tree)).not.toContain("cache.low");
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
    expect(r.st.b).toEqual({ min: 1, w: 6 }); // the default width fills in
    expect(r.st.c).toEqual({ w: 6 });
  });

  it("a stored min is normalised to 1 when truthy, else to 0", () => {
    const s = new MemStorage();
    s.setItem(
      "pai.cockpit.win.v2",
      saved({ v: 2, tree: split("c", [leaf("a")], [300]), kids: {}, st: { a: { min: true }, b: { min: "1" }, c: { min: 2 }, g1: { min: 0 } } }),
    );
    const r = loadWin(s, defaults(), KNOWN, NOW);
    expect(r.st.a).toEqual({ min: 1 });
    expect(r.st.b).toEqual({ min: 1, w: 6 });
    expect(r.st.c).toEqual({ min: 1, w: 6 });
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
    expect(r.tree).toEqual(flatTree());
    expect(r.kids).toEqual(defaults().kids);
    expect(r.st).toEqual({ a: { min: 1 }, b: { w: 6 }, c: { w: 6 } }); // the row of the default is two 6-unit cards
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
  it("wraps both root-level cards into the group at the first one's place", () => {
    const saved = { v: 2, tree: split("c", [leaf("a"), leaf("tokens"), leaf("daily")], [300, 200, 400]), kids: {}, st: {} };
    const r = reconcileSaved(saved, tokDefaults(), K, NOW);
    expect(ids(r.tree)).toEqual(["a", "tokens-group"]);
    expect(ids(r.kids["tokens-group"])).toEqual(["tokens", "daily"]);
  });
  it("leaves an already grouped tree alone", () => {
    const kids = { "tokens-group": split("c", [leaf("daily"), leaf("tokens")], [0.3, 0.7]) };
    const saved = { v: 2, tree: split("c", [leaf("tokens-group"), leaf("a")], [500, 300]), kids, st: {} };
    const r = reconcileSaved(saved, tokDefaults(), K, NOW);
    expect(ids(r.tree)).toEqual(["tokens-group", "a"]);
    expect(ids(r.kids["tokens-group"])).toEqual(["daily", "tokens"]);
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
  });
});

describe("every mapped root card migrates into its group", () => {
  const defs = () => ({
    tree: split("c", [leaf("a"), leaf("tokens-group"), leaf("perf-group")], [100, 800, 700]),
    kids: {
      "tokens-group": split("c", [leaf("tokens"), leaf("daily")], [0.5, 0.5]),
      "perf-group": split("c", [leaf("speed"), leaf("runs"), leaf("sessions"), leaf("pause")], [0.25, 0.25, 0.25, 0.25]),
    },
    stDefaults: {},
  });
  const K2 = ["a", "tokens-group", "tokens", "daily", "speed", "perf-group", "runs", "sessions", "pause"];
  it("default tree has no root-level leaf card, only groups", () => {
    const d = defs();
    expect(d.tree.ch.filter((c: any) => c.k === "c" && !(d.kids as any)[c.id] && c.id !== "a")).toEqual([]);
  });
  it.each([
    ["speed", "perf-group"],
    ["runs", "perf-group"],
    ["sessions", "perf-group"],
    ["pause", "perf-group"],
  ])("%s at root moves into %s", (card, grp) => {
    const saved = { v: 2, tree: split("c", [leaf("a"), leaf(card)], [100, 250]), kids: {}, st: {} };
    const r = reconcileSaved(saved, defs(), K2, NOW);
    expect(ids(r.tree)).toContain(grp);
    expect(ids(r.tree)).not.toContain(card);
    expect(ids(r.kids[grp])).toContain(card);
  });
  it("performance cards at root become one group at the first one's place", () => {
    const saved = { v: 2, tree: split("c", [leaf("pause"), leaf("a"), leaf("runs"), leaf("sessions")], [100, 50, 300, 200]), kids: {}, st: {} };
    const r = reconcileSaved(saved, defs(), K2, NOW);
    expect(ids(r.tree).filter((i: string) => i !== "tokens-group")).toEqual(["perf-group", "a"]);
    expect(ids(r.kids["perf-group"])).toEqual(["pause", "runs", "sessions", "speed"]);
  });
  it("a mapped card inside a user group stays there", () => {
    const saved = { v: 2, tree: split("c", [leaf("a"), leaf("mine")], [100, 250]), kids: { mine: split("c", [leaf("pause"), leaf("runs")], [0.5, 0.5]) }, st: {} };
    const r = reconcileSaved(saved, defs(), K2, NOW);
    expect(ids(r.kids.mine)).toEqual(["pause", "runs"]);
    expect(ids(r.tree)).not.toContain("perf-group");
  });
});

describe("local model servers inside the Models section", () => {
  const defs = () => ({
    tree: split("c", [leaf("a"), leaf("models")], [100, 500]),
    kids: {
      models: split("c", [leaf("sys-servers"), leaf("models.endpoints")], [0.4, 0.6]),
      "sys-servers": leaf("srv"),
    },
    stDefaults: {},
  });
  const K3 = ["a", "models", "sys-servers", "models.endpoints", "srv"];
  it("default tree has the group first inside Models, not at root", () => {
    const d = defs();
    expect(ids(d.tree)).not.toContain("sys-servers");
    expect(ids(d.kids.models)).toEqual(["sys-servers", "models.endpoints"]);
  });
  it("a stored group at root moves into Models as first child", () => {
    const saved = {
      v: 2,
      tree: split("c", [leaf("a"), leaf("sys-servers"), leaf("models")], [100, 300, 500]),
      kids: { models: leaf("models.endpoints"), "sys-servers": leaf("srv") },
      st: {},
    };
    const r = reconcileSaved(saved, defs(), K3, NOW);
    expect(ids(r.tree)).toEqual(["a", "models"]);
    expect(ids(r.kids.models)).toEqual(["sys-servers", "models.endpoints"]);
    expect(r.kids["sys-servers"]).toBeDefined();
  });
  it("a group the user put elsewhere stays and is not duplicated into Models", () => {
    const saved = {
      v: 2,
      tree: split("c", [leaf("a"), leaf("mine"), leaf("models")], [100, 300, 500]),
      kids: { mine: leaf("sys-servers"), models: leaf("models.endpoints"), "sys-servers": leaf("srv") },
      st: {},
    };
    const r = reconcileSaved(saved, defs(), K3, NOW);
    expect(ids(r.kids.mine)).toEqual(["sys-servers"]);
    expect(ids(r.kids.models)).toEqual(["models.endpoints"]);
  });
});
