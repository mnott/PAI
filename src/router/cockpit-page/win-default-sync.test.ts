import { describe, expect, it } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSavedAt, saveDefaultLayout } from "../cockpit-layout-default.js";

const read = (f: string) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8");
const sm = read("./win/store.ts").match(/export const WIN_STORE_JS = String\.raw`([\s\S]*?)`;/)!;
const tm = read("./win/tree.ts").match(/export const WIN_TREE_JS = String\.raw`([\s\S]*?)`;/)!;
const api = (new Function(
  `${tm[1]}\n${sm[1]}\nreturn {loadWin:loadWin,saveWin:saveWin,defaultPending:defaultPending,adoptDefault:adoptDefault,servedAt:servedAt};`,
) as any)();

class Mem {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}
const leaf = (id: string) => ({ k: "c", id });
const tree = (...ids: string[]) => ({ k: "s", d: "c", ch: ids.map(leaf), sz: ids.map(() => 100) });
const defaults = (savedAt: number | undefined, ids = ["a", "b"]) => ({
  tree: tree("a", "b"),
  kids: {},
  stDefaults: {},
  savedAt,
  served: { v: 2, tree: tree(...ids), kids: {}, st: {} },
});
const KNOWN = ["a", "b", "c"];
const ownLayout = (s: Mem, t: number) => s.setItem("pai.cockpit.win.v2", JSON.stringify({ v: 2, t, tree: tree("b", "a", "c"), kids: {}, st: {} }));
const idsOf = (r: any) => r.tree.ch.map((c: any) => c.id).join("");

describe("saved default reaches devices", () => {
  it("a device without edits adopts a newer default and records it", () => {
    const s = new Mem();
    ownLayout(s, 100);
    const r = api.loadWin(s, defaults(500, ["c", "a", "b"]), KNOWN, 1000);
    expect(idsOf(r)).toBe("cab");
    expect(api.defaultPending(s, 500)).toBe(false);
  });

  it("a fresh device uses the default and records it", () => {
    const s = new Mem();
    expect(idsOf(api.loadWin(s, defaults(500, ["c", "a", "b"]), KNOWN, 1000))).toBe("cab");
    expect(api.defaultPending(s, 500)).toBe(false);
  });

  it("a device edited after the default was saved keeps its layout and the default stays pending", () => {
    const s = new Mem();
    ownLayout(s, 900);
    const r = api.loadWin(s, defaults(500, ["c", "a", "b"]), KNOWN, 1000);
    expect(idsOf(r)).toBe("bac");
    expect(api.defaultPending(s, 500)).toBe(true);
    api.adoptDefault(s);
    expect(idsOf(api.loadWin(s, defaults(500, ["c", "a", "b"]), KNOWN, 1000))).toBe("cab");
    expect(api.defaultPending(s, 500)).toBe(false);
  });

  it("a device already at that default is unchanged, even with later edits", () => {
    const s = new Mem();
    api.loadWin(s, defaults(500, ["c", "a", "b"]), KNOWN, 1000);
    ownLayout(s, 2000);
    expect(idsOf(api.loadWin(s, defaults(500, ["c", "a", "b"]), KNOWN, 3000))).toBe("bac");
    expect(api.defaultPending(s, 500)).toBe(false);
    ownLayout(s, 100);
    expect(idsOf(api.loadWin(s, defaults(500, ["c", "a", "b"]), KNOWN, 3000))).toBe("bac");
  });

  it("a poll reporting a later savedAt is pending; a default without savedAt never is", () => {
    const s = new Mem();
    api.loadWin(s, defaults(500), KNOWN, 1000);
    expect(api.defaultPending(s, 800)).toBe(true);
    expect(api.defaultPending(s, 0)).toBe(false);
    expect(api.defaultPending(s, undefined)).toBe(false);
    const s2 = new Mem();
    ownLayout(s2, 100);
    expect(idsOf(api.loadWin(s2, defaults(undefined, ["c", "a", "b"]), KNOWN, 1000))).toBe("bac");
  });
});

describe("savedAt served", () => {
  it("the state file time is the savedAt", () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-sync-"));
    try {
      const f = join(dir, "d.json");
      expect(defaultSavedAt(f)).toBe(0);
      const before = Date.now() - 2000;
      expect(saveDefaultLayout(JSON.stringify({ v: 2, tree: leaf("a") }), f)).toBe(true);
      expect(defaultSavedAt(f)).toBeGreaterThan(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
