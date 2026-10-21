import { describe, expect, it } from "vitest";
import { COCKPIT_HTML } from "./cockpit-page.js";

const SH = "function setHtml(el,h){el.innerHTML=h;return true}";
const GB = 1073741824;

describe("System section: metric tiles with history", () => {
  const one = (n: string) => COCKPIT_HTML.match(new RegExp(`function ${n}\\([^\\n]*\\n`))![0];
  const many = (n: string) => COCKPIT_HTML.match(new RegExp(`function ${n}\\([\\s\\S]*?\\n\\}\\n`))![0];
  const src = [one("esc"), one("gb"), one("gbm"), many("metricSpark"), many("metricTile"), one("staleAge"), one("ringPush"), many("renderSystem")].join("\n");
  /** Runs the real renderSystem once per payload (a poll each); returns the last #sys / #sysservers html and the history rings. */
  const polls = (payloads: any[]) => {
    const els: Record<string, { innerHTML: string }> = { sys: { innerHTML: "" }, syshid: { innerHTML: "" }, sysservers: { innerHTML: "" } };
    const fn = new Function("payloads", "$", "fmt", `${SH}\nvar LAST={},SYSH={},SYS_HIST_LEN=3,win="1h",data={},lim=null,sys=null;function renderDonuts(){}function applyTileOrder(){}function tileGrips(){}var document={querySelectorAll:function(){return[]}};\n${src}\npayloads.forEach(function(p){sys=p;renderSystem()});return SYSH;`);
    const hist = fn(payloads, (id: string) => els[id], (n: number) => String(n));
    return { sys: els.sys!.innerHTML, srv: els.sysservers!.innerHTML, hist };
  };
  const poll = (i: number) => ({
    current: { memUsed: (8 + i) * GB, memTotal: 36 * GB, swapUsed: i * GB, swapTotal: 4 * GB, wired: (3 + i) * GB, compressed: (1 + i) * GB, cpu: 10 + i, gpu: 20 + i, ane: 1 + i, socTemp: 50 + i, cpuW: 5 + i, gpuW: 6 + i, aneW: 0.5 + i, systemW: 20 + i, totalW: 30 + i },
    series: { series: [], wh: { "1h": 4 + i }, coveredMin: { "1h": 60 } },
    servers: [{ provider: "gyro-m", up: true, rssMb: 40000 + i * 100, tokensPerSec: 50 + i, prefixCache: { hitRate: 0.5, hits: 5, misses: 5 } }],
  });

  it("every System metric and local-server value renders as a metric tile with a sparkline drawn from the polls", () => {
    const r = polls([poll(0), poll(1), poll(2), poll(3)]);
    const tiles = r.sys.split('<div class="mt" ').slice(1).concat(r.srv.split('<div class="mt" ').slice(1));
    expect(tiles).toHaveLength(14 + 4);
    for (const t of tiles.slice(0, 14).concat(tiles.slice(14).filter((x) => !x.includes("decode")))) {
      expect(t).toContain('class="mt-value"');
      expect(t).toContain('<svg class="mt-spark"');
      expect(t).toMatch(/<path class="line [^"]*" [^>]* d="M[0-9.]+,[0-9.]+L/); // a real line: >= 2 points
    }
    expect(r.hist["srv:gyro-m:RSS"]).toHaveLength(3); // ring capped at sysHistoryLen
    expect(r.sys).not.toContain('class="kpi"');
  });

  it("a server series is the sparkline source when the window has one", () => {
    const p: any = poll(0);
    p.series.series = [{ t: 1, n: 1, cpu: 10 }, { t: 2, n: 1, cpu: 40 }, { t: 3, n: 1, cpu: 20 }];
    const r = polls([p]);
    expect(r.hist.cpu).toBeUndefined();
    expect(r.sys).toMatch(/data-tid="cpu-load"[\s\S]*?<path class="line [^"]*" [^>]* d="M[0-9.]+,[0-9.]+L/);
  });

  it("the tile grid is 4 wide, 2 wide, or 1 column - never 3 plus 1", () => {
    const css = COCKPIT_HTML.match(/<style>[\s\S]*?<\/style>/g)!.join("");
    const cols = [...css.matchAll(/\.rt-tiles[^{]*\{grid-template-columns:([^;}]*)/g)].map((m) => m[1]!);
    expect(cols.length).toBeGreaterThan(0);
    for (const c of cols) expect(c).toMatch(/^(repeat\((2|4),minmax\(0,1fr\)\)|minmax\(0,1fr\))$/);
    // the System grids are .rt-tiles inside a size container, like the Models cards
    expect(COCKPIT_HTML).toContain('<div id="sys" style="container-type:inline-size">');
    expect(COCKPIT_HTML).toContain('<div id="sysservers" style="margin-top:8px;container-type:inline-size">');
    expect(polls([poll(0)]).sys.startsWith('<div class="rt-tiles" data-tkey="sys">')).toBe(true);
  });
});
