import { describe, expect, it } from "vitest";
import { COCKPIT_HTML } from "./cockpit-page.js";

/** A tiny element tree: just what the nested-tile code touches (children, parentNode, attributes, classList, insertBefore). */
function el(tag: string, attrs: Record<string, string> = {}): any {
  const classes = new Set<string>((attrs["class"] ?? "").split(/\s+/).filter(Boolean));
  const n: any = {
    tag, attrs: { ...attrs }, classes, children: [] as any[], parentNode: null, title: "", textContent: "", type: "",
    get className() { return [...classes].join(" "); },
    set className(v: string) { classes.clear(); v.split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
    classList: { contains: (c: string) => classes.has(c), toggle: (c: string, on: boolean) => { if (on) classes.add(c); else classes.delete(c); } },
    getAttribute: (k: string) => n.attrs[k] ?? null,
    setAttribute: (k: string, v: string) => { n.attrs[k] = v; },
    appendChild(c: any) { detach(c); c.parentNode = n; n.children.push(c); },
    insertBefore(c: any, ref: any) { detach(c); c.parentNode = n; const i = ref ? n.children.indexOf(ref) : -1; if (i >= 0) n.children.splice(i, 0, c); else n.children.push(c); },
    removeChild(c: any) { detach(c); },
    get nextSibling() { const p = n.parentNode; return p ? p.children[p.children.indexOf(n) + 1] ?? null : null; },
    focus() {},
  };
  return n;
}
function detach(c: any) { const p = c.parentNode; if (p) { const i = p.children.indexOf(c); if (i >= 0) p.children.splice(i, 1); c.parentNode = null; } }

const TH = ["tileAttrs", "tileGrip"].map((n) => COCKPIT_HTML.match(new RegExp(`function ${n}\\([^\\n]*\\n`))![0]).join("\n");

const src = [
  COCKPIT_HTML.match(/var LKEY="[^\n]*\n/)![0].replace(/^var /, "var "),
  COCKPIT_HTML.match(/function tileOrder\(\)[^\n]*\n/)![0],
  COCKPIT_HTML.match(/function saveTileOrder\([^\n]*\n/)![0],
  COCKPIT_HTML.match(/function tids\([\s\S]*?\n\}\n/)![0],
  COCKPIT_HTML.match(/function tkeyOf\([^\n]*\n/)![0],
  COCKPIT_HTML.match(/var SPANS=[^\n]*\n/)![0],
  COCKPIT_HTML.match(/function snapSpan\([\s\S]*?\n\}\n/)![0],
  COCKPIT_HTML.match(/function applySpans\([\s\S]*?\n\}\n/)![0],
  COCKPIT_HTML.match(/function wireSpan\([\s\S]*?\n\}\n/)![0],
  COCKPIT_HTML.match(/function applyTileOrder\([\s\S]*?\n\}\n/)![0],
].join("\n");

function harness() {
  const store: Record<string, string> = {};
  const ls = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } };
  const document = { createElement: (t: string) => el(t) };
  const api = new Function("localStorage", "document", `${src}\nreturn {applyTileOrder:applyTileOrder,tileOrder:tileOrder,tids:tids};`)(ls, document) as {
    applyTileOrder(c: any): void; tileOrder(): Record<string, string[]>; tids(c: any): string[];
  };
  /** A section holding one tile container, as setHtml leaves it after a poll: fresh elements, source order. */
  const render = (ids: string[]) => {
    const sec = el("div"), cont = el("div", { "data-tkey": "k" });
    sec.appendChild(cont);
    for (const id of ids) cont.appendChild(el("div", { class: "mt", "data-tid": id, "data-tname": id.toUpperCase(), "data-tval": "7 u" }));
    cont.__tkey = "k";
    return cont;
  };
  const tile = (cont: any, id: string) => [...cont.children, ...(cont.__chips?.children ?? [])].find((t: any) => t.getAttribute("data-tid") === id);
  const press = (t: any) => t.__tmb.onclick();
  return { api, render, tile, press, store };
}

describe("nested tiles: order and minimize inside a section", () => {
  it("a saved order survives the poll re-render and is re-applied to the fresh tiles", () => {
    const h = harness();
    const c1 = h.render(["alpha", "beta", "gamma"]);
    h.api.applyTileOrder(c1);
    h.store["pai.cockpit.tiles.v1"] = JSON.stringify({ k: ["gamma", "alpha", "beta"] });
    const c2 = h.render(["alpha", "beta", "gamma"]);
    h.api.applyTileOrder(c2);
    expect(h.api.tids(c2)).toEqual(["gamma", "alpha", "beta"]);
    expect(c2.children.map((t: any) => t.getAttribute("data-tid"))).toEqual(["gamma", "alpha", "beta"]);
  });

  it("a key the saved order does not know is appended at the end; a removed key drops out of the saved state", () => {
    const h = harness();
    h.store["pai.cockpit.tiles.v1"] = JSON.stringify({ k: ["gamma", "gone", "alpha"], "k#min": ["gone"] });
    const c = h.render(["alpha", "newcomer", "gamma"]);
    h.api.applyTileOrder(c);
    expect(h.api.tids(c)).toEqual(["gamma", "alpha", "newcomer"]);
    const saved = JSON.parse(h.store["pai.cockpit.tiles.v1"]!);
    expect(saved.k).toEqual(["gamma", "alpha"]);
    expect(saved["k#min"]).toBeUndefined();
  });

  it("a minimized tile renders as a chip in a row after the container, and restores", () => {
    const h = harness();
    const c = h.render(["alpha", "beta", "gamma"]);
    h.api.applyTileOrder(c);
    h.press(h.tile(c, "beta"));
    const b = h.tile(c, "beta");
    expect(b.classes.has("tmin")).toBe(true);
    expect(b.getAttribute("data-tname")).toBe("BETA");
    expect(b.getAttribute("data-tval")).toBe("7 u"); // the chip shows name + one value (CSS ::before / ::after)
    expect(c.children.map((t: any) => t.getAttribute("data-tid"))).toEqual(["alpha", "gamma"]);
    expect(c.__chips.classes.has("tchips")).toBe(true);
    expect(c.nextSibling).toBe(c.__chips);
    expect(JSON.parse(h.store["pai.cockpit.tiles.v1"]!)["k#min"]).toEqual(["beta"]);
    // survives a re-render
    const c2 = h.render(["alpha", "beta", "gamma"]);
    h.api.applyTileOrder(c2);
    expect(h.tile(c2, "beta").classes.has("tmin")).toBe(true);
    expect(c2.__chips.children).toHaveLength(1);
    h.press(h.tile(c2, "beta"));
    expect(h.tile(c2, "beta").classes.has("tmin")).toBe(false);
    expect(c2.__chips).toBeNull();
    expect(c2.children).toHaveLength(3);
  });

  it("the minimize control is a native button with state and label: keyboard Enter/Space toggle it", () => {
    const h = harness();
    const c = h.render(["alpha"]);
    h.api.applyTileOrder(c);
    const b = h.tile(c, "alpha").__tmb;
    expect(b.tag).toBe("button");
    expect(b.type).toBe("button");
    expect(b.getAttribute("aria-pressed")).toBe("false");
    expect(b.getAttribute("aria-label")).toBe("minimize ALPHA");
    h.press(h.tile(c, "alpha")); // a native button turns Enter/Space into this click
    expect(b.getAttribute("aria-pressed")).toBe("true");
    expect(b.getAttribute("aria-label")).toBe("restore ALPHA");
    expect(COCKPIT_HTML).toContain(".tmin>*:not(.tctl):not(.tgrip){display:none}"); // a chip shows only name, value and the controls
  });

  it("Cloud: one tile per provider keyed by the provider name, no hardcoded list", () => {
    const body = COCKPIT_HTML.match(/function renderLimits[\s\S]*?\n\}/)![0];
    const els: Record<string, any> = { cloud: { innerHTML: "" }, local: { innerHTML: "" } };
    const fn = new Function("lim", "$", "esc", "gauge", "ago", "dur", "mdl", "modelsHtml", "document", `${TH}\nfunction keepDowns(){}\nfunction setHtml(e,h){e.innerHTML=h;return true}\nfunction applyTileOrder(){}\nfunction tileGrips(){}function orderTiles(){}\n${body}\nrenderLimits();`);
    const lim = { activeLocal: null, limits: [
      { provider: "prov-a", kind: "cloud", windows: [{ name: "w", percent: 41.2 }] },
      { provider: "prov-b", kind: "cloud", windows: [{ name: "w", percent: 9 }] },
    ] };
    fn(lim, (id: string) => els[id], (s: string) => s, () => "<g>", () => "", () => "", null, () => "", { querySelectorAll: () => [] });
    const h = els.cloud.innerHTML as string;
    expect(h).toContain('data-tkey="cloud"');
    for (const [p, v] of [["prov-a", "41%"], ["prov-b", "9%"]]) {
      expect(h).toContain(`data-tid="${p}" data-tname="${p}" data-tval="${v}"`);
    }
    expect(h).toContain("data-tgrip");
  });

  /** The tiles of the container `key` in a rendered html string, as fresh elements (what setHtml leaves after a poll). */
  const fromHtml = (h: string, key: string) => {
    const sec = el("div"), cont = el("div", { "data-tkey": key });
    sec.appendChild(cont);
    const re = /<div class="[^"]*"[^>]*? data-tid="([^"]*)" data-tname="([^"]*)" data-tval="([^"]*)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(h))) cont.appendChild(el("div", { class: "t", "data-tid": m[1]!, "data-tname": m[2]!, "data-tval": m[3]! }));
    cont.__tkey = key;
    return cont;
  };
  const survives = (h: string, key: string, ids: string[]) => {
    const t = harness();
    const c1 = fromHtml(h, key);
    expect(t.api.tids(c1)).toEqual(ids);
    t.api.applyTileOrder(c1);
    t.store["pai.cockpit.tiles.v1"] = JSON.stringify({ [key]: [...ids].reverse() });
    const c2 = fromHtml(h, key); // the poll rebuild
    t.api.applyTileOrder(c2);
    expect(t.api.tids(c2)).toEqual([...ids].reverse());
    t.press(t.tile(c2, ids[0]!));
    const chip = t.tile(c2, ids[0]!);
    expect(chip.classes.has("tmin")).toBe(true);
    expect(c2.__chips.children).toHaveLength(1);
    expect(chip.getAttribute("data-tname")).toBeTruthy();
    expect(chip.getAttribute("data-tval")).toBeTruthy();
    const c3 = fromHtml(h, key); // minimized state survives the next poll too
    t.api.applyTileOrder(c3);
    expect(t.tile(c3, ids[0]!).classes.has("tmin")).toBe(true);
  };

  it("Local servers: each running server is an orderable, minimizable tile in its own group", () => {
    const body = COCKPIT_HTML.match(/function renderLimits[\s\S]*?\n\}/)![0];
    const lt = ["gbm", "shortModel", "ringName", "localTile"].map((n) => COCKPIT_HTML.match(new RegExp(`function ${n}[\\s\\S]*?\\n\\}`))![0]).join("\n");
    const els: Record<string, any> = { cloud: { innerHTML: "" }, local: { innerHTML: "" } };
    const fn = new Function("lim", "$", "esc", "gauge", "ago", "dur", "mdl", "modelsHtml", "document", `${TH}\n${lt}\nfunction keepDowns(){}\nfunction setHtml(e,h){e.innerHTML=h;return true}\nfunction orderTiles(r){r.__ordered=1}\n${body}\nrenderLimits();`);
    const lim = { activeLocal: null, limits: [
      { provider: "srv-a", kind: "local", up: true, windows: [], served: ["m/one"], rssMb: 2048, tokensPerSec: 31.4 },
      { provider: "srv-b", kind: "local", up: true, windows: [], served: [] },
      { provider: "srv-c", kind: "local", up: false, windows: [] },
    ] };
    fn(lim, (id: string) => els[id], (s: string) => s, () => "<g>", () => "", () => "", null, () => "", { querySelectorAll: () => [] });
    const h = els.local.innerHTML as string;
    expect(h).toContain('<div class="tgroup" data-tkey="local">');
    expect(h).toContain('data-tid="srv-a" data-tname="srv-a" data-tval="31 tok/s"');
    expect(h).toContain('data-tid="srv-b" data-tname="srv-b" data-tval="up"');
    expect(h).toContain("data-tgrip");
    expect(h.indexOf("</div>" + "<details")).toBeGreaterThan(h.indexOf("srv-b")); // the down list sits outside the tile group, never a tile
    expect(els.local.__ordered).toBe(1);
    survives(h, "local", ["srv-a", "srv-b"]);
  });

  it("Cache rings: each ring is an orderable tile keyed by provider and model", () => {
    const rt = COCKPIT_HTML.match(/function ringTiles\([\s\S]*?\n\}\n/)![0];
    const fn = new Function("esc", "donut", "emptyRing", "assignColors", "ringName", "ageMark", "lim", "LOW_REQ", `${TH}\n${rt}\nreturn ringTiles;`)(
      (s: string) => s, () => "<svg/>", () => "<svg/>", () => {}, (m: string) => m, () => "", {}, 5) as (ms: any, s: any[]) => string;
    const ms = { a: { provider: "p1", model: "m1", cacheRead: 30, cacheWrite: 0, input: 70, requests: 9 }, b: { provider: "p2", model: "m2", cacheRead: 5, cacheWrite: 5, input: 0, requests: 8 } };
    const h = fn(ms, []);
    expect(h).toContain('data-tid="p1 / m1" data-tname="m1" data-tval="30%"');
    expect(h).toContain('data-tid="p2 / m2" data-tname="m2" data-tval="50%"');
    expect(h).toContain("data-tgrip");
    const dd = COCKPIT_HTML.match(/function renderDonuts[\s\S]*?\n\}\n/)![0];
    expect(dd).toContain('<div class="tset" data-tkey="rings">');
    expect(dd.indexOf('orderTiles($("donut"))')).toBeGreaterThan(dd.indexOf('setHtml($("donut")'));
    survives(h, "rings", ["p1 / m1", "p2 / m2"]);
  });

  it("Totals: each KPI is an orderable, minimizable tile whose chip value drops the markup", () => {
    const rd = COCKPIT_HTML.match(/function render\(\)\{[\s\S]*?\n\}\n/)![0];
    expect(rd).toContain('<div class="tset" data-tkey="kpis">');
    expect(rd).toContain("tileAttrs(k[0],k[0],k[1].replace(");
    expect(rd.indexOf('orderTiles($("kpis"))')).toBeGreaterThan(rd.indexOf('setHtml($("kpis")'));
    const attrs = new Function("esc", `${TH}\nreturn tileAttrs;`)((x: string) => x) as (a: string, b: string, c: string) => string;
    const kp = ["a", "b", "c"].map((k) => `<div class="kpi"${attrs(k, k, "1")}>`).join("");
    survives(kp, "kpis", ["a", "b", "c"]);
  });

  it("every tile container the page renders is re-ordered by orderTiles after its setHtml", () => {
    for (const k of ["sys", "syssrv", "cloud", "local", "rings", "kpis"]) expect(COCKPIT_HTML).toContain(`data-tkey="${k}"`);
    for (const sel of ['orderTiles($("sys"))', 'orderTiles($("sysservers"))', 'orderTiles($("cloud"))', 'orderTiles($("local"))', 'orderTiles($("donut"))', 'orderTiles($("kpis"))', "orderTiles(el)"]) expect(COCKPIT_HTML).toContain(sel);
  });
});
