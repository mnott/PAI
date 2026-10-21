import { describe, expect, it } from "vitest";
import { COCKPIT_HTML } from "./cockpit-page.js";

const pick = (re: RegExp) => COCKPIT_HTML.match(re)![0];

function el(attrs: Record<string, string> = {}): any {
  const n: any = {
    attrs: { ...attrs }, children: [] as any[], parentNode: null, textContent: "", title: "", hidden: false,
    getAttribute: (k: string) => n.attrs[k] ?? null,
    setAttribute: (k: string, v: string) => { n.attrs[k] = v; },
  };
  return n;
}

describe("models panel: minimize all", () => {
  it("one header button minimizes every card through the tile minimize state, and restores them", () => {
    const src = [pick(/var LKEY="[^\n]*\n/), pick(/function tileOrder\(\)[^\n]*\n/), pick(/function saveTileOrder\([^\n]*\n/),
      pick(/function tids\([\s\S]*?\n\}\n/), pick(/function tkeyOf\([^\n]*\n/), pick(/function wireMinAll\([\s\S]*?\n\}\n/)].join("\n");
    const store: Record<string, string> = {};
    const ls = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } };
    const btn = el();
    const grid = el({ "data-tkey": "models cards" });
    for (const id of ["a / m1", "b / m2"]) { const c = el({ "data-tid": id }); c.parentNode = grid; grid.children.push(c); }
    const panel = { querySelector: () => grid };
    const applied: any[] = [];
    const api = new Function("localStorage", "$", "applyTileOrder", `${src}\nreturn wireMinAll;`)(ls, () => btn, (c: any) => applied.push(c));
    api(panel);
    expect(btn.hidden).toBe(false);
    expect(btn.title).toBe("minimize all model cards");
    btn.onclick();
    expect(JSON.parse(store["pai.cockpit.tiles.v1"]!)["models cards#min"]).toEqual(["a / m1", "b / m2"]);
    expect(btn.title).toBe("restore all model cards");
    btn.onclick();
    expect(JSON.parse(store["pai.cockpit.tiles.v1"]!)["models cards#min"]).toBeUndefined();
    expect(applied).toHaveLength(2);
  });
});
