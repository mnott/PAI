import { describe, expect, it } from "vitest";
import { COCKPIT_HTML } from "./cockpit-page.js";
import { WIN_CACHE_JS } from "./cockpit-page/win/cards-cache.js";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const body = COCKPIT_HTML.match(/function speedBars[\s\S]*?\n\}/)![0];
const lim = { routing: { choices: [{ entry: "local" }, { entry: "glm" }, { entry: "anthropic" }] } };
const cmp = WIN_CACHE_JS.match(/function providerModelCmp[\s\S]*?\n\}/)![0];
const speedBars = new Function("esc", "lim", "LOW_REQ", `${cmp}\n${body}\nreturn speedBars;`)(esc, lim, 5) as (sp: unknown[], w: string, loc: Record<string, number>) => string;

const st = (requests: number, ttftP50: number | null, ttftP90: number | null, readTps: number | null, writeTps: number | null) => ({ requests, ttftP50, ttftP90, readTps, writeTps });
const SP = [
  { provider: "anthropic", model: "opus", h1: st(5, 1000, 7200, 400, 50), h24: st(50, 2000, 4000, 800, 40) },
  { provider: "glm", model: "local-m", h1: st(9, 500, 600, 200, 100), h24: st(90, null, null, null, null) },
];
const widths = (html: string) => [...html.matchAll(/<i style="width:([\d.]+)%/g)].map((m) => Number(m[1]));

describe("speed per model bars", () => {
  it("scales each column to its own maximum across models", () => {
    const html = speedBars(SP, "1h", {});
    expect(html).toContain("width:13.9%");
    expect(html).toContain("width:6.9%");
    expect(html).toContain("width:100.0%");
    expect(html).toContain("width:50.0%");
    expect(html).toContain("1.0 s (p90 7.2 s)");
  });

  it("a null value is an empty bar with a dash, never 0", () => {
    const html = speedBars(SP, "24h", {});
    expect(html).toContain("–");
    expect(html).not.toMatch(/\b0\.0 tok\/s/);
    expect(widths(html).length).toBe(3); // only opus has values in h24
  });

  it("window switch picks h1 for 1h and h24 otherwise, and marks LOCAL/CLOUD", () => {
    expect(speedBars(SP, "1h", { glm: 1 })).toContain("last hour");
    expect(speedBars(SP, "1h", { glm: 1 })).toContain("1.0 s");
    for (const w of ["24h", "7d"]) {
      const html = speedBars(SP, w, { glm: 1 });
      expect(html).toContain("last 24 h");
      expect(html).toContain("2.0 s (p90 4.0 s)");
      expect(html).not.toContain("1.0 s (p90");
    }
    const html = speedBars(SP, "1h", { glm: 1 });
    expect(html).toContain(">LOCAL<");
    expect(html).toContain(">CLOUD<");
  });

  it("rows come out in provider order (routing, then alphabetical), requests descending within a provider, the same comparator as the rings", () => {
    const m = (provider: string, model: string, n: number) => ({ provider, model, h1: st(n, 1, 1, 1, 1), h24: st(n, 1, 1, 1, 1) });
    const sp = [m("anthropic", "a1", 50), m("zed", "z", 99), m("glm", "g1", 10), m("glm", "g2", 30), m("local", "l1", 6), m("anthropic", "a2", 90)];
    const names = (html: string) => [...html.matchAll(/class="sp-n[^"]*" title="([^"]+?) \/ ([^"]+?) ·/g)].map((x) => x[1] + "/" + x[2]);
    const want = ["local/l1", "glm/g2", "glm/g1", "anthropic/a2", "anthropic/a1", "zed/z"];
    expect(names(speedBars(sp, "1h", {}))).toEqual(want);
    const ring = new Function("lim", "LOW_REQ", `${cmp}\nreturn providerModelCmp;`)(lim, 5) as (a: unknown, b: unknown) => number;
    expect(sp.map((x) => ({ provider: x.provider, model: x.model, requests: x.h1.requests })).sort(ring).map((x) => x.provider + "/" + x.model)).toEqual(want);
  });
});
