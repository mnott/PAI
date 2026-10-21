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

const src = [
  COCKPIT_HTML.match(/var LKEY="[^\n]*\n/)![0].replace(/^var /, "var "),
  COCKPIT_HTML.match(/function tileOrder\(\)[^\n]*\n/)![0],
  COCKPIT_HTML.match(/function saveTileOrder\([^\n]*\n/)![0],
  COCKPIT_HTML.match(/function tids\([\s\S]*?\n\}\n/)![0],
  COCKPIT_HTML.match(/function tkeyOf\([^\n]*\n/)![0],
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
    const fn = new Function("lim", "$", "esc", "gauge", "ago", "dur", "mdl", "modelsHtml", "document", `function keepDowns(){}\nfunction setHtml(e,h){e.innerHTML=h;return true}\nfunction applyTileOrder(){}\nfunction tileGrips(){}\n${body}\nrenderLimits();`);
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
});
