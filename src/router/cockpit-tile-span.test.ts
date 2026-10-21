import { describe, expect, it } from "vitest";
import { COCKPIT_HTML } from "./cockpit-page.js";

function el(attrs: Record<string, string> = {}, w = 0): any {
  const classes = new Set<string>();
  const vars: Record<string, string> = {};
  const n: any = {
    attrs: { ...attrs }, classes, children: [] as any[], parentNode: null, textContent: "", title: "", offsetWidth: w, vars,
    style: { setProperty: (k: string, v: string) => { vars[k] = v; }, removeProperty: (k: string) => { delete vars[k]; } },
    classList: { contains: (c: string) => classes.has(c), toggle: (c: string, on: boolean) => { if (on) classes.add(c); else classes.delete(c); } },
    getAttribute: (k: string) => n.attrs[k] ?? null,
    setAttribute: (k: string, v: string) => { n.attrs[k] = v; },
    appendChild(c: any) { const p = c.parentNode; if (p) p.children.splice(p.children.indexOf(c), 1); c.parentNode = n; n.children.push(c); },
    insertBefore(c: any) { n.appendChild(c); },
    removeChild() {}, focus() {},
  };
  return n;
}
const pick = (re: RegExp) => COCKPIT_HTML.match(re)![0];
const src = [
  pick(/var LKEY="[^\n]*\n/), pick(/function tileOrder\(\)[^\n]*\n/), pick(/function saveTileOrder\([^\n]*\n/),
  pick(/function tids\([\s\S]*?\n\}\n/), pick(/function tkeyOf\([^\n]*\n/),
  pick(/var SPANS=[^\n]*\n/), pick(/function snapSpan\([\s\S]*?\n\}\n/), pick(/function applySpans\([\s\S]*?\n\}\n/), pick(/function wireSpan\([\s\S]*?\n\}\n/),
  pick(/function applyTileOrder\([\s\S]*?\n\}\n/),
].join("\n");

function harness(widths: number[]) {
  const store: Record<string, string> = {};
  const ls = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } };
  const api = new Function("localStorage", "document", `${src}\nreturn {applyTileOrder:applyTileOrder};`)(ls, { createElement: () => el() }) as { applyTileOrder(c: any): void };
  const render = () => {
    const sec = el(), cont = el({ "data-tkey": "k", "data-tnomin": "1" }, 1200);
    sec.appendChild(cont);
    widths.forEach((w, i) => cont.appendChild(el({ "data-tid": "t" + i }, w)));
    cont.__tkey = "k";
    return cont;
  };
  const tiles = (c: any) => c.children.filter((x: any) => x.getAttribute("data-tid"));
  return { api, render, store, tiles };
}

describe("tile width spans", () => {
  it("an untouched container keeps its auto layout: no span class, no span variable", () => {
    const h = harness([400, 400, 400]);
    const c = h.render();
    h.api.applyTileOrder(c);
    expect(c.classes.has("tspan")).toBe(false);
    for (const t of h.tiles(c)) expect(t.vars["--sp"]).toBeUndefined();
  });
  it("a saved span is restored on a fresh render; unspanned tiles keep their measured auto width", () => {
    const h = harness([400, 400, 400]);
    h.store["pai.cockpit.tiles.v1"] = JSON.stringify({ "k#w": { t0: 12 } });
    const c = h.render();
    h.api.applyTileOrder(c);
    expect(c.classes.has("tspan")).toBe(true);
    expect(h.tiles(c).map((t: any) => t.vars["--sp"])).toEqual(["12", "4", "4"]);
  });
  it("the width button cycles full, half, third, quarter and persists next to the order", () => {
    const h = harness([600, 600]);
    const c = h.render();
    h.api.applyTileOrder(c);
    const t0 = h.tiles(c)[0];
    t0.__twd.onclick(); // auto width is half, so the next step is third
    expect(JSON.parse(h.store["pai.cockpit.tiles.v1"])["k#w"]).toEqual({ t0: 4 });
    h.tiles(c)[0].__twd.onclick();
    expect(JSON.parse(h.store["pai.cockpit.tiles.v1"])["k#w"]).toEqual({ t0: 3 });
    h.tiles(c)[0].__twd.onclick();
    expect(JSON.parse(h.store["pai.cockpit.tiles.v1"])["k#w"]).toEqual({ t0: 12 });
  });
  it("narrow windows force every spanned tile to full width in the stylesheet", () => {
    expect(COCKPIT_HTML).toMatch(/@media\(max-width:699px\)\{\.tspan>\[data-tid\]\{grid-column:1\/-1!important\}\}/);
    expect(COCKPIT_HTML).toMatch(/\.tspan>\[data-tid\]\{grid-column:span var\(--sp,12\)!important\}/);
  });
});
