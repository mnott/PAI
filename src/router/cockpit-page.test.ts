import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COCKPIT_FAVICON_SVG, COCKPIT_HTML, cockpitHtml } from "./cockpit-page.js";
import { POOL_PANEL_JS } from "./pool-panel.js";

const stripTags = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "");

describe("cockpit page compression", () => {
  it("no static text node outside tooltips is longer than 120 characters, and no <p> prose remains", () => {
    const html = stripTags(COCKPIT_HTML);
    const texts = html.split(/<[^>]*>/).map((t) => t.trim()).filter(Boolean);
    expect(texts.filter((t) => t.length > 120)).toEqual([]);
    expect(html).not.toContain("<p ");
    const script = COCKPIT_HTML.match(/<script>[\s\S]*?<\/script>/)![0];
    expect(script).not.toContain("<p ");
  });

});

describe("cockpit favicon and dark mode", () => {
  it("inline SVG favicon: a data URI right after the title, decoding to the 64x64 fan-out icon", () => {
    const link = COCKPIT_HTML.match(/<link rel="icon" type="image\/svg\+xml" href="(data:image\/svg\+xml,[^"]+)">/)![1];
    const svg = decodeURIComponent(link.slice("data:image/svg+xml,".length));
    expect(svg).toMatch(/^<svg[^>]*viewBox="0 0 64 64"/);
    expect(svg).toContain('rx="14"');
    expect(svg).toContain('fill="#3b6fe0"');
    expect(svg).toContain('stroke="#fff"');
    expect(svg).toContain('stroke-width="5"');
    expect(svg).toContain("stroke-linecap=\"round\"");
    expect(svg.match(/<circle/g)!.length).toBe(3);
    expect(svg).toBe(COCKPIT_FAVICON_SVG);
    // no raw characters that would break the URI in Safari/Chrome/Firefox
    for (const ch of ['"', "<", ">", "#", " ", "'"]) expect(link).not.toContain(ch);
    expect(COCKPIT_HTML).toMatch(/<title>PAI Cockpit<\/title>\n<link rel="icon"/);
    expect(COCKPIT_HTML).toContain('<meta name="theme-color" content="#3b6fe0">');
  });

  it("the head script picks the theme before first paint: saved choice, else the system's", () => {
    const head = COCKPIT_HTML.slice(0, COCKPIT_HTML.indexOf("</head>"));
    const script = head.match(/<script>[\s\S]*?<\/script>/)![0];
    expect(script).toContain('localStorage.getItem("pai.cockpit.theme")');
    expect(script).toContain('matchMedia("(prefers-color-scheme: dark)")');
    expect(script).toContain("document.documentElement.dataset.theme");
    // before the stylesheet: the theme is set before the first paint
    expect(head.indexOf("<script>")).toBeLessThan(head.indexOf("<style>"));
  });

  it("a round icon button in the header flips the theme; only a click is saved", () => {
    expect(COCKPIT_HTML).toContain('<button id="theme" type="button" title="Dark mode" aria-label="Dark mode">');
    const header = COCKPIT_HTML.match(/<header>[\s\S]*?<\/header>/)![0];
    expect(header).toContain('id="theme"');
    expect(header.indexOf('id="theme"')).toBeGreaterThan(header.indexOf('id="stamp"'));
    expect(header).toContain('viewBox="0 0 24 24"');
    expect(header).toContain('stroke="currentColor"');
    expect(header).toContain('width="16"');
    expect(header).toContain('class="ic-moon"');
    expect(header).toContain('class="ic-sun"');
    const js = COCKPIT_HTML.match(/\$\("theme"\)\.onclick=[\s\S]*?\}\);/)![0];
    expect(js).toContain('localStorage.setItem("pai.cockpit.theme"');
    expect(js).toContain('document.documentElement.dataset.theme==="dark"?"light":"dark"');
    // while nothing is saved, system changes are followed live
    expect(COCKPIT_HTML).toContain('matchMedia("(prefers-color-scheme: dark)").addEventListener("change"');
    expect(COCKPIT_HTML).toMatch(/if\(!s\)setTheme\(e\.matches\?"dark":"light"\)/);
    // the button's title/aria-label name the mode it switches to
    expect(COCKPIT_HTML).toContain('l=t==="dark"?"Light mode":"Dark mode";b.title=l;b.setAttribute("aria-label",l)');
  });

  it("the dark palette lives under [data-theme=dark], not a media query", () => {
    expect(COCKPIT_HTML).toContain(":root[data-theme=dark]{--bg:#10131a;--card:#181c26;--fg:#e4e8f1;--dim:#8b93a7;--line:#2a3040;--ok:#46c47a;--warn:#e8a43a;--bad:#ef6b6b;--acc:#6b95f5}");
    expect(COCKPIT_HTML).not.toMatch(/@media\(prefers-color-scheme:dark\)/);
    // the icon shows the mode a click switches TO: light shows the moon, dark shows the sun
    expect(COCKPIT_HTML).toContain(":root[data-theme=dark] .ic-moon{display:none}");
    expect(COCKPIT_HTML).toContain(":root:not([data-theme=dark]) .ic-sun{display:none}");
    // title and label follow the theme on load, not only on click
    expect(COCKPIT_HTML).toContain('setTheme(document.documentElement.dataset.theme==="dark"?"dark":"light");');
  });
});

describe("cockpit kept prefix-cache reading", () => {
  const ageMark = new Function(`var SRV_STALE_SEC=60;\n${COCKPIT_HTML.match(/function ageMark[\s\S]*?\n\}/)![0]}; return ageMark;`)() as (s: unknown) => string;

  it("shows no marker for a fresh reading, a small '(Ns old)' beyond one poll interval", () => {
    expect(ageMark({ prefixCache: {} })).toBe("");
    expect(ageMark({ prefixCacheAgeSec: 45 })).toBe("");
    expect(ageMark({ prefixCacheAgeSec: 90 })).toContain("(90s old)");
    expect(ageMark({ prefixCacheAgeSec: 300 })).toContain("(5 min old)");
  });

  it("the ring caption, providers table and local detail all carry the marker", () => {
    expect(COCKPIT_HTML).toContain("server prefix cache'+ageMark(srv)");
    expect(COCKPIT_HTML).toContain("'*</span>'+ageMark(srv)");
    expect(COCKPIT_HTML).toContain("ageMark(s))");
  });
});

describe("cockpit page scripts", () => {
  it("every inline <script> body compiles", () => {
    const bodies = [...COCKPIT_HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) expect(() => new Function(body)).not.toThrow();
  });
});

describe("cockpit layout values from config (router.cockpit.layout)", () => {
  // a temp user config only — never the live files; PAI_CONFIG_FILE points at it
  let dir = "";
  const prevConfigFile = process.env.PAI_CONFIG_FILE;
  const prevHome = process.env.PAI_HOME;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pai-cockpit-layout-"));
    process.env.PAI_CONFIG_FILE = join(dir, "config.json");
    delete process.env.PAI_HOME;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prevConfigFile === undefined) delete process.env.PAI_CONFIG_FILE;
    else process.env.PAI_CONFIG_FILE = prevConfigFile;
    if (prevHome === undefined) delete process.env.PAI_HOME;
    else process.env.PAI_HOME = prevHome;
  });
  const write = (layout: Record<string, unknown>) => {
    writeFileSync(join(dir, "config.yaml"), `router:\n  cockpit:\n    layout:\n${Object.entries(layout).map(([k, v]) => `      ${k}: ${v}`).join("\n")}\n`);
  };

  it("gaugeMinWidthPx and gaugeMaxWidthPx move the gauge tile widths", () => {
    write({ gaugeMinWidthPx: 150, gaugeMaxWidthPx: 160 });
    expect(cockpitHtml()).toMatch(/\.gauge\{[^}]*flex:1 1 150px[^}]*max-width:min\(160px,100%\)/);
  });

  it("ringMinWidthPx moves the cache rings grid", () => {
    write({ ringMinWidthPx: 120 });
    expect(cockpitHtml()).toContain(".rings{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr))");
  });

  it("sessionTitleMaxWidthPx moves the sessions title column cap", () => {
    write({ sessionTitleMaxWidthPx: 600 });
    expect(cockpitHtml()).toContain("#sessions td:first-child span[title]{display:inline-block;max-width:min(600px,100%)");
  });

  it("sparkPlotHeightPx and sparkPlotTopPx move the sparkline plot geometry", () => {
    write({ sparkPlotHeightPx: 24, sparkPlotTopPx: 26 });
    expect(cockpitHtml()).toContain("26-valAt(i)/max*24");
  });

  it("donutSizePx moves the ring donut default size", () => {
    write({ donutSizePx: 96 });
    expect(cockpitHtml()).toContain("sz=sz||96");
  });

  it("donutRadiusPx moves the donut radius", () => {
    write({ donutRadiusPx: 40 });
    expect(cockpitHtml()).toContain("var r=40,c=2*Math.PI*r");
  });

  it("donutStrokePx moves the donut stroke width", () => {
    write({ donutStrokePx: 12 });
    expect(cockpitHtml()).toContain('stroke-width="12"');
  });

  it("donutViewBoxPx moves the donut viewBox and centre", () => {
    write({ donutViewBoxPx: 160 });
    expect(cockpitHtml()).toContain("viewBox=\"0 0 '+160+' '+160+'\"");
    expect(cockpitHtml()).toContain("var cx=160/2");
  });

  it("sessionsRows moves the sessions table row limit", () => {
    write({ sessionsRows: 30 });
    expect(cockpitHtml()).toContain("SESSION_ROWS=30");
    expect(cockpitHtml()).toContain("d.bySession.slice(0,SESSION_ROWS)");
  });

  it("workerRows moves the worker runs table row limit", () => {
    write({ workerRows: 25 });
    expect(cockpitHtml()).toContain("WORKER_ROWS=25");
    expect(cockpitHtml()).toContain("d.workers.slice(0,WORKER_ROWS)");
  });

  it("lowRequestMin moves the low-request chip threshold", () => {
    write({ lowRequestMin: 8 });
    expect(cockpitHtml()).toContain("LOW_REQ=8");
  });

  it("pollMs moves the data/system/models/queue refresh interval", () => {
    write({ pollMs: 7000 });
    expect(cockpitHtml()).toContain("setInterval(function(){load();loadSystem()},7000)");
    expect(cockpitHtml()).toContain("setInterval(loadModels,7000)");
  });

  it("limitsPollMs moves the limits refresh interval", () => {
    write({ limitsPollMs: 45000 });
    expect(cockpitHtml()).toContain("setInterval(loadLimits,45000)");
  });

  it("poolPollMs moves the pool refresh interval", () => {
    write({ poolPollMs: 20000 });
    expect(cockpitHtml()).toContain("setInterval(loadPool,20000)");
  });

  it("clockTickMs moves the stamp tick interval", () => {
    write({ clockTickMs: 2000 });
    expect(cockpitHtml()).toContain("setInterval(tick,2000)");
  });

  it("stampStaleSecs moves the stale-stamp threshold", () => {
    write({ stampStaleSecs: 30 });
    expect(cockpitHtml()).toContain("STALE_SEC=30");
    expect(cockpitHtml()).toContain("age>=STALE_SEC");
  });

  it("holdLastGoodSecs moves the hold time of the last good payload", () => {
    write({ holdLastGoodSecs: 45 });
    expect(cockpitHtml()).toContain("HOLD_SEC=45");
  });

  it("serverCounterStaleSecs moves the prefix-cache age mark threshold", () => {
    write({ serverCounterStaleSecs: 90 });
    expect(cockpitHtml()).toContain("SRV_STALE_SEC=90");
    expect(cockpitHtml()).toContain("s.prefixCacheAgeSec>SRV_STALE_SEC");
  });

  // colour thresholds (router.cockpit.layout): the rendered colour class follows a
  // temp-config override of each threshold; the shipped values stand in COCKPIT_HTML
  const thresholdHtml = (layout: Record<string, unknown>) => {
    // always write: an empty yaml file parses to null and blanks the whole layout,
    // so the shipped check writes a key that cannot change the thresholds
    write(Object.keys(layout).length ? layout : { pollMs: 5000 });
    const html = cockpitHtml();
    // the cls/hitCls sources come from COCKPIT_HTML (the shipped page): the
    // threshold NUMBERS are the ones baked into THIS html, injected below.
    // one-line sources: a [\s\S]*? match would run past the helper to the next
    // closing brace at line start and eval unrelated code
    const clsSrc = COCKPIT_HTML.match(/function cls\([^\n]*\n/)![0];
    const hitSrc = COCKPIT_HTML.match(/function hitCls\([^\n]*\n/)![0];
    // the thresholds are the page's own var declarations, taken verbatim from THIS
    // html and eval'd: no re-spelling, so the harness cannot drift from the page
    const varLine = html.match(/var HIT_WARN=[^\n]*/)![0];
    const api = new Function(
      `${varLine}\n${clsSrc}\n${hitSrc}\nreturn {cls:function(v){return cls(v,ERROR_WARN,ERROR_BAD)},hitCls:hitCls};`
    ) as () => { cls: (v: number) => string; hitCls: (r: number) => string };
    return api();
  };
  // the same harness for the gauge thresholds, which the page bakes into sev() itself
  const gaugeHtml = (layout: Record<string, unknown>) => {
    write(Object.keys(layout).length ? layout : { pollMs: 5000 });
    const html = cockpitHtml();
    const sevSrc = html.match(/function sev\([\s\S]*?\n\}\n/)![0];
    return new Function(`${sevSrc}\nreturn sev;`)() as (p: number) => string;
  };

  it("hitWarn/hitBad move the hit-ratio colouring (sessions table, rings, pause table)", () => {
    const t = thresholdHtml({ hitWarn: 0.6, hitBad: 0.3 });
    expect(t.hitCls(0.5)).toBe("warn"); // 0.5 is warn now, ok at the shipped 0.8
    expect(t.hitCls(0.25)).toBe("bad"); // 0.25 is bad now, warn at the shipped 0.5
    expect(t.hitCls(0.7)).toBe("ok"); // ok at 0.7 (>= the override's 0.6), warn at the shipped 0.8
    // the page wires the same helpers into the rendered tables
    expect(cockpitHtml()).toContain('hitCls(s.hitRatio)');
    expect(cockpitHtml()).toContain('hitCls(hr)');
    expect(cockpitHtml()).toContain('hitCls(ratio)');
    // the shipped defaults stand
    expect(COCKPIT_HTML).toContain("HIT_WARN=0.8,HIT_BAD=0.5");
    const shipped = thresholdHtml({});
    expect(shipped.hitCls(0.9)).toBe("ok");
    expect(shipped.hitCls(0.4)).toBe("bad"); // bad at the shipped .5, warn only under the override's .3
    expect(shipped.hitCls(0.2)).toBe("bad");
  });

  it("gaugeWarnPct/gaugeBadPct move the limits-gauge arc colour", () => {
    const sev = gaugeHtml({ gaugeWarnPct: 50, gaugeBadPct: 80 });
    expect(sev(60)).toBe("var(--warn)"); // warn at 60 now, ok at the shipped 70
    expect(sev(85)).toBe("var(--bad)"); // bad at 85 now, warn at the shipped 90
    expect(sev(40)).toBe("var(--ok)");
    expect(COCKPIT_HTML).toContain("p>=90");
    expect(COCKPIT_HTML).toContain("p>=70");
    const shipped = gaugeHtml({});
    expect(shipped(75)).toBe("var(--warn)");
    expect(shipped(95)).toBe("var(--bad)");
  });
});

describe("cockpit model colours, axes and legends (issue APPS/PAI#8 items 3–5)", () => {
  const PAL = (COCKPIT_HTML.match(/var KINDS=[\s\S]*?PAL=\[([^\]]+)\]/)![1]).split(",").map((s) => s.replace(/"/g, ""));
  const colorSrc = [
    COCKPIT_HTML.match(/var colors=[\s\S]*?function saveColors[^\n]*\n/)![0],
    COCKPIT_HTML.match(/function assignColors\([\s\S]*?\n\}\n/)![0],
    COCKPIT_HTML.match(/function hslHex\([\s\S]*?\n\}\n/)![0],
    COCKPIT_HTML.match(/function genColor\([\s\S]*?\n\}\n/)![0],
    COCKPIT_HTML.match(/function hueOf\([\s\S]*?\n\}\n/)![0],
    COCKPIT_HTML.match(/function colorOf\([\s\S]*?\n\}\n/)![0],
  ].join("\n");
  const store: Record<string, string> = {};
  const ls = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } };
  const colorApi = (pruneDays = 90) => {
    const fn = new Function("localStorage", "PAL", "COLOR_PRUNE_DAYS", `var KINDS=[["input","fresh input","#3b6fe0"],["cacheWrite","cache write","#e0703b"],["cacheRead","cache read","#2e9e5b"],["output","output","#b04fd0"]];\n${colorSrc}\nreturn {assign:function(ms){return assignColors(ms)},colorOf:colorOf,colors:colors};`);
    return fn(ls, PAL, pruneDays) as { assign: (ms: string[]) => void; colorOf: (k: string) => string; colors: Record<string, string> };
  };
  beforeEach(() => { for (const k of Object.keys(store)) delete store[k]; });

  it("the palette is config-driven, at least 16 colours, and the first four are the kind colours", () => {
    expect(PAL.length).toBeGreaterThanOrEqual(16);
    expect(new Set(PAL).size).toBe(PAL.length);
    for (const c of PAL) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    for (const k of COCKPIT_HTML.match(/var KINDS=\[[^\]]+\]/)![0].match(/#[0-9a-f]{6}/g)!) expect(PAL).toContain(k);
  });

  it("12 visible models get 12 distinct palette colours; a re-render in a different order keeps them", () => {
    const a = colorApi();
    const models = Array.from({ length: 12 }, (_, i) => `m${i}`);
    a.assign(models);
    const first = models.map((m) => a.colorOf(m));
    expect(new Set(first).size).toBe(12);
    for (const c of first) expect(PAL).toContain(c);
    // the same models in a different order: same colours (kept from storage, sorted-name assignment)
    const b = colorApi();
    b.assign(models.slice().reverse());
    expect(models.map((m) => b.colorOf(m))).toEqual(first);
    // a fresh browser (empty storage) assigns in sorted-name order, independent of data order
    for (const k of Object.keys(store)) delete store[k];
    const c = colorApi();
    c.assign(models.slice().reverse());
    expect(models.map((m) => c.colorOf(m))).toEqual(first);
  });

  it("colours persist per model name; a model not visible right now keeps its saved colour", () => {
    const a = colorApi();
    a.assign(["x", "y"]);
    const saved = JSON.parse(store["pai.cockpit.modelColors.v1"]);
    expect(saved.x).toMatch(/^#[0-9a-f]{6}$/);
    expect(saved.y).toMatch(/^#[0-9a-f]{6}$/);
    const b = colorApi();
    b.assign(["x"]);
    expect(b.colors.y).toBe(saved.y); // not deleted: merely not visible right now
    // it reappears with the same colour
    b.assign(["x", "y"]);
    expect(b.colorOf("y")).toBe(saved.y);
  });

  it("two charts with different model sets keep all colours distinct and stable across re-renders in either order", () => {
    const winModels = ["claude-haiku-4-5", "claude-sonnet-5-5", "k3"];
    const dailyModels = ["claude-haiku-4-5", "glm-5.3", "qwen3-coder-30b-8bit", "k3"];
    const union = Array.from(new Set(winModels.concat(dailyModels))).sort();
    // daily first, then the window chart (the live order that wiped the daily colours)
    const a = colorApi();
    a.assign(dailyModels);
    a.assign(winModels);
    const first = union.map((m) => a.colorOf(m));
    expect(new Set(first).size).toBe(union.length);
    // window first, then daily, in a fresh session over the same storage
    const b = colorApi();
    b.assign(winModels);
    b.assign(dailyModels);
    expect(union.map((m) => b.colorOf(m))).toEqual(first);
    // re-render either chart again: nothing changes
    b.assign(dailyModels);
    b.assign(winModels);
    expect(union.map((m) => b.colorOf(m))).toEqual(first);
  });

  it("20 models get 20 distinct colours, past the palette by generated hues", () => {
    const a = colorApi();
    const models = Array.from({ length: 20 }, (_, i) => `mm${i}`);
    a.assign(models);
    const cs = models.map((m) => a.colorOf(m));
    expect(new Set(cs).size).toBe(20);
    for (const c of cs) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    // a re-render keeps them
    const b = colorApi();
    b.assign(models);
    expect(models.map((m) => b.colorOf(m))).toEqual(cs);
  });

  it("colorOf assigns an unassigned model on the spot and never returns PAL[0] silently", () => {
    const a = colorApi();
    a.assign(["p"]); // p takes PAL[0]
    expect(a.colorOf("p")).toBe(PAL[0]);
    const c = a.colorOf("late-model");
    expect(c).not.toBe(PAL[0]);
    expect(c).toMatch(/^#[0-9a-f]{6}$/);
    expect(a.colors["late-model"]).toBe(c);
    expect(JSON.parse(store["pai.cockpit.modelColors.v1"])["late-model"]).toBe(c);
    // the kind colours still resolve by kind name
    expect(a.colorOf("input")).toBe("#3b6fe0");
  });

  it("saved colours older than colorPruneDays are pruned by their @ts stamp", () => {
    const DAY = 864e5;
    const old = JSON.stringify({ gone: "#2bb3c0", "gone@ts": Date.now() - 100 * DAY, keep: "#d64570", "keep@ts": Date.now() - 10 * DAY });
    store["pai.cockpit.modelColors.v1"] = old;
    const a = colorApi(90);
    a.assign(["fresh"]);
    expect(a.colors.gone).toBeUndefined();
    expect(a.colors.keep).toBe("#d64570");
    // the prune window is config-driven
    store["pai.cockpit.modelColors.v1"] = old;
    const b = colorApi(200);
    b.assign(["fresh"]);
    expect(b.colors.gone).toBe("#2bb3c0");
  });

  it("axis labels are compact (784M, 1.57G, not 783.98M) and the left padding grows with the widest label", () => {
    const fmtAxis = new Function(`${COCKPIT_HTML.match(/function fmtAxis\([^\n]*\n/)![0]}; return fmtAxis;`)() as (n: number) => string;
    expect(fmtAxis(783_980_000)).toBe("784M");
    expect(fmtAxis(1_570_000_000)).toBe("1.57G");
    expect(fmtAxis(12_300_000_000)).toBe("12G");
    expect(fmtAxis(12_300)).toBe("12k");
    expect(fmtAxis(1_230)).toBe("1.2k");
    expect(fmtAxis(42)).toBe("42");
    const padFor = new Function(`${COCKPIT_HTML.match(/function padFor\([^\n]*\n/)![0]}; return padFor;`)() as (l: string[]) => number;
    expect(padFor(["42"])).toBe(30);
    expect(padFor(["784M"])).toBeGreaterThan(padFor(["42"]));
    expect(padFor(["1.57G"])).toBeGreaterThan(padFor(["784M"]));
    // the bar charts size their left padding from the formatted max label
    const bars = COCKPIT_HTML.match(/function stackedBarsSvg\([\s\S]*?\n\}\n/)![0];
    expect(bars).toContain("padL=padFor([fmtAxis(max)])");
    expect(bars).toContain("fmtAxis(max*g/3)");
    expect(COCKPIT_HTML.match(/function twoToneSvg\([\s\S]*?\n\}\n/)![0]).toContain("padL=padFor([fmtAxis(max)])");
  });

});

describe("cockpit readability pass (issue APPS/PAI#8)", () => {
  const table = COCKPIT_HTML.match(/function table\([\s\S]*?\n\}\n/)![0];
  const vcls = new Function(`${COCKPIT_HTML.match(/function vcls\([\s\S]*?\n\}\n/)![0]}; return vcls;`)() as (v: unknown) => string;

  it("table(): a .tw box with a thead, every cell carries its column label for the stacked-card view", () => {
    const t = new Function("esc", `${table}; return table;`)((s: unknown) => String(s ?? "")) as (h: string[], r: string[][]) => string;
    const html = t(["session", "req"], [["alpha", "3"]]);
    expect(html).toContain('<div class="tw">');
    expect(html).toContain("<thead>");
    expect(html).toContain("<tbody>");
    expect(html).toContain('<td data-l="session">alpha</td>');
    expect(html).toContain('<td data-l="req">3</td>');
    // the box never scrolls sideways: no overflow-x rule, no sticky column, cells wrap
    expect(COCKPIT_HTML).toMatch(/\.tw\{max-width:100%\}/); // the box stacks via .stacked, set by fitTables from a measurement
    expect(COCKPIT_HTML).not.toMatch(/\.tw\{overflow-x:auto\}/);
    expect(COCKPIT_HTML).not.toContain("scrollbar-color:var(--dim) var(--card)");
    expect(COCKPIT_HTML).not.toMatch(/\.tw table th:first-child,\.tw table td:first-child\{position:sticky/);
    // headers and numbers never break mid-word: nowrap, no overflow-wrap; the text
    // columns (.txt) absorb the squeeze with anywhere-wrap
    expect(COCKPIT_HTML).toMatch(/th,td\{[^}]*white-space:nowrap[^}]*\}/);
    expect(COCKPIT_HTML).not.toMatch(/th,td\{[^}]*overflow-wrap/);
    expect(COCKPIT_HTML).toMatch(/td\.txt\{[^}]*overflow-wrap:anywhere[^}]*\}/);
    expect(COCKPIT_HTML).not.toMatch(/(^|\n)[^{}]*th[^{}]*\{[^}]*overflow-wrap:anywhere/);
    expect(COCKPIT_HTML).not.toContain("table.dense");
    // below the phone breakpoint a row is a stacked card: label: value pairs, no columns.
    // parse the media block and check declarations, so selector grouping and property
    // order don't matter — the behaviour is what counts, not the spelling.
    // the header block and the table block share this breakpoint in separate media rules;
    // take the one containing the .tw rules
    const decl = (sel: string) => [...COCKPIT_HTML.matchAll(/(?:^|\n|\})([^{}\n]+)\{([^}]*)\}/g)].filter((m) => m[1].split(",").some((x) => x.trim() === `.tw.stacked ${sel}`)).map((m) => m[2]);
    expect(decl("tbody").some((m) => /display:\s*block/.test(m))).toBe(true);
    expect(decl("thead").some((m) => /display:\s*none/.test(m))).toBe(true);
    expect(COCKPIT_HTML).toMatch(/\.tw\.stacked td::before\{content:attr\(data-l\)/);
    // a stacked row is a compact grid: the name is a full-width title, the other fields flow as label/value pairs
    expect(decl("tr").some((m) => /display:\s*grid/.test(m) && /repeat\(auto-fill,minmax\(120px,1fr\)\)/.test(m))).toBe(true);
    expect(decl("td:first-child").some((m) => /grid-column:\s*1\/-1/.test(m))).toBe(true);
  });

  /** table() with the page's esc: the helper (one line per statement) cut from the page source. */
  const tableFull = (esc: (s: unknown) => string) =>
    new Function("esc", `${COCKPIT_HTML.match(/function table\(head,rows,tips(?:,tdStyle)?\)\{[\s\S]*?\n\}\n/)![0]}; return table;`)(esc) as
      (h: string[], r: string[][], tips?: Record<string, string>) => string;

  it("table(): a column empty in every row is not rendered — no header, no cells, no stacked label", () => {
    const t = tableFull((s: unknown) => String(s ?? ""));
    const html = t(["worker", "pos", "move"], [["w1", '<span class="dim">-</span>', '<span class="dim">-</span>'], ["w2", "-", "  "]]);
    expect(html).not.toContain("pos");
    expect(html).not.toContain("move");
    expect(html).not.toContain('data-l="pos"');
    expect(html).not.toContain('data-l="move"');
    expect(html).toContain('<th>worker</th>');
    expect(html).toContain('<td data-l="worker">w1</td>');
    // a column with one value anywhere stays, and the tooltip rides on the kept header
    const kept = t(["worker", "now"], [["w1", '<span class="dim">-</span>'], ["w2", "editing"]], { now: "current activity" });
    expect(kept).toContain('<th title="current activity">now</th>');
    expect(kept).toContain('<td data-l="now">editing</td>');
    expect(kept).toContain('<td data-l="now"><span class="dim">-</span></td>');
  });

  it("table(): emptiness is the cell's text, not its markup — an empty dim span drops, a dim span with a value stays", () => {
    const t = tableFull((s: unknown) => String(s ?? ""));
    // the live Workers "pos" column: <span class="dim"></span> in every row — no text at all
    const html = t(["worker", "pos"], [["w1", '<span class="dim"></span>'], ["w2", '<span class="dim">&nbsp;</span>']]);
    expect(html).not.toContain("pos");
    expect(html).not.toContain('data-l="pos"');
    expect(html).toContain('<th>worker</th>');
    // the same markup with text inside stays, and a placeholder text stays a placeholder (dropped)
    const kept = t(["worker", "pos"], [["w1", '<span class="dim">3</span>'], ["w2", '<span class="dim">1</span>']]);
    expect(kept).toContain('<th>pos</th>');
    expect(kept).toContain('<td data-l="pos"><span class="dim">3</span></td>');
    const na = t(["worker", "pos"], [["w1", '<span class="dim">n/a</span>'], ["w2", '<span class="dim">…</span>']]);
    expect(na).not.toContain("pos");
  });

  it("table(): a column class rides on the header and its cells; a plain column is byte-identical to the old helper", () => {
    // the helper as it was before empty-column dropping existed, spelled out here so the
    // comparison stays meaningful after the page source changes
    const old = new Function("esc", `function table(head,rows,tips){return'<div class="tw"><table><thead><tr>'+head.map(function(h){return'<th'+(tips&&tips[h]?' title="'+esc(tips[h])+'"':'')+'>'+h+'</th>'}).join("")+'</tr></thead><tbody>'+rows.map(function(r){return'<tr>'+r.map(function(c,i){return'<td data-l="'+esc(head[i]||"")+'">'+c+'</td>'}).join("")+'</tr>'}).join("")+'</tbody></table></div>'}; return table;`)((s: unknown) => String(s ?? ""));
    const t = tableFull((s: unknown) => String(s ?? ""));
    const head = ["session", "models", "req", "tokens", "hit%"];
    const rows = [
      ["alpha", "m1, m2", "3", "1.2k", '<span class="ok">50.0%</span>'],
      ["beta", "m3", "7", "820", '<span class="dim">0.0%</span>'],
    ];
    const tips = { "hit%": "cache_read / (read + write + fresh input)" };
    expect(t(head, rows, tips)).toBe(old(head, rows, tips));
    expect(t(head, rows)).toBe(old(head, rows));
    expect(t(head, [])).toBe(old(head, [])); // no rows: nothing is fully-empty-by-rows, all headers stay
    // a text column: the class rides on th and every td, data-l keeps the bare label,
    // the tip is keyed by the bare label; a numeric column (no class) stays nowrap markup
    const cls = t(["session .txt", "req"], [["alpha", "3"]], { session: "the session" });
    expect(cls).toContain('<th class="txt" title="the session">session</th>');
    expect(cls).toContain('<td class="txt" data-l="session">alpha</td>');
    expect(cls).toContain('<td data-l="req">3</td>');
    expect(cls).not.toContain("dense");
  });

  it("the stacked phone layout gets no label line for a dropped column (data-l only for kept columns)", () => {
    const t = tableFull((s: unknown) => String(s ?? ""));
    const html = t(["session", "now"], [["alpha", '<span class="dim">-</span>'], ["beta", "  "]]);
    // the stacked card prints each cell's label via .tw td::before{content:attr(data-l)}:
    // no cell carries the dropped column's label, so no label line can appear
    expect(html).not.toContain("now");
    expect((html.match(/data-l=/g) ?? []).length).toBe(2); // one per rendered cell, all "session"
    expect(html).toContain('data-l="session">alpha');
    expect(html).toContain('data-l="session">beta');
  });

  it("the verdict colour helper: ok prefixes green, failed red, report flagged amber, the rest dim, undefined dim (no crash)", () => {
    expect(vcls("ok")).toBe("ok");
    expect(vcls("ok · 2 commits")).toBe("ok");
    expect(vcls("done · report flagged · 1 commit")).toBe("warn");
    expect(vcls("failed")).toBe("bad");
    expect(vcls("escalated → 20261021-051809-87842 · 2 commits")).toBe("warn");
    expect(vcls("handed to session")).toBe("warn");
    expect(vcls("running")).toBe("dim");
    expect(vcls("waiting (warm-up) 7s/12s")).toBe("dim");
    expect(vcls(undefined)).toBe("dim");
    expect(vcls(null)).toBe("dim");
    // both verdict tables use the one helper
    expect((COCKPIT_HTML.match(/vcls\(s\.verdict\)/g) ?? []).length).toBe(2);
    expect(COCKPIT_HTML).not.toContain('s.verdict==="ok"');
  });

  it("the header stamp: live after any poll succeeds, offline when all polls fail", () => {
    const tickSrc = COCKPIT_HTML.match(/function tick\(\)\{[\s\S]*?\n\}\n/)![0];
    const run = (lastOk: number) => {
      const els: Record<string, any> = { stamp: { textContent: "", title: "", className: "" } };
      const fn = new Function("$", "lastOk", "STALE_SEC", "dur", "document", `var document={querySelectorAll:function(){return[]}};\n${tickSrc}\nvar st=$("stamp");tick();return st.textContent;`);
      return fn((id: string) => els[id], lastOk, 15, () => "", { querySelectorAll: () => [] }) as string;
    };
    expect(run(0)).toBe("offline");
    expect(run(Date.now() - 20_000)).toMatch(/^stale 20s · \d{1,2}:\d{2}:\d{2}/);
    expect(run(Date.now() - 2_000)).toMatch(/^live · \d{1,2}:\d{2}:\d{2}/);
    // every poll marks itself ok, so a limits/models success updates the stamp even with the usage sections hidden
    // (a good payload goes through feed(), which sets lastOk; a held failure does not)
    expect(COCKPIT_HTML).toContain('feed("limits"');
    expect(COCKPIT_HTML).toContain('feed("models"');
    expect(COCKPIT_HTML).toContain('feed("system"');
    expect(COCKPIT_HTML).toContain('feed("queue"');
    expect(COCKPIT_HTML).toContain("lastOk=F.at");
  });

});

describe("generated model colours", () => {
  it("25 models all get distinct colours; generated hues stay 12 degrees from every palette hue", () => {
    const get = (n: string) => COCKPIT_HTML.match(new RegExp(`function ${n}\\([\\s\\S]*?\\n\\}\\n`))![0];
    const store: Record<string, string> = {};
    const fn = new Function("localStorage", `${COCKPIT_HTML.match(/var KINDS=[\s\S]*?PAL=\[[^\]]+\]/)![0]};\n${COCKPIT_HTML.match(/var colors=[\s\S]*?function saveColors[^\n]*\n/)![0]}\n${["hslHex", "hueOf", "genColor", "colorOf"].map(get).join("\n")}\nreturn {colorOf, hueOf, PAL};`)(
      { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } }) as { colorOf: (k: string) => string; hueOf: (h: string) => number; PAL: string[] };
    const cs = Array.from({ length: 25 }, (_, i) => fn.colorOf(`model-${i}`));
    expect(new Set(cs).size).toBe(25);
    const gen = cs.filter((c) => !fn.PAL.includes(c));
    expect(gen.length).toBeGreaterThan(0);
    for (const g of gen) for (const p of fn.PAL) {
      const d = Math.abs(fn.hueOf(g) - fn.hueOf(p));
      expect(Math.min(d, 360 - d)).toBeGreaterThanOrEqual(12);
    }
  });
});

describe("donut centre label fits the ring's hole", () => {
  it("the label's font-size is capped by the hole: font-size * label.length * 0.62 <= inner diameter", () => {
    const src = COCKPIT_HTML.match(/function donut\([\s\S]*?\n\}\n/)![0];
    const donut = new Function("hitCls", "pct", `var HIT_WARN=0.8,HIT_BAD=0.5;\n${src}\nreturn donut;`)(
      (r: number) => (r < 0.5 ? "bad" : r < 0.8 ? "warn" : "ok"),
      (x: number) => (x * 100).toFixed(1) + "%"
    ) as (ratio: number, sz?: number, tone?: string) => string;
    // the page's own layout values, read from the baked markup — not re-spelled
    const r = Number(COCKPIT_HTML.match(/function donut\([\s\S]*?var r=(\d+),/)![1]);
    const stroke = Number(COCKPIT_HTML.match(/function donut\([\s\S]*?stroke-width="(\d+)"/)![1]);
    const inner = 2 * r - stroke;
    for (const ratio of [0.93, 1.0]) {
      const svg = donut(ratio);
      const fs = Number(svg.match(/font-size:([\d.]+)px/)![1]);
      const label = svg.match(/<text[^>]*>([^<]*)<\/text>/)![1];
      expect(label).toBe((ratio * 100).toFixed(1) + "%");
      // fs = min(cap, inner/(len*0.62)): re-multiplying can land 1 ULP above inner
      expect(fs * label.length * 0.62).toBeLessThanOrEqual(inner + 1e-9);
    }
  });
});

describe("local server tiles say why they are empty", () => {
  it("end-to-end tile carries the window reason and the 24 h counts; prefix cache says the server reports none", () => {
    expect(COCKPIT_HTML).toContain("no requests in the last hour (24 h: ");
    expect(COCKPIT_HTML).toContain("ttft p50 ");
    expect(COCKPIT_HTML).toContain("server reports no prefix-cache counter");
  });
});

describe("provider limits card gauge fit", () => {
  it("lays gauges out on width only: fit container, no inner scroll, dials scale with height", () => {
    const html = cockpitHtml();
    expect(html).toContain('class="gauges fit"');
    expect(html).toMatch(/\.gauges\.fit\{[^}]*height:100%[^}]*overflow:hidden[^}]*container-type:size/);
    expect(html).toContain("@container (max-height:110px){.gauges.fit .gauge .s{display:none}");
    expect(html).not.toMatch(/\.gauges\.fit[^{]*\{[^}]*flex-direction:column/);
  });
});
