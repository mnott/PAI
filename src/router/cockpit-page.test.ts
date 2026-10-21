import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COCKPIT_FAVICON_SVG, COCKPIT_HTML, cockpitHtml } from "./cockpit-page.js";
import { POOL_PANEL_JS } from "./pool-panel.js";

/** Stand-in for the page's setHtml in tests that run a render function against plain fake elements. */
const SH = "function setHtml(el,h){el.innerHTML=h;return true}";
const RENDERERS = ["var SESS_MORE_KEY", "function sessMore", "function renderProviders", "function renderSessions", "function renderWorkers"].map((n) => COCKPIT_HTML.match(new RegExp(n + "[\\s\\S]*?\\n(?:\\}\\n|(?=function))"))![0]).join("\n");
// renderLimits builds the local tile with localTile, which reads the model names through ringName/shortModel and gbm
const LT = ["gbm", "shortModel", "ringName", "localTile"].map((n) => COCKPIT_HTML.match(new RegExp(`function ${n}[\\s\\S]*?\\n\\}`))![0]).join("\n");
/** The tile markup helpers (one-liners) and a no-op order pass, for the renderers extracted in isolation. */
const TH = ["tileAttrs", "tileGrip"].map((n) => COCKPIT_HTML.match(new RegExp(`function ${n}\\([^\\n]*\\n`))![0]).join("\n") + "\nfunction orderTiles(){}\n";

const COLLAPSE_KEY_TEST = "pai.cockpit.collapsed";

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

  it("every tooltip icon is focusable and carries an aria-label", () => {
    const tags = COCKPIT_HTML.match(/<span class="tip"[^>]*>/g)!;
    expect(tags.length).toBeGreaterThanOrEqual(8);
    for (const t of tags) {
      expect(t).toContain('tabindex="0"');
      expect(t).toMatch(/aria-label="[^"]+"/);
      expect(t).toContain("data-tip=");
    }
    const helper = COCKPIT_HTML.match(/function tip\(t\)\{[^\n]*\}/)![0];
    expect(helper).toContain("tabindex=");
    expect(helper).toContain("aria-label=");
  });

  it("moved explanations live in tooltips", () => {
    for (const w of ["cache_read / (read + write + fresh input)", "* server counter", "TTFT = request sent", "A drop in hits after 5m", "windows differ", "Weighted: tokens times Anthropic price ratios"]) {
      expect(COCKPIT_HTML).toContain(w);
    }
    expect(COCKPIT_HTML).toMatch(/\.tip::after\{content:attr\(data-tip\)/);
  });

  it("local providers that are down sit in one closed <details>; up ones stay visible", () => {
    const body = COCKPIT_HTML.match(/function renderLimits[\s\S]*?\n\}/)![0];
    const els: Record<string, { innerHTML: string; textContent?: string }> = { cloud: { innerHTML: "" }, local: { innerHTML: "" } };
    const fn = new Function(
      "lim", "$", "esc", "gauge", "ago", "dur", "mdl", "modelsHtml", "document",
      `function keepDowns(){}\n${SH}\n${LT}\n${TH}\n${body}\nrenderLimits();`
    );
    const lim = {
      activeLocal: "dead17",
      limits: [
        { provider: "up1", kind: "local", up: true, served: ["m"] },
        ...Array.from({ length: 18 }, (_, i) => ({ provider: `dead${i}`, kind: "local", up: false })),
      ],
    };
    fn(lim, (id: string) => els[id], (s: string) => s, () => "", () => "", () => "", null, () => "", { querySelectorAll: () => [] });
    const html = els.local!.innerHTML;
    expect(html).toContain("up1");
    expect(html).toContain("<details");
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
    expect(html).toContain("1 local model down");
    expect(html).not.toContain("inactive local");
    const outside = html.replace(/<details[\s\S]*?<\/details>/g, "");
    expect(outside).toContain("up1");
    expect(outside).not.toContain("dead0");
    expect(html.match(/<details[\s\S]*?<\/details>/g)!.join("")).toContain("dead17");
    expect(outside).not.toContain(">down<");
  });
});

describe("phone width: every table stacks inside its card (issue: pause and sessions overflowed at 375 px)", () => {
  const tableSrc = COCKPIT_HTML.match(/function table\([\s\S]*?\n\}\n/)![0];
  const renderPause = (cachePause: unknown) => {
    const body = COCKPIT_HTML.match(/function render\(\)\{[\s\S]*?\n\}\n/)![0];
    const els: Record<string, { innerHTML: string }> = { pause: { innerHTML: "" } };
    new Function(
      "data", "$", "esc", "fmt", "pct", "tot", "cls", "hitCls", "ERROR_WARN", "ERROR_BAD", "ago", "table", "vcls", "assignColors", "stackedBars", "twoToneModelBars", "chartCap", "legend", "legendLine", "setTip", "renderDonuts", "colorOf", "KINDS", "localStorage", "msel", "mode", "document", "sel", "SESSION_ROWS", "WORKER_ROWS", "DAILY_DAYS",
      `${SH}\n${TH}\n${tableSrc}\n${RENDERERS}\n${body}\nrender();`
    )(
      { totals: {requests:0,input:0,output:0,cacheWrite:0,cacheRead:0,errors:0}, byModel: [], series: [], weights: {}, cachePause, byProvider: [], bustParts: {}, bySession: [], workers: [], daily: { models: {}, days: [] }, sessionSplit: null },
      (id: string) => els[id] ?? { innerHTML: "" },
      (s: unknown) => String(s ?? ""), (n: number) => String(n), (x: number) => (x * 100).toFixed(1) + "%",
      (t: any) => t.input + t.output + t.cacheWrite + t.cacheRead, () => "", () => "", 0.02, 0.1, () => "1m",
      () => "", () => "", () => "", () => false, () => false, () => "", () => "", () => {}, () => {}, () => "", () => "#3b6fe0",
      [["input", "fresh input", "#3b6fe0"], ["cacheWrite", "cache write", "#e0703b"], ["cacheRead", "cache read", "#2e9e5b"], ["output", "output", "#b04fd0"]],
      { getItem: () => null, setItem: () => {} }, "", "weighted",
      { querySelectorAll: () => [], getElementById: () => ({ onchange: null, value: "" }) }, { onchange: null, value: "" }, 20, 15, 14
    );
    return els.pause!.innerHTML;
  };
  const renderSessions = (bySession: unknown) => {
    const body = COCKPIT_HTML.match(/function render\(\)\{[\s\S]*?\n\}\n/)![0];
    const els: Record<string, { innerHTML: string }> = { sessions: { innerHTML: "" } };
    new Function(
      "data", "$", "esc", "fmt", "pct", "tot", "cls", "hitCls", "ERROR_WARN", "ERROR_BAD", "ago", "table", "vcls", "assignColors", "stackedBars", "twoToneModelBars", "chartCap", "legend", "legendLine", "setTip", "renderDonuts", "colorOf", "KINDS", "localStorage", "msel", "mode", "document", "sel", "SESSION_ROWS", "WORKER_ROWS", "DAILY_DAYS",
      `${SH}\n${TH}\n${tableSrc}\n${RENDERERS}\n${body}\nrender();`
    )(
      { totals: {requests:0,input:0,output:0,cacheWrite:0,cacheRead:0,errors:0}, byModel: [], series: [], weights: {}, cachePause: [], byProvider: [], bustParts: {}, bySession, workers: [], daily: { models: {}, days: [] }, sessionSplit: null },
      (id: string) => els[id] ?? { innerHTML: "" },
      (s: unknown) => String(s ?? ""), (n: number) => String(n), (x: number) => (x * 100).toFixed(1) + "%",
      (t: any) => t.input + t.output + t.cacheWrite + t.cacheRead, () => "", () => "", 0.02, 0.1, () => "1m",
      () => "", () => "", () => "", () => false, () => false, () => "", () => "", () => {}, () => {}, () => "", () => "#3b6fe0",
      [["input", "fresh input", "#3b6fe0"], ["cacheWrite", "cache write", "#e0703b"], ["cacheRead", "cache read", "#2e9e5b"], ["output", "output", "#b04fd0"]],
      { getItem: () => null, setItem: () => {} }, "", "weighted",
      { querySelectorAll: () => [], getElementById: () => ({ onchange: null, value: "" }) }, { onchange: null, value: "" }, 20, 15, 14
    );
    return els.sessions!.innerHTML;
  };
  const MODEL50 = "gyro-m/qwen3.8-flash-next-gyro-m-256k-instruct-v2-mlx-4bit"; // 50 chars
  const NAME60 = "worktree-20261021-015130-55831-phone-fit-check-for-the-cockpit"; // 60 chars

  it("the pause table goes through table(): thead, tbody, a .tw box, every cell carries its column label", () => {
    const html = renderPause([{ model: MODEL50, buckets: [{ label: "<5m", n: 4, hit: 3 }, { label: "5-30m", n: 2, hit: 0 }] }]);
    expect(html).toContain('<div class="tw">');
    expect(html).toContain("<thead>");
    expect(html).toContain("<tbody>");
    expect(html).toContain('<td class="txt" data-l="model (hit% n)">' + MODEL50 + "</td>");
    expect(html).toContain('<td data-l="<5m">');
    expect(html).toContain('<td data-l="5-30m">');
    expect(html).toContain("75%");
    expect(html).toContain("0%");
  });

  it("the sessions table stacks a 60-char name and a 50-char model id inside table(): data-l on every cell, the name ellipsises in its cell", () => {
    const html = renderSessions([{
      name: NAME60, session: "20261021-015130-55831", models: [MODEL50], requests: 3,
      input: 1000, cacheWrite: 100, cacheRead: 500, output: 200, hitRatio: 0.5, busts: 0, errors: 0,
      lastTs: new Date().toISOString(), worker: "w1", verdict: "ok",
    }]);
    expect(html).toContain('<div class="tw">');
    expect(html).toContain("<thead>");
    expect(html).toContain("<tbody>");
    expect(html).toContain('<td class="txt" data-l="session" style="width:35%;');
    expect(html).toContain(NAME60);
    expect(html).toContain('<td class="txt" data-l="models" style="white-space:nowrap"><span title="' + MODEL50 + '">' + MODEL50 + "</span></td>");
    expect(html).toContain('<td data-l="req">3</td>');
    expect(html).toContain('<td data-l="last">1m</td>');
  });

  it("the stacked-card CSS lets a cell shrink: min-width:0 on cells, an inner span ellipsises in a .stacked table; the label never wraps", () => {
    expect(COCKPIT_HTML).toMatch(/\.tw\.stacked th,\.tw\.stacked td\{[^}]*min-width:0[^}]*\}/);
    expect(COCKPIT_HTML).toMatch(/\.tw\.stacked td>span\{min-width:0;overflow:hidden;text-overflow:ellipsis\}/);
    expect(COCKPIT_HTML).toMatch(/\.tw\.stacked td::before\{[^}]*white-space:nowrap;flex:none;align-self:flex-start\}/);
    expect(COCKPIT_HTML).not.toMatch(/@container\s*\(max-width:400px\)\{\.tw/);
  });

  /** The page's CSS rules with their enclosing media range: {sel, decls, maxW}. */
  const cssRules = (html: string): Array<{ sel: string; decls: string; maxW: number }> => {
    const css = html.match(/<style>([\s\S]*?)<\/style>/)![1];
    const rules: Array<{ sel: string; decls: string; maxW: number }> = [];
    let at = 0;
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const head = m[1].trim();
      const mm = head.match(/^@media\(max-width:(\d+)px\)\{(.+)$/);
      if (mm) {
        for (const part of mm[2].split("}")) {
          const pm = part.match(/^\s*([^{]+)\{([^}]*)$/);
          if (pm) rules.push({ sel: pm[1].trim(), decls: pm[2], maxW: +mm[1] });
        }
      } else {
        rules.push({ sel: head, decls: m[2], maxW: Infinity });
      }
      at = m.index + m[0].length;
    }
    void at;
    return rules;
  };
  /** The declarations a selector gets at a given viewport width, media queries resolved. */
  const appliedDecls = (sel: string, width: number): string =>
    cssRules(COCKPIT_HTML)
      .filter((r) => (r.maxW === Infinity ? true : r.maxW >= width) && r.sel.split(",").map((s) => s.trim()).includes(sel))
      .map((r) => r.decls)
      .join(";");
  /** The declarations a selector gets in a stacked table (the rules keyed on .tw.stacked). */
  const phoneDecls = (sel: string): string => appliedDecls(sel.replace(".tw ", ".tw.stacked "), 375);
  /** The used width of an inline-block span: min(max-width, containing-block width),
   *  the shrink-to-fit rule a browser applies at this width. */
  const usedSpanWidth = (sel: string, width: number, containerWidth: number): number => {
    const mw = appliedDecls(sel, width).match(/max-width:([^;]+)/)?.[1] ?? "";
    const minm = mw.match(/^min\((\d+)px,100%\)$/);
    const cap = minm ? Math.min(+minm[1], containerWidth) : mw.endsWith("px") ? +mw.slice(0, -2) : containerWidth;
    return Math.min(cap, containerWidth);
  };

  it("a 90-char session name fits the card at a 375 px main width: the span caps at min(configured,100%) and the cell shrinks", () => {
    const NAME90 = "escalation: loop stop with saved work escalates at once · cb1776b3 done · review pending n"; // 90 chars
    expect(NAME90.length).toBe(90);
    const html = renderSessions([{
      name: NAME90, session: "20261021-015130-55831", models: [MODEL50], requests: 3,
      input: 1000, cacheWrite: 100, cacheRead: 500, output: 200, hitRatio: 0.5, busts: 0, errors: 0,
      lastTs: new Date().toISOString(), worker: "w1", verdict: "ok",
    }]);
    // the rendered markup: the name span is the first-column span carrying the title
    expect(html).toContain('<td class="txt" data-l="session" style="width:35%;max-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><span title="');
    expect(html).toContain(NAME90);
    // the harness: main 375 px, card inside it (card padding 10 px each side)
    const cardW = 375 - 20;
    // the span's used width at phone width: min(480px,100%) of the cell -> at most the card
    expect(usedSpanWidth("#sessions td:first-child span[title]", 375, cardW)).toBeLessThanOrEqual(cardW);
    // the cell can shrink in the stacked phone layout (min-width:0)
    expect(appliedDecls("#sessions td:first-child", 375)).toContain("min-width:0");
    expect(appliedDecls(".tw.stacked td", 375)).toContain("min-width:0");
  });

  /** The used width of a block row inside the stacked table at a viewport width:
   *  a block box fills its containing block, capped by its own max-width; a row whose
   *  content is wider than the card only overflows if the row itself has no cap. */
  const usedRowWidth = (sel: string, width: number, containerWidth: number): number => {
    const d = appliedDecls(sel, width);
    const disp = d.match(/display:([^;]+)/)?.[1] ?? "";
    const mw = d.match(/max-width:([^;]+)/)?.[1] ?? "";
    const cap = mw === "100%" ? containerWidth : mw.endsWith("px") ? +mw.slice(0, -2) : Infinity;
    return disp === "block" ? Math.min(containerWidth, cap) : Math.max(containerWidth, cap);
  };

  it("stacked mode: tbody and tr are blocks sized to the card, so a 90-char session row is no wider than the .tw box", () => {
    const NAME90 = "escalation: loop stop with saved work escalates at once · cb1776b3 done · review pending n"; // 90 chars
    expect(NAME90.length).toBe(90);
    const html = renderSessions([{
      name: NAME90, session: "20261021-015130-55831", models: [MODEL50], requests: 3,
      input: 1000, cacheWrite: 100, cacheRead: 500, output: 200, hitRatio: 0.5, busts: 0, errors: 0,
      lastTs: new Date().toISOString(), worker: "w1", verdict: "ok",
    }]);
    expect(html).toContain("<tbody>");
    expect(html).toContain(NAME90);
    // the harness: viewport 375 px, card inside main (card padding 10 px each side)
    const cardW = 375 - 20;
    // tbody must not stay a table-row-group: that wraps in an anonymous table box sized to the widest content
    expect(appliedDecls(".tw.stacked tbody", 375)).toContain("display:block");
    expect(appliedDecls(".tw.stacked tbody", 375)).toContain("max-width:100%");
    expect(appliedDecls(".tw.stacked tr", 375)).toContain("display:block");
    expect(appliedDecls(".tw.stacked tr", 375)).toContain("max-width:100%");
    expect(appliedDecls(".tw.stacked td", 375)).toContain("max-width:100%");
    // a row with the 90-char name sizes to the card, not to its content
    expect(usedRowWidth(".tw.stacked tbody", 375, cardW)).toBeLessThanOrEqual(cardW);
    expect(usedRowWidth(".tw.stacked tr", 375, cardW)).toBeLessThanOrEqual(cardW);
    // desktop (non-stacked) layout untouched: the phone rules don't apply at 900 px,
    // and the base rules carry no display override (tbody stays table-row-group there)
    expect(phoneDecls(".tw tbody")).toContain("display:block");
    expect(phoneDecls(".tw tr")).toContain("display:block");
    // no base (non-media) rule touches tbody/tr display: desktop keeps the table layout
    // (cssRules misparses the phone block as base rules, so scan the base CSS before the media blocks)
    const baseCss = COCKPIT_HTML.match(/<style>([\s\S]*?)<\/style>/)![1].split("@media(")[0];
    expect([...baseCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1].split(",").map((s) => s.trim()).some((s) => s === ".tw tbody" || s === ".tw tr"))).toEqual([]);
  });

  it("the pause and sessions panels render through table(), not a hand-rolled table", () => {
    // indexOf, not a regex: a `$` in a pattern misbehaves in this engine
    const lineOf = (needle: string) => {
      const i = COCKPIT_HTML.indexOf(needle);
      return i < 0 ? "" : COCKPIT_HTML.slice(i, COCKPIT_HTML.indexOf("\n", i));
    };
    const pauseLine = lineOf('setHtml($("pause")');
    const sessLine = lineOf(" setHtml(el,table([\"session .txt\"");
    expect(pauseLine).not.toBe("");
    expect(sessLine).not.toBe("");
    expect(pauseLine).toContain("table(");
    expect(pauseLine).not.toContain("<table>");
    expect(sessLine).toContain("table(");
  });

  it("no section renders a bare table outside a .tw box: the queue blocks go through table() too", () => {
    const script = COCKPIT_HTML.match(/<script>[\s\S]*<\/script>/)![0];
    // the only markup that builds rows is table() itself; everything else passes cells to table()
    expect(script.match(/<tr/g) ?? []).toEqual(["<tr", "<tr", "<tr"]); // table()'s thead row, body row, closing tags
    expect(script.match(/<td/g) ?? []).toEqual(["<td"]); // table()'s cell template (the closing tag is '</td>')
    expect(script.match(/<th/g) ?? []).toEqual(["<th", "<th"]); // table()'s head template and its closing tag
    // the queue section's blocks are table() boxes, not hand-rolled tables
    expect(COCKPIT_HTML).toContain("function block(title,head,rows){return'<div style=\"margin-bottom:10px\"><div style=\"margin-bottom:2px\"><b>'+title+'</b></div>'+table(head,rows)+'</div>'}");
    expect(COCKPIT_HTML).not.toContain('<div class="tw"><table><tr>');
  });
});

describe("live-shaped payloads", () => {
  it("Local block: only a local model that should be running can be down; a stopped one is a startable Models row", () => {
    const body = COCKPIT_HTML.match(/function renderLimits[\s\S]*?\n\}/)![0];
    const run = (activeLocal: string | null) => {
      const els: Record<string, { innerHTML: string }> = { cloud: { innerHTML: "" }, local: { innerHTML: "" } };
      const fn = new Function("lim", "$", "esc", "gauge", "ago", "dur", "mdl", "modelsHtml", "document", `function keepDowns(){}\n${SH}\n${LT}\n${TH}\n${body}\nrenderLimits();`);
      const lim = { activeLocal, limits: [{ provider: "gyro-m", kind: "local", up: true, served: ["m"] }, { provider: "flashnext-iq3", kind: "local", up: false }] };
      fn(lim, (id: string) => els[id], (s: string) => s, () => "", () => "", () => "", null, () => "", { querySelectorAll: () => [] });
      return els.local!.innerHTML;
    };
    const h = run("gyro-m");
    expect(h).not.toContain("inactive local");
    expect(h.replace(/downs/g, "")).not.toContain("down");
    expect(run("flashnext-iq3")).toContain("1 local model down");
  });
});

describe("cockpit layout follow-up", () => {
  it("cloud and local models are cards in one responsive row across the full width", () => {
    // a wrapping flex row, never a grid: a grid's last row can sit partial (one tile,
    // half width, empty space beside it); flex: 1 1 makes every row fill, last row included
    expect(COCKPIT_HTML).toMatch(/\.pgrid\{display:flex;flex-wrap:wrap;gap:8px;min-width:0;align-items:start\}/);
    expect(COCKPIT_HTML).toMatch(/\.pgrid>\*\{flex:1 1 260px;min-width:min\(260px,100%\)/);
    expect(COCKPIT_HTML).toMatch(/\.pgrid \.downs\{flex-basis:100%\}/);
    expect(COCKPIT_HTML).not.toMatch(/\.pgrid\{[^}]*display:grid/);
    expect(COCKPIT_HTML).toContain('<div class="pgrid" id="cloud">');
    expect(COCKPIT_HTML).toContain('<div class="pgrid" id="local">');
    // two sub-headers, Local cards first, then Cloud cards
    expect(COCKPIT_HTML).toMatch(/<h2 class="pgsub">Local<\/h2><div class="pgrid" id="local"><\/div><h2 class="pgsub">Cloud<\/h2><div class="pgrid" id="cloud">/);
    expect(COCKPIT_HTML).not.toContain("grp-cloud");
    expect(COCKPIT_HTML).not.toContain("grp-local");
    // gauges scale via the viewBox; a long unbreakable line must not push a gauge past its container
    expect(COCKPIT_HTML).toMatch(/\.gauge\{[^}]*min-width:0[^}]*flex:1 1 110px[^}]*max-width:min\(120px,100%\)/);
    expect(COCKPIT_HTML).toMatch(/\.gauge svg\{display:block;width:100%;height:auto\}/);
  });

  it("the cloud section is status only: gauges per provider, local cards, no rank badges or controls", () => {
    const body = COCKPIT_HTML.match(/function renderLimits[\s\S]*?\n\}/)![0];
    const els: Record<string, { innerHTML: string; textContent?: string }> = { cloud: { innerHTML: "" }, local: { innerHTML: "" } };
    const fn = new Function("lim", "$", "esc", "gauge", "ago", "dur", "mdl", `function keepDowns(){}\n${SH}\n${LT}\n${TH}\n${body}\nrenderLimits();`);
    const lim = {
      limits: [
        { provider: "anthropic", kind: "cloud", windows: [{ name: "5h", percent: 10 }] },
        { provider: "glm", kind: "cloud", windows: [{ name: "5h", percent: 10 }] },
        { provider: "gyro-m", kind: "local", up: true, rssMb: 5, tokensPerSec: 9 },
      ],
    };
    fn(lim, (id: string) => els[id], (s: string) => s, (l: { provider: string }) => `<gauge ${l.provider}>`, () => "", () => "", null);
    expect(els.cloud!.innerHTML).toContain('data-prov="anthropic"');
    expect(els.cloud!.innerHTML).toContain("<gauge glm>");
    expect(els.local!.innerHTML).toContain("9 tok/s");
    for (const h of [els.cloud!.innerHTML, els.local!.innerHTML, COCKPIT_HTML]) {
      expect(h).not.toMatch(/rkb|rkpop|rankPop|wireRanks|data-rank|ranksum|chainSummary|lim\.chains/);
      expect(h).not.toContain("cloud.role");
    }
    expect(COCKPIT_HTML).not.toMatch(/alert\(|confirm\(|prompt\(/);
  });

  it("the routing section: the flow line on top, then three tier rows with ordered chips and arrows coloured by state", () => {
    expect(COCKPIT_HTML).toContain('data-section="routing"');
    expect(COCKPIT_HTML.indexOf('data-section="cloud"')).toBeLessThan(COCKPIT_HTML.indexOf('data-section="routing"'));
    expect(COCKPIT_HTML.indexOf('data-section="routing"')).toBeLessThan(COCKPIT_HTML.indexOf('data-section="workers"'));
    const body = COCKPIT_HTML.match(/function renderRouting[\s\S]*?\n\}/)![0];
    const els: Record<string, { innerHTML: string }> = { routing: { innerHTML: "" } };
    const doc = { querySelector: () => ({}), querySelectorAll: () => [] };
    const wire = COCKPIT_HTML.match(/function wireRouting[\s\S]*?\n\}/)![0];
    const eps = COCKPIT_HTML.match(/function renderEndpoints[\s\S]*?\n\}/)![0];
    const run = new Function("lim", "$", "esc", "document", `${SH}\n${body}\n${wire}\n${eps}\nrenderRouting();`);
    const lim = {
      routing: {
        flow: "t0 Session: opus → t1 Orchestrator: sonnet → t2 Worker: local gyro-m",
        rows: [
          { id: "t0", label: "t0 Session", description: "the interactive session", classes: [], chips: [{ entry: "anthropic/opus", label: "anthropic/opus", state: "available", why: "" }] },
          { id: "t1", label: "t1 Orchestrator", note: "planning, reasoning", classes: ["orchestrate", "plan"], chips: [{ entry: "glm", label: "glm/glm-5.3", state: "available", why: "" }] },
          {
            id: "t2",
            label: "t2 Worker",
            classes: ["implement", "research", "draft", "review", "complex"],
            sessions: [{ session: "job", chips: [{ entry: "glm/fast", label: "glm/glm-5.3-flash", state: "available", why: "" }] }],
            chips: [
              { entry: "gyro-m", label: "local gyro-m", state: "idle", why: "not running" },
              { entry: "anthropic/sonnet", label: "anthropic/sonnet", state: "tight", why: "budget 85%" },
              { entry: "glm/fast", label: "glm/glm-5.3-flash", state: "unavailable", why: "cooldown 5 min" },
            ],
          },
        ],
      },
    };
    run(lim, (id: string) => els[id], (x: string) => x, doc);
    const h = els.routing!.innerHTML;
    expect(h.indexOf("t0 Session: opus → t1 Orchestrator: sonnet → t2 Worker: local gyro-m")).toBeGreaterThan(-1);
    expect(h.indexOf('class="rtflow"')).toBeLessThan(h.indexOf('class="rtrow"'));
    expect(h.match(/class="rtrow"/g)).toHaveLength(3);
    for (const l of ["t0 Session", "t1 Orchestrator", "t2 Worker"]) expect(h).toContain(l);
    expect(h).toContain('title="the interactive session"');
    expect(h).toContain('title="planning, reasoning"');
    expect(h.match(/rtarrow/g)).toHaveLength(2);
    expect(h).toContain('class="rtchip idle"');
    expect(h).toContain('class="rtchip tight"');
    expect(h).toContain('class="rtchip unavailable"');
    expect(h).toContain('class="rtchip available"');
    expect(h).toContain("implement · research · draft · review · complex");
    expect(h).toContain('class="rtsess"');
    for (const editing of ["draggable", "rtx", "rtadd", "rtlist"]) expect(h).not.toContain(editing);
    // the selector menu: one per tier row, no choices -> no menu
    expect(h).not.toContain("rtsel");
    for (const w of ["--ok", "--warn", "--bad"]) expect(COCKPIT_HTML).toMatch(new RegExp(`\\.rtchip\\.[a-z]+\\{[^}]*${w}`));
    // no drag wiring inside it
    const routingSrc = COCKPIT_HTML.match(/function renderRouting[\s\S]*?\n\}/)![0];
    for (const gone of ["rtDrag", "b.clear=true", "ArrowLeft"]) expect(routingSrc).not.toContain(gone);
  });

  it("each tier row has a selector menu; a pick posts route.set with the pick first; registered endpoints list with enable/disable", () => {
    const body = COCKPIT_HTML.match(/function renderRouting[\s\S]*?\n\}/)![0];
    const wire = COCKPIT_HTML.match(/function wireRouting[\s\S]*?\n\}/)![0];
    const eps = COCKPIT_HTML.match(/function renderEndpoints[\s\S]*?\n\}/)![0];
    const els: Record<string, { innerHTML: string; querySelectorAll: () => unknown[] }> = { routing: { innerHTML: "", querySelectorAll: () => [] }, endpoints: { innerHTML: "", querySelectorAll: () => [] } };
    const posts: unknown[][] = [];
    const sel = { value: "model:qwen", disabled: false, parentNode: { querySelector: () => null, getAttribute: () => "gyro-m,anthropic/sonnet,model:qwen" }, getAttribute: () => "t2", onchange: null as null | (() => void) };
    const doc = { querySelector: () => ({}), querySelectorAll: () => [] };
    const lim = { routing: {
      flow: "f", choices: [{ entry: "local", label: "local (any healthy local endpoint)" }, { entry: "model:qwen", label: "model:qwen" }],
      rows: [{ id: "t2", label: "t2 Worker", classes: [], chips: [{ entry: "gyro-m", label: "local gyro-m", state: "idle", why: "" }, { entry: "anthropic/sonnet", label: "anthropic/sonnet", state: "available", why: "" }] }],
      endpoints: [
        { id: "mac2", model: "mac2", provider: "mac2", origin: "registered", host: "10.0.0.2:8000", healthy: true, enabled: true, tags: ["fast"], classes: [] },
        { id: "gyro-m#1", model: "gyro-m", provider: "gyro-m", origin: "managed", host: "127.0.0.1:8100", healthy: true, enabled: true, tags: [], classes: [] },
      ] } };
    const run = new Function("lim", "$", "esc", "document", "postAction", "loadLimits", "setHtml", "wireAct", `${SH}\n${body}\n${wire}\n${eps}\nrenderRouting();return wireRouting;`);
    const setHtml = (el: { innerHTML: string }, h: string) => { el.innerHTML = h; return true; };
    const wireRouting = run(lim, (id: string) => els[id], (x: string) => x, doc, (...a: unknown[]) => posts.push(a), () => {}, setHtml, () => {});
    const h = els.routing!.innerHTML;
    expect(h).toContain('class="rtsel" data-tier="t2"');
    expect(h).toContain('<option value="local">');
    expect(h).toContain('<option value="model:qwen">');
    expect(h).toContain('data-entries="gyro-m,anthropic/sonnet"');
    const e = els.endpoints!.innerHTML;
    expect(e).toContain("registered · 10.0.0.2:8000");
    expect(e).toContain("managed · 127.0.0.1:8100");
    expect(e).toContain('data-a="endpoint.enable" data-t="mac2" data-v="off"');
    expect(e.match(/endpoint\.enable/g)).toHaveLength(1);
    expect(e).not.toMatch(/start|stop/i);
    wireRouting({ querySelectorAll: () => [sel] });
    sel.onchange!();
    expect(posts[0]!.slice(0, 3)).toEqual(["route.set", "t2", "model:qwen,gyro-m,anthropic/sonnet"]);
  });

  it("shows a loading state until the first limits poll arrives", () => {
    expect(COCKPIT_HTML).toContain('lim?"server reports no prefix-cache counter":"loading: first limits poll pending"');
    expect(COCKPIT_HTML).toContain("lim?\"not reported\":'<span class=\"dim\" title=\"loading: first limits poll pending\">…</span>'");
    expect(COCKPIT_HTML).toContain("lim=j;renderLimits();renderRouting();if(sys)renderSystem();renderDonuts()");
  });

  it("low-request models render as a chip line, not tiles", () => {
    expect(COCKPIT_HTML).toContain('id="donutlow"');
    expect(COCKPIT_HTML).toContain("function lowChips(ms)");
    expect(COCKPIT_HTML).toMatch(/filter\(function\(m\)\{return m\.requests>=LOW_REQ\}\)/);
    expect(COCKPIT_HTML).not.toContain("ring low");
    expect(COCKPIT_HTML).not.toContain('(low?" low":"")');
  });
});

/** The real System renderer with the real metric tile helpers; returns what it wrote into #sys, #syshid and #sysservers. */
function renderSys(sys: any, o: { win?: string; data?: any; fresh?: boolean } = {}) {
  const els: Record<string, { innerHTML: string }> = { sys: { innerHTML: "" }, syshid: { innerHTML: "" }, sysservers: { innerHTML: "" } };
  const one = (n: string) => COCKPIT_HTML.match(new RegExp(`function ${n}\\([^\\n]*\\n`))![0];
  const many = (n: string) => COCKPIT_HTML.match(new RegExp(`function ${n}\\([\\s\\S]*?\\n\\}\\n`))![0];
  const src = [one("esc"), one("gb"), one("gbm"), many("metricSpark"), many("metricTile"), one("staleAge"), one("ringPush"), many("renderSystem")].join("\n");
  const fn = new Function(
    "sys", "$", "win", "data", "lim", "fmt",
    `${SH}\nvar LAST={},SYSH={},SYS_HIST_LEN=60;function renderDonuts(){}function applyTileOrder(){}function tileGrips(){}function orderTiles(){}function wireMinAll(){}var document={querySelectorAll:function(){return[]}};\n${src}\nrenderSystem();return SYSH;`
  );
  fn(sys, (id: string) => els[id], o.win ?? "1h", o.data ?? {}, null, (n: number) => String(n));
  return { sys: els.sys!.innerHTML, hid: els.syshid!.innerHTML, srv: els.sysservers!.innerHTML };
}
const GB = 1073741824;
const sysOf = (series: Array<Record<string, number>>, current: Record<string, number>, servers: unknown[] = []) => ({ current, series: { series, wh: { "1h": 4 }, coveredMin: { "1h": 60 } }, servers });
const tileTitles = (html: string) => [...html.matchAll(/<span class="mt-label">(?:<span class="mt-icon">[^<]*<\/span>)?([^<]*)<\/span>/g)].map((m) => m[1]);

describe("cockpit system tiles: unused metrics", () => {
  it("hides ANE tiles when ANE is 0 for the whole window and says so", () => {
    const r = renderSys(sysOf([{ t: 1, n: 1, ane: 0, aneW: 0, gpu: 5 }, { t: 2, n: 1, ane: 0, aneW: 0, gpu: 7 }], { ane: 0, aneW: 0, gpu: 6 }));
    expect(tileTitles(r.sys)).not.toContain("ANE load");
    expect(tileTitles(r.sys)).not.toContain("ANE W");
    expect(tileTitles(r.sys)).toContain("GPU load");
    expect(r.hid).toContain("hidden: ANE load, ANE W (0 in this window)");
  });

  it("shows ANE tiles once any bucket has ANE use", () => {
    const r = renderSys(sysOf([{ t: 1, n: 1, ane: 0, aneW: 0 }, { t: 2, n: 1, ane: 12, aneW: 0.4 }], { ane: 12, aneW: 0.4 }));
    expect(tileTitles(r.sys)).toContain("ANE load");
    expect(tileTitles(r.sys)).toContain("ANE W");
    expect(r.hid).toBe("");
  });

  it("the local server tiles show RSS in GB with one decimal, never MB", () => {
    const r = renderSys(sysOf([], {}, [{ provider: "gyro-m", up: true, rssMb: 47723 }]));
    expect(r.srv).toContain('<span class="mt-value">46.6<small>GB</small></span>');
    expect(tileTitles(r.srv)).toEqual(["gyro-m RSS", "gyro-m end-to-end", "gyro-m decode", "gyro-m prefix cache"]);
  });

  it("keeps tiles when the window has no samples for them", () => {
    const r = renderSys(sysOf([{ t: 1, n: 1 }], {}));
    expect(tileTitles(r.sys)).toContain("ANE load");
    expect(r.hid).toBe("");
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
    expect(COCKPIT_HTML).toMatch(/<title>PAI router cockpit<\/title>\n<link rel="icon"/);
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

describe("cockpit workers panel", () => {
  const table = COCKPIT_HTML.match(/function table\(head,rows,tips(?:,tdStyle)?\)\{[\s\S]*?\n\}\n/)![0]; // the helper, whole
  const vcls = COCKPIT_HTML.match(/function vcls\([\s\S]*?\n/)![0];
  const body = COCKPIT_HTML.match(/var qdrag[\s\S]*?\n\}/)![0];
  const render = (q: unknown) => {
    const els: Record<string, { innerHTML: string; querySelectorAll: () => unknown[] }> = {
      queuepanel: { innerHTML: "", querySelectorAll: () => [] },
      queuetip: { innerHTML: "", querySelectorAll: () => [] },
    };
    const fn = new Function("q", "$", "esc", "setTip", "loadQueue", `${SH}\n${table}\n${vcls}\n${body}\nrenderQueue(q);`);
    fn(q, (id: string) => els[id], (s: string) => s, () => {}, () => {});
    return els.queuepanel!.innerHTML;
  };

  it("renders running chips with no waiting entries", () => {
    const html = render({ providers: [{ provider: "glm", cap: 2, running: [{ id: "w1", label: "fix-x", ageSec: 120, now: "editing" }], waiting: [] }] });
    expect(html).toContain("glm/?");
    expect(html).toContain("other"); // no session: the "other" block
    expect(html).toContain("fix-x");
    expect(html).toContain("editing");
    expect(html).not.toContain("nothing running or waiting");
  });

  it("renders waiting entries with buttons", () => {
    const html = render({ providers: [{ provider: "anthropic", cap: 1, running: [], waiting: [{ id: "w-2", label: "later", waitedSec: 30, position: 1 }] }] });
    expect(html).toContain("later");
    expect(html).toContain('data-q="next"');
    expect(html).toContain('data-q="up"');
  });

  it("one block per session, models inside, the cap-1 provider on its own block first", () => {
    const html = render({
      providers: [
        { provider: "anthropic", cap: 4, running: [
          { id: "w1", label: "alpha", ageSec: 10, session: "PAI", model: "sonnet" },
          { id: "w2", label: "beta", ageSec: 20, session: "PAI", model: "sonnet" },
          { id: "w3", label: "gamma", ageSec: 30, session: "AIBroker", model: "opus" },
          { id: "w4", label: "shelly", ageSec: 30, session: "other", model: "haiku" },
        ], waiting: [] },
        { provider: "local", cap: 1, running: [{ id: "l1", label: "running-local", ageSec: 5, session: "PAI", model: "flashnext-iq3" }],
          waiting: [
            { id: "l2", label: "first-wait", waitedSec: 9, position: 1, session: "AIBroker", model: "flashnext-iq3" },
            { id: "l3", label: "second-wait", waitedSec: 4, position: 2, session: "PAI", model: "flashnext-iq3" },
          ] },
      ],
    });
    const at = (x: string) => html.indexOf(x);
    expect(at("local: flashnext-iq3 (slots 1/1)")).toBeGreaterThanOrEqual(0);
    expect(at("local: flashnext-iq3 (slots 1/1)")).toBeLessThan(at("AIBroker <span"));
    expect(at("AIBroker <span")).toBeLessThan(at("PAI <span"));
    expect(at("PAI <span")).toBeLessThan(at(">other <span"));
    expect(html).toContain("anthropic/sonnet ×2");
    expect(html).toContain("anthropic/opus ×1");
    // waiting order, session label and drag handle in the local block
    expect(at("first-wait")).toBeLessThan(at("second-wait"));
    expect(at("running-local")).toBeLessThan(at("first-wait"));
    expect(html).toContain('data-qrow="1" draggable="true" data-id="l2"');
    expect(html).not.toContain('data-id="w1" data-prov'); // running rows are not draggable
  });

  it("marks stale sessions dim and shows the empty state", () => {
    const html = render({ providers: [{ provider: "glm", running: [{ id: "a", label: "AIBroker", ageSec: 250000 }], waiting: [] }] });
    expect(html).toContain("idle session");
    expect(render({ providers: [{ provider: "glm", running: [], waiting: [] }] })).toContain("nothing running or waiting");
  });

  it("sits above the System card, below the gauges", () => {
    const i = (s: string) => COCKPIT_HTML.indexOf(s);
    expect(i("Workers — running and waiting")).toBeGreaterThan(i('id="cloud"'));
    expect(i("Workers — running and waiting")).toBeLessThan(i("<h2>System"));
  });
});

describe("cockpit Models cards", () => {
  const src = [
    COCKPIT_HTML.match(/function metricSpark[\s\S]*?\n\}/)![0],
    COCKPIT_HTML.match(/function metricTile[\s\S]*?\n\}/)![0],
    COCKPIT_HTML.match(/function shortModel\([\s\S]*?\n\}/)![0],
    COCKPIT_HTML.match(/function actRow[\s\S]*?\n\}/)![0],
    COCKPIT_HTML.match(/function tierRow[\s\S]*?\n\}/)![0],
    COCKPIT_HTML.match(/function gb\(b,d\)\{[^\n]*\}/)![0],
    COCKPIT_HTML.match(/function gbm\(m\)\{[^\n]*\}/)![0],
    COCKPIT_HTML.match(/function modelsHtml[\s\S]*?\n\}/)![0],
  ].join("\n");
  const modelsHtml = new Function("esc", "pct", `${src}; return modelsHtml;`)(
    (s: unknown) => String(s ?? ""),
    (x: number) => (x * 100).toFixed(1) + "%"
  ) as (inv: unknown) => string;
  it("models: an on-demand model with a consumer on a running runtime gets its card, available (loads on first request)", () => {
    const h = modelsHtml({
      at: "x",
      runtimes: [
        { name: "ollama", kind: "ollama", status: "running", port: 11434, users: ["paperfull-chat", "pai-embedding"], models: [
          { model: "qwen3:8b", kind: "chat", loaded: true, memoryMb: 5000, usedBy: ["paperfull-chat"] },
          { model: "arctic-embed-m-v1.5-f16:latest", kind: "embedding", loaded: false, usedBy: ["pai-embedding"] },
        ] },
        { name: "docker-model-runner", kind: "docker-model-runner", status: "idle", port: 12434, users: ["paperfull-search"], models: [{ model: "e5", kind: "embedding", loaded: false, usedBy: ["paperfull-search"] }] },
      ],
      duplicates: [],
      live: { at: 1, runtimes: [] },
    });
    expect(h).toContain('data-rt="ollama" data-model="arctic-embed-m-v1.5-f16:latest"');
    const card = h.split('<div class="mcard').find((c) => c.includes('data-model="arctic-embed'))!;
    expect(card).toContain("available (loads on first request)");
    expect(card).toContain("pai-embedding");
    expect(card).not.toContain("badge bad");
    expect(h).toContain('data-rt="docker-model-runner"');
  });
  it("a card carries a move grip, sits in an orderable grid, and its title has its own row apart from the chips", () => {
    const h = modelsHtml({
      at: "x",
      runtimes: [{ name: "ollama", kind: "ollama", status: "running", port: 11434, users: ["paperfull-chat"], models: [{ model: "qwen3:8b", kind: "chat", loaded: false, label: "Paperfull chat model", usedBy: ["paperfull-chat"] }] }],
      duplicates: [],
      live: { at: 1, runtimes: [] },
    });
    expect(h).toContain('<div class="rt-grid" data-tkey="models cards">');
    expect(h).toContain('data-tval="running"');
    const card = h.split('<div class="mcard')[1]!;
    expect(card).toContain('data-tid="ollama / qwen3:8b"');
    expect(card).toContain("data-tgrip");
    const title = card.indexOf('<div class="mtitle">');
    const chips = card.indexOf('<div class="mchips">');
    expect(title).toBeGreaterThan(-1);
    expect(chips).toBeGreaterThan(title);
    expect(card.slice(title, chips)).toContain("Paperfull chat model");
    expect(card.slice(title, chips)).not.toContain("badge");
    expect(card.slice(chips)).toContain("badge");
  });
  it("a runtime whose last probe was slow reads amber 'slow', not down", () => {
    const h = modelsHtml({
      at: "x",
      runtimes: [{ name: "strata", kind: "strata", status: "running", slow: true, port: 8035, users: ["gyro-m"], models: [{ model: "m", kind: "coding", loaded: true, usedBy: ["gyro-m"] }] }],
      duplicates: [],
      live: { at: 1, runtimes: [] },
    });
    expect(h).toContain("rt-dot slow");
    expect(h).toContain(">slow</span>");
    expect(h).not.toContain("cannot work");
  });
  it("a card is per consumer: a shared runtime's purpose line, used-by and USERS tile describe that consumer only", () => {
    const h = modelsHtml({
      at: "x",
      runtimes: [{ name: "ollama", kind: "ollama", label: "PAI's embedding backend runs here", status: "running", port: 11434, users: ["paperfull-chat", "pai-embedding"], models: [
        { model: "qwen3:8b", kind: "chat", loaded: false, label: "Paperfull chat model", usedBy: ["paperfull-chat"] },
        { model: "arctic-embed", kind: "embedding", loaded: false, usedBy: ["pai-embedding"] },
      ] }],
      consumers: [
        { name: "paperfull-chat", runtime: "ollama", model: "qwen3:8b", label: "Paperfull chat model", purpose: "Paperfull chat model" },
        { name: "pai-embedding", runtime: "ollama", model: "arctic-embed", label: "PAI embedding", purpose: "memory search embeds new content" },
      ],
      duplicates: [],
      live: { at: 1, runtimes: [] },
    });
    const chat = h.split('<div class="mcard').find((c) => c.includes('data-model="qwen3:8b"'))!;
    expect(chat).toContain("Paperfull chat model · used by paperfull-chat (Paperfull chat model)");
    expect(chat).not.toContain("embedding backend");
    expect(chat).not.toContain("pai-embedding");
    expect(chat).toContain('<span class="mt-value">1</span>');
  });
  it("a worker chip shows the job label with its state word, never a raw unknown field", () => {
    const h = modelsHtml({
      at: "x",
      runtimes: [{ name: "gyro-m", kind: "mlx", status: "running", port: 1, users: [], models: [{ model: "m", kind: "coding", loaded: true, memoryMb: 5000, usedBy: [] }] }],
      duplicates: [],
      live: { at: 1, runtimes: [{ name: "gyro-m", live: { engine: {}, cap: 2, queued: 0, workers: [
        { id: "j1", label: "C2d #8 one colour per model", state: "running" },
        { id: "j2", label: "other job", state: "queued" },
      ] }, history: {} }] },
    });
    expect(h).not.toContain("?</b>");
    expect(h).not.toMatch(/<b>\?<\/b>/);
    expect(h).toContain("C2d #8 one colour per model <span class=\"dim\">running</span>");
    expect(h).toContain("other job <span class=\"warn\">queued</span>");
  });
  it("a running worker chip without class or session shows '<label> · running' style, no '?'", () => {
    const h = modelsHtml({
      at: "x",
      runtimes: [{ name: "gyro-m", kind: "mlx", status: "running", port: 1, users: [], models: [{ model: "m", kind: "coding", loaded: true, memoryMb: 5000, usedBy: [] }] }],
      duplicates: [],
      live: { at: 1, runtimes: [{ name: "gyro-m", live: { engine: {}, cap: 2, queued: 0, workers: [
        { id: "j1", label: "kill: background owner recognised", session: "?", state: "running" },
      ] }, history: {} }] },
    });
    expect(h).toContain('kill: background owner recognised <span class="dim">running</span>');
    expect(h).not.toContain("?");
  });
  it("two consumers on one runtime without descriptions: no borrowed runtime label, one used-by with the own name", () => {
    const h = modelsHtml({
      at: "x",
      runtimes: [{ name: "ollama", kind: "ollama", label: "PAI's embedding backend runs here", status: "running", port: 11434, users: ["paperfull-chat", "pai-embedding"], models: [
        { model: "qwen3:8b", kind: "chat", loaded: false, usedBy: ["paperfull-chat"] },
        { model: "arctic-embed", kind: "embedding", loaded: false, usedBy: ["pai-embedding"] },
      ] }],
      consumers: [
        { name: "paperfull-chat", runtime: "ollama", model: "qwen3:8b", label: "paperfull-chat" },
        { name: "pai-embedding", runtime: "ollama", model: "arctic-embed", label: "PAI embedding", purpose: "memory search embeds new content" },
      ],
      duplicates: [],
      live: { at: 1, runtimes: [] },
    });
    const chat = h.split('<div class="mcard').find((c) => c.includes('data-model="qwen3:8b"'))!;
    const emb = h.split('<div class="mcard').find((c) => c.includes('data-model="arctic-embed"'))!;
    expect(chat).not.toContain("embedding backend");
    expect(chat).toContain(">used by paperfull-chat</div>");
    expect(chat).not.toContain("paperfull-chat (paperfull-chat)");
    expect(emb).toContain("memory search embeds new content · used by pai-embedding (memory search embeds new content)");
    expect(emb).not.toContain("paperfull-chat");
  });
  it("a runtime note is the runtime chip's title only: never a body line of any consumer card", () => {
    const h = modelsHtml({
      at: "x",
      runtimes: [{ name: "ollama", kind: "ollama", status: "running", port: 11434, users: ["paperfull-chat", "pai-embedding"], models: [
        { model: "qwen3:8b", kind: "chat", loaded: false, usedBy: ["paperfull-chat"] },
        { model: "arctic-embed", kind: "embedding", loaded: false, usedBy: ["pai-embedding"] },
      ] }],
      runtimeCommands: { ollama: { start: "ollama serve", note: "local Ollama server; loads a model on the first request" } },
      consumers: [
        { name: "paperfull-chat", runtime: "ollama", model: "qwen3:8b", label: "Paperfull chat", purpose: "Paperfull chat" },
        { name: "pai-embedding", runtime: "ollama", model: "arctic-embed", label: "PAI embedding", purpose: "memory search embeds new content" },
      ],
      duplicates: [],
      live: { at: 1, runtimes: [] },
    });
    const chat = h.split('<div class="mcard').find((c) => c.includes('data-model="qwen3:8b"'))!;
    const emb = h.split('<div class="mcard').find((c) => c.includes('data-model="arctic-embed"'))!;
    // the note is nowhere in either card's body (the header chip may carry it)
    expect(chat.slice(chat.indexOf('class="mbody"'))).not.toContain("local Ollama server; loads a model on the first request");
    expect(emb.slice(emb.indexOf('class="mbody"'))).not.toContain("local Ollama server; loads a model on the first request");
    expect(h).not.toContain('class="mnote"');
    // the runtime chip in each card header carries it as the title
    expect(chat).toContain('<span class="badge" title="local Ollama server; loads a model on the first request">ollama :11434</span>');
    expect(emb).toContain('<span class="badge" title="local Ollama server; loads a model on the first request">ollama :11434</span>');
  });
  it("the tile grip sits in the tile's top-right corner, never inline with the value", () => {
    const tile = new Function("esc", `${COCKPIT_HTML.match(/function metricSpark[\s\S]*?\n\}/)![0]}\n${COCKPIT_HTML.match(/function metricTile[\s\S]*?\n\}/)![0]}; return metricTile;`)((s: unknown) => String(s ?? ""))({ title: "Speed", value: "58.5", unit: "t/s", sub: "", series: [] }) as string;
    expect(tile).not.toMatch(/<span class="mt-value"><span class="tgrip"/);
    // the tile opens with its stable drag id, then the grip
    expect(tile).toMatch(/^<div class="mt" data-tid="speed" data-tname="Speed" data-tval="[^"]*"><span class="tgrip" data-tgrip/);
    expect(COCKPIT_HTML).toMatch(/\.tgrip\{position:absolute;top:\d+px;right:\d+px;opacity:0/);
    expect(COCKPIT_HTML).toMatch(/@media\(hover:none\)\{\.tgrip\{opacity:\.5\}\}/);
    expect(COCKPIT_HTML).toMatch(/\.mt:hover \.tgrip/);
  });
  const inv = {
    at: "2026-10-19T18:00:00.000Z",
    runtimes: [
      { name: "gyro-m", kind: "strata", status: "running", port: 8035, label: "Coding workers (gyro-m)", users: ["worker:flashnext-iq3"], models: [{ model: "flash-next", kind: "coding", loaded: true, memoryMb: 50000, mappedMb: 40030, usedBy: ["worker:flashnext-iq3"] }] },
      { name: "ollama", kind: "ollama", status: "idle", port: 11434, users: ["pai-embedding", "paperfull-llm"], models: [
        { model: "huggingface.co/keisuke-miyako/multilingual-e5-base-gguf-f16", kind: "embedding", loaded: true, memoryMb: 600, sizeMb: 600, usedBy: ["pai-embedding"] },
        { model: "qwen3:8b", kind: "chat", loaded: false, sizeMb: 4792, usedBy: ["paperfull-llm"] },
      ] },
      { name: "coder", kind: "strata", status: "stopped", port: 8036, users: ["worker:gyro"], models: [] },
    ],
    duplicates: [],
    runtimeCommands: { ollama: { start: "ollama serve", stop: "kill", note: "local Ollama server; loads a model on the first request" } },
    consumers: [
      { name: "pai-embedding", runtime: "ollama", purpose: "memory search embeds new content here", label: "PAI memory embeddings", model: "huggingface.co/keisuke-miyako/multilingual-e5-base-gguf-f16" },
      { name: "paperfull-chat", runtime: "ollama", purpose: "Paperfull chat", label: "Paperfull chat", model: "qwen3:8b" },
    ],
    live: {
      at: 1,
      runtimes: [
        { name: "gyro-m", status: "running", live: { engine: { decode: 73.4, prefill: 715, phase: "idle", parked: 2, slots: 4, reusedPct: 90, lastDecode: 73.4, lastPrompt: 155000, lastReused: 150000, lastPromptMs: 5000, lastUsed: 155500, gpuMemUsed: 1530000000, gpuMemTotal: 115964116992, maxContext: 262144, liveUsed: null }, rssMb: 36148, workers: [{ id: "w-1", label: "fix-x", session: "PAI", state: "running" }], queued: 2, cap: 1, conversationSlots: 4, sparesReady: 1, sparesConfig: 1 }, history: { decode: [70, null, 73.4], prefill: [700, null, 715], memoryMb: [49000, 50000, 50000], queued: [0, 1, 2], pressurePct: [60, 61, 62] } },
        { name: "ollama", status: "idle", live: { engine: null, workers: [], queued: 0, cap: 1, conversationSlots: null, sparesReady: 0, sparesConfig: 1 }, history: { decode: [], prefill: [], memoryMb: [], queued: [], pressurePct: [] } },
      ],
    },
  };

  it("one foldable card per consumer runtime: header, kind badge, status dot, four metric tiles", () => {
    const h = modelsHtml(inv);
    // one card per consumer model: ollama hosts two (embeddings + chat) -> 4 cards
    expect((h.match(/<div class="mcard/g) ?? []).length).toBe(4);
    // purpose first: the title is the consumer's purpose, the model id is grey secondary text
    expect(h).toContain('<b title="flash-next">Coding workers (gyro-m)</b><button class="lblbtn"');
    // kind differs from the name: one separate kind chip, the name shows once
    expect(h).toContain('<span class="badge">strata</span><span class="badge">gyro-m :8035</span>');
    expect(h).toContain("gyro-m :8035");
    expect(h).toContain("used by flashnext-iq3 (worker provider)");
    expect(h).toContain('<span class="rt-dot"></span>');
    expect(h).toContain('<span class="rt-dot idle"></span>');
    for (const t of ["Speed", "Memory", "Workers", "Conversation cache"]) expect(h).toContain(t);
    expect(h).toContain("73.4");
    expect(h).toContain("715");
    expect(h).toContain("Decode last request");
    expect(h).toContain("Prefill last request");
    expect(h).toContain("35.3<small>GB</small>");
    // every GB on the card is binary (1024^3), the same rounding as Strata's monitor:
    // 115964116992 bytes = 108 GB (not 115), 1.53e9 bytes = 1.4 GB (not 1.5)
    expect(h).toContain("RAM 35.3 GB · GPU 1.4 / 108 GB");
    expect(h).toContain("39.1 GB file mapped");
    expect(h).toContain("reused 90.0% of prompt tokens");
    expect(h).toContain("2<small>/ 4</small>");
    expect(h).toContain("59% · 156k / 256K");
    expect(h).toContain("queued 2");
    expect(h).toContain("cap 1 · queued 2 · slots 4 · spares 1");
    expect(h).toContain("machine pressure 62%");
  });
  it("a generating engine reads like Strata's monitor: Decode now / Prefill this request, context from the running request", () => {
    const h = modelsHtml({
      at: "x",
      runtimes: [{ name: "strata", kind: "strata", status: "running", port: 8035, users: [], models: [{ model: "m", kind: "coding", loaded: true, memoryMb: 50000, usedBy: [] }] }],
      live: { at: 1, runtimes: [{ name: "strata", status: "running", live: { engine: { decode: 78.04, prefill: 101.8, phase: "generating", parked: 4, slots: 4, reusedPct: 98.8, lastDecode: 50.9, lastPrompt: null, lastReused: null, lastPromptMs: null, lastUsed: null, gpuMemUsed: 45576978432, gpuMemTotal: 115448725504, maxContext: 262144, liveUsed: 155000 }, rssMb: 36148, workers: [], queued: 0, cap: 1, conversationSlots: 4, sparesReady: 0, sparesConfig: 1 }, history: {} }] },
    });
    expect(h).toContain("78.0"); // decode: 1 decimal, as Strata
    expect(h).toContain("102"); // prefill: integer, as Strata
    expect(h).toContain("Decode now");
    expect(h).toContain("Prefill this request");
    expect(h).toContain("59% · 155k / 256K");
    expect(h).toContain('class="mt-bar"');
    expect(h).toMatch(/mt-bar[^>]*><i style="width:59\.1%"/);
  });
  it("GB on the Memory tile is binary (1024^3) like the engine: 115964116992 bytes render as 108, 1.53e9 as 1.4", () => {
    const h = modelsHtml({
      at: "x",
      runtimes: [{ name: "strata", kind: "strata", status: "running", port: 8035, users: [], models: [{ model: "m", kind: "coding", loaded: true, memoryMb: 1, usedBy: [] }] }],
      live: { at: 1, runtimes: [{ name: "strata", status: "running", live: { engine: { decode: null, prefill: null, phase: "idle", parked: null, slots: null, reusedPct: null, lastDecode: null, lastPrompt: null, lastReused: null, lastPromptMs: null, lastUsed: null, gpuMemUsed: 1530000000, gpuMemTotal: 115964116992, maxContext: null, liveUsed: null }, rssMb: null, workers: [], queued: 0, cap: null, conversationSlots: null, sparesReady: 0, sparesConfig: 0 }, history: {} }] },
    });
    expect(h).toContain("GPU 1.4 / 108 GB");
    expect(h).not.toContain("115");
    expect(h).not.toContain("1.5");
  });
  it("the context fill is the secondary value with a small bar on the Conversation cache tile", () => {
    const h = modelsHtml(inv);
    const cache = h.slice(h.indexOf("Conversation cache"));
    expect(cache).toContain('class="mt-fill"');
    expect(cache).toContain("59% · 156k / 256K");
    expect(cache).toContain('style="width:59.3%"');
  });
  it("sparklines carry the history; a runtime with a loaded model keeps all four tiles and – only where the engine does not report", () => {
    const h = modelsHtml(inv);
    const strata = h.slice(h.indexOf('<b title="flash-next">Coding workers (gyro-m)</b>'), h.indexOf("<b title=\"huggingface.co/"));
    expect(strata.match(/<path class="line/g)!.length).toBeGreaterThanOrEqual(4);
    const ollama = h.slice(h.indexOf('<b title="huggingface.co/keisuke-miyako/multilingual-e5-base-gguf-f16">PAI memory embeddings</b>'), h.indexOf('<b title="qwen3:8b">'));
    for (const t of ["Speed", "Memory", "Workers", "Conversation cache"]) expect(ollama).toContain(t);
    expect(ollama).toContain("–");
    expect(ollama).toContain("prompt reuse not reported");
    expect(ollama).toContain("spares 0");
  });
  it("sparklines never break: a null point is interpolated between neighbours into one continuous line; leading/trailing nulls drop", () => {
    const spark = new Function("esc", `${COCKPIT_HTML.match(/function metricSpark[\s\S]*?\n\}/)![0]}; return metricSpark;`)((s: unknown) => String(s ?? "")) as (s: Array<{ data: Array<number | null> }>) => string;
    const svg = spark([{ data: [10, null, 20] }]);
    // one continuous line: a single path, three points, the middle one interpolated at 15
    expect(svg.match(/<path class="line/g)!.length).toBe(1);
    const pts = svg.match(/class="line[^"]*"[^>]*d="M([\d.,L-]+)"/)![1].split("L");
    expect(pts.length).toBe(3);
    expect(pts[1]).toBe("50.0,9.0"); // x mid, y = 30 - 15/20*28 (interpolated 15 between 10 and 20)
    // leading/trailing nulls drop; the line spans the two real points
    const trimmed = spark([{ data: [null, 10, 20, null] }]);
    const tpts = trimmed.match(/class="line[^"]*"[^>]*d="M([\d.,L-]+)"/)![1].split("L");
    expect(tpts.length).toBe(2);
    // x keeps the full-array scale (n=4): points 1 and 2 sit at 33.3 and 66.7
    expect(tpts[0].startsWith("33.3")).toBe(true);
    expect(tpts[1].startsWith("66.7")).toBe(true);
    // all-null series draws nothing
    expect(spark([{ data: [null, null] }])).toBe("");
  });
  it("a long model id renders its short name (last path segment) with the full id in title", () => {
    const h = modelsHtml(inv);
    expect(h).toContain('<span class="mid" title="huggingface.co/keisuke-miyako/multilingual-e5-base-gguf-f16">multilingual-e5-base-gguf-f16</span>');
    expect(h).not.toContain("<b>huggingface.co/");
    expect(h).not.toContain("<b title=\"huggingface.co/keisuke-miyako/multilingual-e5-base-gguf-f16\">huggingface.co/");
  });
  it("purpose first: the card title is the consumer's label, the model id grey secondary; without a label the consumer name, then the model id", () => {
    const h = modelsHtml(inv);
    // labels from the payload's consumers (config only), one per model: two ollama cards
    expect((h.match(/class="mcard/g) ?? []).length).toBe(4);
    expect(h).toContain('<b title="huggingface.co/keisuke-miyako/multilingual-e5-base-gguf-f16">PAI memory embeddings</b>');
    expect(h).toContain('<b title="qwen3:8b">Paperfull chat</b><button class="lblbtn"');
    // no label anywhere: the consumer name is the title, the model id stays grey secondary text
    const bare = modelsHtml({
      at: "x",
      runtimes: [{ name: "rt", kind: "rt", status: "idle", port: 9, users: [], models: [{ model: "m-1", kind: "chat", loaded: false, usedBy: ["paperfull-chat"] }] }],
      live: { at: 1, runtimes: [] },
    });
    expect(bare).toContain('<b title="m-1">paperfull-chat</b><button class="lblbtn"');
    // no label and no consumer: the short model id is the title
    const solo = modelsHtml({
      at: "x",
      runtimes: [{ name: "rt", kind: "rt", status: "idle", port: 9, users: [], models: [{ model: "sub/m-2", kind: "chat", loaded: false, usedBy: [] }] }],
      live: { at: 1, runtimes: [] },
    });
    expect(solo).toContain('<b title="sub/m-2">m-2</b><button class="lblbtn"');
  });
  it("one card per consumer model: two labelled models on one runtime are two cards, each with its own fold id", () => {
    const two = modelsHtml({
      at: "x",
      runtimes: [{ name: "ollama", kind: "ollama", status: "idle", port: 11434, users: ["pai-embedding", "paperfull-chat"], models: [
        { model: "arctic-embed", kind: "embedding", loaded: false, sizeMb: 600, usedBy: ["pai-embedding"], label: "PAI memory embeddings" },
        { model: "qwen3:8b", kind: "chat", loaded: false, sizeMb: 4792, usedBy: ["paperfull-chat"], label: "Paperfull chat" },
      ] }],
      duplicates: [],
      live: { at: 1, runtimes: [] },
    });
    expect((two.match(/<div class="mcard/g) ?? []).length).toBe(2);
    expect(two).toContain('data-rt="ollama" data-model="arctic-embed"');
    expect(two).toContain('data-rt="ollama" data-model="qwen3:8b"');
    expect(two).toContain('<b title="arctic-embed">PAI memory embeddings</b>');
    expect(two).toContain('<b title="qwen3:8b">Paperfull chat</b>');
  });
  it("an idle runtime with nothing loaded is a compact card: header + Memory/size + users, no empty Speed/cache tiles", () => {
    const h = modelsHtml({
      at: "2026-10-19T18:00:00.000Z",
      runtimes: [{ name: "docker-model-runner", kind: "docker", status: "idle", port: 8090, users: ["worker:x"], models: [{ model: "qwen3:8b", kind: "chat", loaded: false, sizeMb: 4792 }] }],
      live: { at: 1, runtimes: [] },
    });
    expect((h.match(/<div class="mcard/g) ?? []).length).toBe(1);
    expect(h).toContain("Memory / size");
    expect(h).toContain("4.7 GB");
    expect(h).toContain("Users");
    expect(h).toContain("used by x (worker provider)");
    expect(h).not.toContain("Conversation cache");
    expect(h).not.toContain("Speed");
    expect(h).not.toContain("–");
  });
  it("the runtime name never repeats: a kind equal to the name (or name:port) shows no kind chip", () => {
    const h = modelsHtml(inv);
    // strata kind on a runtime named gyro-m: one kind chip; the name appears once in the header
    const strataHead = h.slice(h.indexOf('<b title="flash-next">Coding workers (gyro-m)</b>'), h.indexOf('<div class="rt-sub'));
    expect(strataHead).toContain('<span class="badge">strata</span><span class="badge">gyro-m :8035</span>');
    expect(strataHead).not.toContain('<span class="badge">gyro-m :8035</span><span class="badge">gyro-m<');
    const dup = modelsHtml({
      at: "x",
      runtimes: [{ name: "docker-model-runner", kind: "docker-model-runner", status: "idle", port: 8090, users: [], models: [{ model: "qwen3:8b", kind: "chat", loaded: false, sizeMb: 4792 }] }],
      live: { at: 1, runtimes: [] },
    });
    // kind equals the runtime name: no kind chip at all, the name shows once in the header
    const dupHead = dup.slice(dup.indexOf('<div class="mhead"'), dup.indexOf('<div class="mbody"'));
    expect((dupHead.match(/<span class="badge">[^<]*<\/span>/g) ?? []).length).toBe(2); // runtime chip + status chip, no kind chip
    expect(dupHead).toContain('<span class="badge">docker-model-runner :8090</span>');
    expect(dupHead).not.toContain('<span class="badge">docker-model-runner</span><span class="badge">docker-model-runner');
    const fold = modelsHtml({
      at: "x",
      runtimes: [{ name: "e5", kind: "e5 :8090", status: "idle", port: 8090, users: [], models: [{ model: "qwen3:8b", kind: "chat", loaded: false, sizeMb: 4792 }] }],
      live: { at: 1, runtimes: [] },
    });
    expect(fold).toContain('<span class="badge">e5 :8090</span>');
    expect(fold).not.toContain('<span class="badge">e5 :8090</span><span class="badge">e5 :8090');
  });
  it("worker chips name the sessions with workers on the runtime", () => {
    const h = modelsHtml(inv);
    expect(h).toContain("fix-x");
    expect(h).toContain("<b>PAI</b>");
  });
  it("every runtime is a card — a stopped one with consumers reads red down — <consumer> cannot work; no tables, no chip rows", () => {
    const h = modelsHtml(inv);
    expect(h).not.toContain("<table");
    expect(h).not.toContain('class="tw"');
    expect(h).not.toContain("<details");
    expect(h).toContain('class="mcard down"');
    expect(h).toContain("coder :8036 down — gyro (worker provider) cannot work");
    expect(h).toContain('<span class="rt-dot down"></span>');
    expect(h).toContain('<span class="badge bad">down</span>');
    expect(h).not.toContain("not loaded:");
    // no duplicates line for different models on different runtimes
    expect(h).not.toContain("duplicates:");
    // no chip row of stopped runtimes: each one is a card of its own
    expect(h).not.toContain('class="rt-chips dim"');
  });
  it("the PAI embedding consumer shows on its runtime's card and names what it needs the runtime for", () => {
    const h = modelsHtml(inv);
    expect(h).toContain("pai-embedding (memory search embeds new content here)");
    // PAI's embedding runtime down: the card says memory search cannot embed
    const dead = modelsHtml({
      at: "x",
      runtimes: [{ name: "ollama", kind: "ollama", status: "stopped", port: 11434, users: [], models: [] }],
      consumers: [{ name: "pai-embedding", runtime: "ollama", purpose: "memory search embeds new content here" }],
      runtimeCommands: { ollama: { start: "ollama serve" } },
      live: { at: 1, runtimes: [] },
    });
    expect(dead).toContain("ollama :11434 down — pai-embedding (memory search embeds new content here) cannot work");
    expect(dead).toContain('class="mcard down"');
  });
  it("start/stop buttons come from the configured commands only: no command, no button; inline confirm, no dialogs", () => {
    const h = modelsHtml(inv);
    // gyro-m and coder have no configured commands: no runtime buttons on their cards
    const gyro = h.slice(h.indexOf('data-rt="gyro-m"'), h.indexOf('data-rt="ollama"'));
    expect(gyro).not.toContain('data-a="runtime"');
    const coder = h.slice(h.indexOf('data-rt="coder"'));
    expect(coder).not.toContain('data-a="runtime"');
    expect(h).not.toMatch(/\balert\(|\bconfirm\(|\bprompt\(/);
  });
  it("only the applicable button shows: running/idle -> stop alone, stopped -> start alone; never a disabled twin", () => {
    const h = modelsHtml(inv);
    // ollama is idle with start+stop configured: stop only, no start (not even disabled)
    // ollama serves two consumers here: the stop names the other one and asks for a second click
    expect(h).toContain('data-a="runtime" data-t="ollama" data-v="stop" data-confirm="stop ollama: also ');
    expect(h).not.toContain('data-v="start"');
    const stopped = modelsHtml({
      at: "x",
      runtimes: [{ name: "ollama", kind: "ollama", status: "stopped", port: 11434, users: ["pai-embedding"], models: [] }],
      runtimeCommands: { ollama: { start: "ollama serve", stop: "kill" } },
      live: { at: 1, runtimes: [] },
    });
    expect(stopped).toContain('data-a="runtime" data-t="ollama" data-v="start">start</button>');
    expect(stopped).not.toContain("starts ollama");
    expect(stopped).not.toContain('data-v="stop"');
    // no disabled runtime buttons anywhere on the cards
    expect(h).not.toMatch(/data-a="runtime"[^>]*disabled/);
    // right-aligned in the header; the memory/count text is a separate element
    expect(COCKPIT_HTML).toMatch(/\.mhead \.act\{[^}]*margin-left:auto/);
    const oc = h.slice(h.indexOf('data-rt="ollama"'));
    const head = oc.slice(0, oc.indexOf('<div class="mbody"'));
    expect(head.indexOf('class="act')).toBeGreaterThan(-1);
    expect(head.indexOf('class="act')).toBeLessThan(head.indexOf('<span class="num">'));
  });
  it("an idle runner reads available (loads on first request), never idle or stopped", () => {
    const h = modelsHtml(inv);
    expect(h).toContain('<span class="badge">available (loads on first request)</span>');
    expect(h).not.toContain(">idle<");
    expect(h).not.toContain(">stopped<");
  });
  it("fold markup: a header button with aria-expanded and a body div; CSS folds the body unless the card is open", () => {
    const h = modelsHtml(inv);
    expect((h.match(/<div class="mhead" role="button" tabindex="0" aria-expanded="false">/g) ?? []).length).toBe(4);
    expect((h.match(/<div class="mbody">/g) ?? []).length).toBe(4);
    expect(COCKPIT_HTML).toMatch(/\.mbody\{[^}]*display:none/);
    expect(COCKPIT_HTML).toMatch(/\.mcard\.open \.mbody\{display:flex\}/);
    expect(COCKPIT_HTML).toContain('MCOLLAPSE_KEY="pai.cockpit.models.folded"');
    // default: a running coding runtime carries data-def="coding", everything else "other"
    expect(h).toContain('data-rt="gyro-m" data-model="flash-next" data-def="coding"');
    expect(h).toContain('data-rt="ollama" data-model="huggingface.co/keisuke-miyako/multilingual-e5-base-gguf-f16" data-def="other"');
    expect(h).toContain('data-rt="coder" data-model="" data-def="other"');
    // the whole header line is the toggle: a real <button>, so Enter/Space fire a click natively
    expect(COCKPIT_HTML).toMatch(/<div class="mhead" role="button" tabindex="0" aria-expanded="false">/);
    expect(COCKPIT_HTML).toMatch(/\.mhead:focus-visible\{outline:2px solid var\(--acc\)/);
  });
  it("PAI's embedding is its own card titled from config, even when the runtime lists the model with a :latest tag", () => {
    const h = modelsHtml({
      at: "x",
      runtimes: [{ name: "ollama", kind: "ollama", status: "running", port: 11434, users: ["pai-embedding"], models: [{ model: "arctic-embed-m-v1.5-f16:latest", kind: "embedding", loaded: true, sizeMb: 300, usedBy: ["pai-embedding"] }] }],
      consumers: [{ name: "pai-embedding", runtime: "ollama", purpose: "memory search", label: "PAI memory embeddings", model: "arctic-embed-m-v1.5-f16" }],
      live: { at: 1, runtimes: [] },
    });
    expect(h).toContain("<b ");
    expect(h).toContain(">PAI memory embeddings</b>");
    expect(h).toContain('data-rt="ollama" data-model="arctic-embed-m-v1.5-f16:latest"');
    // runtime lists nothing: the consumer still gets its card
    const none = modelsHtml({ at: "x", runtimes: [{ name: "ollama", kind: "ollama", status: "running", port: 11434, users: [], models: [] }], consumers: [{ name: "pai-embedding", runtime: "ollama", purpose: "m", label: "PAI memory embeddings", model: "arctic-embed-m-v1.5-f16" }], live: { at: 1, runtimes: [] } });
    expect(none).toContain(">PAI memory embeddings</b>");
  });
  it("available-idle is neutral (green outline), never the warning colour; the buttons sit inside the header", () => {
    expect(COCKPIT_HTML).toMatch(/\.rt-dot\.idle\{[^}]*var\(--ok\)/);
    expect(COCKPIT_HTML).not.toMatch(/\.rt-dot\.idle\{[^}]*var\(--warn\)/);
    const idle = modelsHtml({
      at: "x",
      runtimes: [{ name: "docker-model-runner", kind: "docker-model-runner", status: "idle", users: [], models: [{ model: "ai/x", kind: "chat", loaded: false, sizeMb: 100, usedBy: [] }] }],
      runtimeCommands: { "docker-model-runner": { start: "docker model run", stop: "docker model unload" } },
      live: { at: 1, runtimes: [] },
    });
    const head = idle.slice(idle.indexOf('<div class="mhead"'), idle.indexOf('<div class="mbody"'));
    expect(head).toContain('data-v="start">load</button>');
    expect(head).not.toContain(">stop<");
    expect(head.indexOf('class="act')).toBeLessThan(head.indexOf('<span class="num">'));
    // no <button> nested in another <button>: the header is not itself a button element
    expect(head).not.toMatch(/<button class="mhead"/);
    const loaded = modelsHtml({
      at: "x",
      runtimes: [{ name: "docker-model-runner", kind: "docker-model-runner", status: "running", users: [], models: [{ model: "ai/x", kind: "chat", loaded: true, memoryMb: 1000, usedBy: [] }] }],
      runtimeCommands: { "docker-model-runner": { start: "a", stop: "b" } },
      live: { at: 1, runtimes: [] },
    });
    // no other consumer on this runtime: the stop/unload is one click, no confirm
    expect(loaded).toContain('data-v="stop">unload</button>');
  });
  it("the grid follows the container at any width: cards share the row, tiles sit in one row, chips ellipsize", () => {
    expect(COCKPIT_HTML).toContain(".rt-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(420px,100%),1fr));gap:8px;min-width:0;align-items:stretch}");
    expect(COCKPIT_HTML).toContain(".rt-tiles{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;min-width:0}");
    // four tiles in one row only when the card itself is wide; a balanced 2x2 below 720px,
    // one column under ~340px — explicit columns per range via a container query on the card, never 3+1
    expect(COCKPIT_HTML).toMatch(/\.rt-card\{[^}]*container-type:inline-size/);
    expect(COCKPIT_HTML).toMatch(/@container \(min-width:720px\)\{\.rt-tiles:not\(\.two\)\{grid-template-columns:repeat\(12,minmax\(0,1fr\)\)\}/);
    expect(COCKPIT_HTML).toMatch(/@container \(max-width:339px\)\{\.rt-tiles,\.rt-tiles\.two\{grid-template-columns:minmax\(0,1fr\)\}\.rt-tiles \.mt\{grid-column:auto\}\}/);
    // sparklines align at the bottom of every tile; value + unit never break apart
    expect(COCKPIT_HTML).toMatch(/\.mt-spark\{[^}]*margin-top:auto[^}]*\}/);
    expect(COCKPIT_HTML).toMatch(/\.mt-value\{[^}]*white-space:nowrap/);
    expect(COCKPIT_HTML).toMatch(/\.rt-card\{[^}]*min-width:0[^}]*max-width:100%/);
    // header on one line: the name ellipsises, chips stay inline; the used-by line ellipsises too
    expect(COCKPIT_HTML).toMatch(/\.rt-head\{[^}]*flex-wrap:nowrap\}/);
    expect(COCKPIT_HTML).toMatch(/\.rt-head b\{[^}]*overflow:hidden;text-overflow:ellipsis;white-space:nowrap\}/);
    expect(COCKPIT_HTML).toMatch(/\.rt-sub\{[^}]*overflow:hidden;text-overflow:ellipsis;white-space:nowrap\}/);
    // each chip is its own item, ellipsised, never wider than the card
    expect(COCKPIT_HTML).toMatch(/\.rt-chips\{[^}]*flex-wrap:wrap[^}]*min-width:0\}/);
    expect(COCKPIT_HTML).toMatch(/\.rt-chips \.chip\{[^}]*max-width:100%[^}]*overflow:hidden;text-overflow:ellipsis;white-space:nowrap\}/);
  });
  it("the models section polls live every 5 s on its own; the tile sits after the worker panel, before System", () => {
    expect(COCKPIT_HTML).toContain('needModels=has("models")');
    expect(COCKPIT_HTML).toContain("if(needModels)loadModels()");
    expect(COCKPIT_HTML).toContain("if(needModels)setInterval(loadModels,5000)");
    const i = (s: string) => COCKPIT_HTML.indexOf(s);
    expect(i("Models — runtimes")).toBeGreaterThan(i("Workers — running and waiting"));
    expect(i("Models — runtimes")).toBeLessThan(i("<h2>System"));
    const rl = COCKPIT_HTML.match(/function renderLimits[\s\S]*?\n\}\n/)![0];
    expect(rl).toContain('setHtml($("local"),lo');
    expect(rl).not.toContain("modelsHtml");
  });
});

describe("cockpit collapsible tiles", () => {
  const src = COCKPIT_HTML.match(/var COLLAPSE_KEY[\s\S]*?\n\}\n/)![0];
  const store: Record<string, string> = {};
  const localStorageStub = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
  };
  // a tiny DOM: sections with an h2; the fold button is created once and found on later passes
  function makeDom(cards: Array<{ id: string; title: string }>) {
    const nodes = cards.map((c) => {
      const btn: { type: string; className: string; attrs: Record<string, string>; innerHTML: string; title: string; onclick: null | (() => void); setAttribute: (k: string, v: string) => void } = {
        type: "", className: "", attrs: {}, innerHTML: "", title: "", onclick: null,
        setAttribute(k, v) { this.attrs[k] = v; },
      };
      const h2 = {
        textContent: c.title, firstChild: null,
        querySelector: (s: string) => (s === "button.fold" ? btn : null),
        insertBefore() { /* the page creates one; the stub hands back the card's own button */ },
      };
      const card: any = {
        id: c.id,
        classes: new Set<string>(),
        querySelector: (s: string) => (s === "h2" ? h2 : null),
        classList: {
          toggle(cl: string, on: boolean) { if (on) card.classes.add(cl); else card.classes.delete(cl); },
          contains(cl: string) { return card.classes.has(cl); },
        },
        h2, btn,
      };
      // the page's guard `if(!b.onclick)` must not skip the stub's handler
      Object.defineProperty(btn, "onclick", { value: null, writable: true, configurable: true, enumerable: true });
      return card;
    });
    const document = {
      querySelectorAll: (sel: string) => (sel === "main section.card" ? nodes : []),
      createElement: () => {
        const b: { type: string; className: string; attrs: Record<string, string>; innerHTML: string; title: string; onclick: null | (() => void); setAttribute: (k: string, v: string) => void; closest: () => unknown } = {
          type: "", className: "", attrs: {}, innerHTML: "", title: "", onclick: null,
          setAttribute(k, v) { this.attrs[k] = v; },
          closest: () => null,
        };
        return b;
      },
    };
    return { nodes, document };
  }
  const run = (cards: Array<{ id: string; title: string }>) => {
    const { nodes, document } = makeDom(cards);
    const fn = new Function("localStorage", "document", `${src}\nfunction secGrips(){}\napplyCollapse();return {collapsedSet:collapsedSet,saveCollapsed:saveCollapsed,applyCollapse:applyCollapse};`);
    return { api: fn(localStorageStub, document) as { collapsedSet: () => Record<string, number>; saveCollapsed: (s: Record<string, number>) => void; applyCollapse: () => void }, nodes };
  };
  beforeEach(() => { for (const k of Object.keys(store)) delete store[k]; });

  it("a click folds the tile and saves its id under pai.cockpit.collapsed", () => {
    const { nodes } = run([{ id: "sys", title: "System" }, { id: "models", title: "Models" }]);
    const btn = nodes[0].btn; // the created button is the card's own stub (closest → card)
    expect(nodes[0].classes.has("folded")).toBe(false);
    expect(btn.attrs["aria-expanded"]).toBe("true");
    btn.onclick!();
    expect(nodes[0].classes.has("folded")).toBe(true);
    expect(nodes[1].classes.has("folded")).toBe(false);
    expect(JSON.parse(store[COLLAPSE_KEY_TEST])).toEqual(["sys"]);
    expect(btn.attrs["aria-expanded"]).toBe("false");
  });

  it("the saved set is restored on load: collapsed tiles come back folded, the rest open", () => {
    store[COLLAPSE_KEY_TEST] = JSON.stringify(["models"]);
    const { nodes } = run([{ id: "sys", title: "System" }, { id: "models", title: "Models" }]);
    expect(nodes[0].classes.has("folded")).toBe(false);
    expect(nodes[1].classes.has("folded")).toBe(true);
  });

  it("the functions survive a broken or absent saved value", () => {
    store[COLLAPSE_KEY_TEST] = "{not json";
    const { api } = run([{ id: "a", title: "A" }]);
    expect(api.collapsedSet()).toEqual({});
    api.saveCollapsed({ a: 1, b: 1 });
    expect(JSON.parse(store[COLLAPSE_KEY_TEST])).toEqual(["a", "b"]);
  });

  it("auto-refresh never reopens a collapsed tile: render functions only set innerHTML", () => {
    // the collapse state lives only in localStorage + the .folded class; the
    // render* functions touch innerHTML of the tile's divs, never the class
    const renders = COCKPIT_HTML.match(/function render[A-Za-z]+\(\)\{[\s\S]*?\n\}/g)!;
    for (const r of renders) expect(r).not.toMatch(/classList|folded|applyCollapse/);
    expect(COCKPIT_HTML).toContain("setInterval(function(){load();loadSystem()},5000)");
    expect(COCKPIT_HTML).not.toMatch(/setInterval\([^)]*applyCollapse/);
  });
});

describe("cockpit model-card fold state", () => {
  const src = COCKPIT_HTML.match(/var MCOLLAPSE_KEY[\s\S]*?\n\}\n/)![0];
  const store: Record<string, string> = {};
  const localStorageStub = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
  };
  function makeDom(cards: Array<{ rt: string; model?: string; def: string; open: boolean }>) {
    const nodes = cards.map((c) => {
      const chev = { textContent: "" };
      const btn: { attrs: Record<string, string>; innerHTML: string; onclick: null | (() => void); setAttribute: (k: string, v: string) => void; querySelector: (s: string) => unknown } = {
        attrs: {}, innerHTML: "", onclick: null,
        setAttribute(k, v) { this.attrs[k] = v; },
        querySelector: () => chev,
      };
      const card: any = {
        attrs: { "data-rt": c.rt, "data-model": c.model ?? "", "data-def": c.def } as Record<string, string>,
        classes: new Set<string>(c.open ? ["open"] : []),
        getAttribute: (k: string) => card.attrs[k] ?? null,
        classList: {
          toggle(cl: string, on: boolean) { if (on) card.classes.add(cl); else card.classes.delete(cl); },
          contains(cl: string) { return card.classes.has(cl); },
        },
        querySelector: (s: string) => (s === ".mhead" ? btn : null),
        btn,
      };
      Object.defineProperty(btn, "onclick", { value: null, writable: true, configurable: true, enumerable: true });
      // the page's handler runs with the card as `this`; the stub invokes it the same way
      card.callClick = () => (btn.onclick as unknown as (this: unknown) => void).call(card);
      return card;
    });
    const document = { querySelectorAll: (sel: string) => (sel === ".mcard" ? nodes : []) };
    return { nodes, document };
  }
  const exec = (cards: Array<{ rt: string; model?: string; def: string; open: boolean }>) => {
    const { nodes, document } = makeDom(cards);
    const panel = { innerHTML: "", querySelectorAll: (sel: string) => (sel === ".mcard" ? nodes : []) };
    // a fresh stub per run: the fold handler is bound once per header button (`if(!b.onclick)`)
    const fn = new Function("localStorage", "document", "$", `${src}\napplyModelFold();return applyModelFold;`);
    const again = fn(localStorageStub, document, () => panel) as (this: unknown) => void;
    // the page re-runs the fold on every 5 s poll; the stub keeps its bound handlers across passes
    again.call(panel);
    return nodes;
  };
  beforeEach(() => { for (const k of Object.keys(store)) delete store[k]; });

  it("first render: a running coding runtime opens, everything else folds, and the state is saved per card id", () => {
    const nodes = exec([{ rt: "gyro-m", model: "flash-next", def: "coding", open: false }, { rt: "ollama", model: "qwen3:8b", def: "other", open: false }]);
    expect(nodes[0].classes.has("open")).toBe(true);
    expect(nodes[1].classes.has("open")).toBe(false);
    expect(JSON.parse(store["pai.cockpit.models.folded"])).toEqual(["ollama / qwen3:8b"]);
    expect(nodes[0].btn.attrs["aria-expanded"]).toBe("true");
    expect(nodes[1].btn.attrs["aria-expanded"]).toBe("false");
  });

  it("the saved state wins over the default on the next render", () => {
    store["pai.cockpit.models.folded"] = JSON.stringify(["gyro-m / flash-next", "ollama / qwen3:8b"]);
    const nodes = exec([{ rt: "gyro-m", model: "flash-next", def: "coding", open: true }, { rt: "ollama", model: "qwen3:8b", def: "other", open: false }]);
    expect(nodes[0].classes.has("open")).toBe(false);
    expect(nodes[1].classes.has("open")).toBe(false);
  });

  it("a header click toggles the card and persists it; a start/stop button click does not fold", () => {
    const nodes = exec([{ rt: "ollama", model: "qwen3:8b", def: "other", open: false }, { rt: "gyro-m", model: "flash-next", def: "coding", open: true }]);
    // the handler is bound to the header button itself (button semantics: Enter/Space fire a click)
    expect(typeof nodes[1].btn.onclick).toBe("function");
    // the click event of a start/stop button inside the header stops before the header
    const stop = new Function("wireAct", "postAction", `${ACT_STATE_SRC}\n${COCKPIT_HTML.match(/function wireAct[\s\S]*?\n\}\n/)![0]}; return wireAct;`)(() => {}, () => {}) as (el: unknown, cb?: unknown) => void;
    let stopped = false;
    const inner: Record<string, unknown> = { getAttribute: () => null, disabled: false, confirmed: false };
    const act = { querySelectorAll: () => [inner], querySelector: () => null, getAttribute: () => null };
    stop(act);
    (inner.onclick as (e: unknown) => void)({ stopPropagation: () => { stopped = true; } });
    expect(stopped).toBe(true);
    // fold the open coding card by clicking its header
    nodes[1].callClick();
    expect(nodes[1].classes.has("open")).toBe(false);
    expect(JSON.parse(store["pai.cockpit.models.folded"])).toEqual(["ollama / qwen3:8b", "gyro-m / flash-next"]);
    // re-open persists as absent from the folded list
    nodes[1].callClick();
    expect(nodes[1].classes.has("open")).toBe(true);
    expect(JSON.parse(store["pai.cockpit.models.folded"])).toEqual(["ollama / qwen3:8b"]);
  });

  it("two cards on one runtime fold independently (the card id carries the model)", () => {
    const nodes = exec([
      { rt: "ollama", model: "arctic-embed", def: "other", open: false },
      { rt: "ollama", model: "qwen3:8b", def: "other", open: false },
    ]);
    // both start folded; open the second: only its id leaves the folded list
    nodes[1].callClick();
    expect(nodes[0].classes.has("open")).toBe(false);
    expect(nodes[1].classes.has("open")).toBe(true);
    expect(JSON.parse(store["pai.cockpit.models.folded"])).toEqual(["ollama / arctic-embed"]);
    // open the first too, then fold the second again: the first stays open
    nodes[0].callClick();
    nodes[1].callClick();
    expect(nodes[0].classes.has("open")).toBe(true);
    expect(nodes[1].classes.has("open")).toBe(false);
    expect(JSON.parse(store["pai.cockpit.models.folded"])).toEqual(["ollama / qwen3:8b"]);
  });

  it("a card that left the inventory loses its saved fold state; a broken saved value survives", () => {
    store["pai.cockpit.models.folded"] = JSON.stringify(["gone / m", "ollama / qwen3:8b"]);
    const nodes = exec([{ rt: "ollama", model: "qwen3:8b", def: "other", open: false }]);
    expect(nodes[0].classes.has("open")).toBe(false);
    expect(JSON.parse(store["pai.cockpit.models.folded"])).toEqual(["ollama / qwen3:8b"]);
    store["pai.cockpit.models.folded"] = "{not json";
    const n2 = exec([{ rt: "ollama", model: "qwen3:8b", def: "other", open: false }]);
    expect(n2[0].classes.has("open")).toBe(false);
  });
});

describe("cockpit metric tile", () => {
  it("page carries metricTile and its CSS; it renders title, value, sub, secondary and svg paths", () => {
    expect(COCKPIT_HTML).toContain("function metricTile(");
    expect(COCKPIT_HTML).toMatch(/\.mt-spark\{[^}]*width:100%/);
    const src = [COCKPIT_HTML.match(/function metricSpark[\s\S]*?\n\}/)![0], COCKPIT_HTML.match(/function metricTile[\s\S]*?\n\}/)![0]].join("\n");
    const tile = new Function("esc", `${src}\nreturn metricTile;`)((s: unknown) => String(s ?? "")) as (o: unknown) => string;
    const html = tile({
      title: "Speed", icon: "S", value: "73.4", unit: "t/s", sub: "Decode now",
      secondary: { value: "715", unit: "t/s", sub: "Prefill this request" },
      series: [{ data: [1, 5, null, 3, 8] }, { data: [2, 2, 4, null, 6], tone: "warn" }],
    });
    for (const w of ["Speed", "73.4", "Decode now", "715", "Prefill this request", "viewBox=\"0 0 100 32\""]) expect(html).toContain(w);
    expect(html.match(/<path class="line[^>]* d="M/g)!.length).toBe(2);
    // a null point is interpolated: each series is one continuous path (no second M)
    expect(html).not.toMatch(/d="M[^"]*M/);
  });
  it("a fill renders a small bar and its text line between the values and the sparkline", () => {
    const src = [COCKPIT_HTML.match(/function metricSpark[\s\S]*?\n\}/)![0], COCKPIT_HTML.match(/function metricTile[\s\S]*?\n\}/)![0]].join("\n");
    const tile = new Function("esc", `${src}\nreturn metricTile;`)((s: unknown) => String(s ?? "")) as (o: unknown) => string;
    const html = tile({ title: "Conversation cache", value: 4, unit: "/ 4", sub: "reused 98.8% of prompt tokens", fill: { pct: 59.1, text: "59% · 155k / 256K" }, series: [] });
    expect(html).toContain('class="mt-fill"');
    expect(html).toContain('style="width:59.1%"');
    expect(html).toContain("59% · 155k / 256K");
    expect(html.indexOf("mt-fill")).toBeLessThan(html.indexOf("mt-spark"));
    expect(COCKPIT_HTML).toMatch(/\.mt-spark\{[^}]*margin-top:auto[^}]*\}/);
  });
});

describe("router.cockpit.sections", () => {
  it("a section not in the list is absent from the rendered page", () => {
    const html = cockpitHtml(["cloud", "workers"]);
    expect(html).toContain('data-section="cloud"');
    expect(html).toContain('data-section="workers"');
    expect(html).not.toContain('data-section="sessions"');
    expect(html).not.toContain('id="sessions"');
    expect(html).not.toContain("Cache hit ratio</h2>");
    expect(html.indexOf('data-section="cloud"')).toBeLessThan(html.indexOf('data-section="workers"'));
  });

  it("missing, empty or all-unknown list renders the full page", () => {
    expect(cockpitHtml()).toBe(COCKPIT_HTML);
    expect(cockpitHtml([])).toBe(COCKPIT_HTML);
    expect(cockpitHtml(["nope"])).toBe(COCKPIT_HTML);
  });
});

describe("cockpit folds and open lists survive a redraw", () => {
  const foldSrc = COCKPIT_HTML.match(/var MCOLLAPSE_KEY[\s\S]*?\n\}\n/)![0];
  const store: Record<string, string> = {};
  const ls = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } };
  beforeEach(() => { for (const k of Object.keys(store)) delete store[k]; });
  const card = (rt: string, def: string) => {
    const btn: any = { setAttribute() {}, querySelector: () => null };
    Object.defineProperty(btn, "onclick", { value: null, writable: true, configurable: true, enumerable: true });
    const c: any = {
      classes: new Set<string>(),
      getAttribute: (k: string) => ({ "data-rt": rt, "data-model": "", "data-def": def })[k] ?? null,
      classList: { toggle(cl: string, on: boolean) { if (on) c.classes.add(cl); else c.classes.delete(cl); }, contains: (cl: string) => c.classes.has(cl) },
      querySelector: (s: string) => (s === ".mhead" ? btn : null),
    };
    return c;
  };
  const fold = (get: () => any[]) => {
    const panel = { querySelectorAll: () => get() };
    return new Function("localStorage", "$", `${foldSrc}\nreturn applyModelFold;`)(ls, () => panel) as () => void;
  };

  it("an opened card stays open when the cards are re-rendered with the same data", () => {
    let cards = [card("a", "coding"), card("b", "other")];
    const apply = fold(() => cards);
    apply();
    expect(cards[1].classes.has("open")).toBe(false);
    cards[1].classList.toggle("open", true);
    store["pai.cockpit.models.folded"] = JSON.stringify([]); // what the header click persists
    cards = [card("a", "coding"), card("b", "other")]; // innerHTML rebuild: no "open" class
    apply();
    expect(cards[0].classes.has("open")).toBe(true);
    expect(cards[1].classes.has("open")).toBe(true);
  });

  it("a placeholder render (no cards) does not wipe the saved folds", () => {
    store["pai.cockpit.models.folded"] = JSON.stringify(["b"]);
    let cards: any[] = [];
    const apply = fold(() => cards);
    apply();
    expect(JSON.parse(store["pai.cockpit.models.folded"])).toEqual(["b"]);
    cards = [card("a", "coding"), card("b", "other")];
    apply();
    expect(cards[1].classes.has("open")).toBe(false);
    expect(cards[0].classes.has("open")).toBe(true);
  });

  it("an opened 'not loaded' details stays open across a Local block rebuild", () => {
    const helper = COCKPIT_HTML.match(/var downsOpen[\s\S]*?\n\}\n/)![0];
    const mk = () => {
      const d: any = { open: false, ontoggle: null, getAttribute: () => "nl" };
      return d;
    };
    let current = mk();
    const el = { querySelectorAll: () => [current] };
    const keep = new Function(`${helper}\nreturn keepDowns;`)() as (e: unknown) => void;
    keep(el);
    current.open = true;
    current.ontoggle();
    current = mk(); // innerHTML rebuild
    keep(el);
    expect(current.open).toBe(true);
  });

  it("every section gets a stable id from data-section, not its position", () => {
    expect(COCKPIT_HTML).toContain('c.id=c.getAttribute("data-section")?"sec-"+c.getAttribute("data-section"):"tile-"+i');
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

  it("gridBreakpointPx moves the card-collapse media query", () => {
    write({ gridBreakpointPx: 1234 });
    expect(cockpitHtml()).toContain("@media(max-width:1234px){.c8,.c6,.c4{grid-column:span 12}}");
  });

  it("minSectionPx moves the row-stacking threshold", () => {
    write({ minSectionPx: 420 });
    const html = cockpitHtml();
    expect(html).toContain("MINSEC=420");
    expect(html).toContain("section[data-section].stacked{grid-column:span 12!important}");
    expect(COCKPIT_HTML).toContain("MINSEC=380");
  });

  it("gaugeMinWidthPx and gaugeMaxWidthPx move the gauge tile widths", () => {
    write({ gaugeMinWidthPx: 150, gaugeMaxWidthPx: 160 });
    expect(cockpitHtml()).toMatch(/\.gauge\{[^}]*flex:1 1 150px[^}]*max-width:min\(160px,100%\)/);
  });

  it("providerTileMinPx moves the provider grid's min column width", () => {
    write({ providerTileMinPx: 300 });
    expect(cockpitHtml()).toContain(".pgrid>*{flex:1 1 300px;min-width:min(300px,100%)}");
  });

  it("runtimeCardMinPx moves the runtime grid's min column width", () => {
    write({ runtimeCardMinPx: 500 });
    expect(cockpitHtml()).toContain(".rt-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(500px,100%),1fr))");
  });

  it("tilesWideBreakpointPx and tilesWideCols move the metric-tile container query", () => {
    write({ tilesWideBreakpointPx: 800, tilesWideCols: 3 });
    expect(cockpitHtml()).toMatch(/@container \(min-width:800px\)\{\.rt-tiles:not\(\.two\)\{grid-template-columns:repeat\(9,minmax\(0,1fr\)\)\}\.rt-tiles:not\(\.two\) \.mt\{grid-column:span 3\}/);
  });

  it("tilesNarrowCols moves the metric-tile base column count", () => {
    write({ tilesNarrowCols: 3 });
    expect(cockpitHtml()).toContain(".rt-tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr))");
  });

  it("tilesOneColBreakpointPx moves the one-column container query", () => {
    write({ tilesOneColBreakpointPx: 400 });
    expect(cockpitHtml()).toMatch(/@container \(max-width:400px\)\{\.rt-tiles,\.rt-tiles\.two\{grid-template-columns:minmax\(0,1fr\)\}\.rt-tiles \.mt\{grid-column:auto\}\}/);
  });

  it("ringMinWidthPx moves the cache rings grid", () => {
    write({ ringMinWidthPx: 120 });
    expect(cockpitHtml()).toContain(".rings{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr))");
  });

  it("sessionTitleMaxWidthPx moves the sessions title column cap", () => {
    write({ sessionTitleMaxWidthPx: 600 });
    expect(cockpitHtml()).toContain("#sessions td:first-child span[title]{display:inline-block;max-width:min(600px,100%)");
  });

  it("sparkHeightPx moves the sparkline height and viewBox", () => {
    write({ sparkHeightPx: 40 });
    expect(cockpitHtml()).toContain(".mt-spark{display:block;width:100%;max-width:100%;height:40px");
    expect(cockpitHtml()).toContain('viewBox="0 0 100 40"');
  });

  it("sparkViewMaxPx moves the sparkline viewBox width and x scale", () => {
    write({ sparkViewMaxPx: 120 });
    expect(cockpitHtml()).toContain('viewBox="0 0 120 32"');
    expect(cockpitHtml()).toContain("i/(n-1)*120");
  });

  it("sparkPlotHeightPx and sparkPlotTopPx move the sparkline plot geometry", () => {
    write({ sparkPlotHeightPx: 24, sparkPlotTopPx: 26 });
    expect(cockpitHtml()).toContain("26-valAt(i)/max*24");
  });

  it("bigDonutSizePx moves the solo donut size", () => {
    write({ bigDonutSizePx: 200 });
    expect(cockpitHtml()).toContain("donut(dn?m.cacheRead/dn:0,200)");
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

  it("tokensChartWidthPx and tokensChartHeightPx move the tokens chart canvas", () => {
    write({ tokensChartWidthPx: 900, tokensChartHeightPx: 260 });
    expect(cockpitHtml()).toContain("twoToneModelBars($(\"series\"),labs,buckets,models,900,260)");
  });

  it("powerChartWidthPx and powerChartHeightPx move the power chart canvas", () => {
    write({ powerChartWidthPx: 800, powerChartHeightPx: 180 });
    expect(cockpitHtml()).toContain("lineChart($(\"power\"),ss.map(function(b){return label(b.t,sys.window)}),ss,PKEYS,800,180)");
  });

  it("dailyChartWidthPx and dailyChartHeightPx move the daily chart canvas", () => {
    write({ dailyChartWidthPx: 600, dailyChartHeightPx: 240 });
    expect(cockpitHtml()).toContain("ds,dm,600,240)");
  });

  it("dailyDays moves the daily header and the chart's day window", () => {
    write({ dailyDays: 21 });
    const html = cockpitHtml();
    expect(html).toContain("Tokens per day per model (21 d)");
    expect(html).toContain("DAILY_DAYS=21");
    expect(html).toContain("d.daily.days.slice(-DAILY_DAYS)");
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

  it("jobFirstDelayMs, jobPollMs and jobMaxTries move the job watcher", () => {
    write({ jobFirstDelayMs: 3000, jobPollMs: 6000, jobMaxTries: 60 });
    const html = cockpitHtml();
    expect(html).toContain("JOB_TRIES=60");
    expect(html).toContain("JOB_POLL=6000");
    expect(html).toContain("JOB_FIRST=3000");
  });

  it("serverCounterStaleSecs moves the prefix-cache age mark threshold", () => {
    write({ serverCounterStaleSecs: 90 });
    expect(cockpitHtml()).toContain("SRV_STALE_SEC=90");
    expect(cockpitHtml()).toContain("s.prefixCacheAgeSec>SRV_STALE_SEC");
  });

  it("foldDefaultKind moves the model-card fold default", () => {
    write({ foldDefaultKind: "chat" });
    const html = cockpitHtml();
    // the card markup: a running card with a coding model carries the configured kind
    expect(html).toContain('coding?"chat":"other"');
    // the fold logic: only a card whose data-def equals the configured kind opens
    expect(html).toContain('open=d==="chat"');
    // the shipped default still opens a running coding card and folds the rest
    expect(COCKPIT_HTML).toContain('coding?"coding":"other"');
    expect(COCKPIT_HTML).toContain('open=d==="coding"');
  });

  // colour thresholds (router.cockpit.layout): the rendered colour class follows a
  // temp-config override of each threshold; the shipped values stand in COCKPIT_HTML
  const thresholdHtml = (layout: Record<string, unknown>) => {
    // always write: an empty yaml file parses to null and blanks the whole layout,
    // so the shipped check writes a key that cannot change the thresholds
    write(Object.keys(layout).length ? layout : { gridBreakpointPx: 1000 });
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
    write(Object.keys(layout).length ? layout : { gridBreakpointPx: 1000 });
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

  it("errorWarn/errorBad move the error-rate colouring (totals strip, providers err%)", () => {
    const t = thresholdHtml({ errorWarn: 0.05, errorBad: 0.2 });
    expect(t.cls(0.06)).toBe("warn"); // warn at 0.06 now, bad at the shipped .1
    expect(t.cls(0.15)).toBe("warn"); // still warn at 0.15 (>= 0.05), bad only at the shipped .1
    expect(t.cls(0.25)).toBe("bad");
    expect(cockpitHtml()).toContain("cls(t.errors/Math.max(1,t.requests),ERROR_WARN,ERROR_BAD)");
    expect(cockpitHtml()).toContain("cls(e,ERROR_WARN,ERROR_BAD)");
    expect(COCKPIT_HTML).toContain("ERROR_WARN=0.02,ERROR_BAD=0.1");
    const shipped = thresholdHtml({});
    expect(shipped.cls(0.06)).toBe("warn");
    expect(shipped.cls(0.15)).toBe("bad"); // bad at the shipped .1, plain under the override's .2
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

  it("the page assigns colours once over the union of every model shown", () => {
    const render = COCKPIT_HTML.match(/function render\(\)\{[\s\S]*?\n\}\n/)![0];
    expect(render).toContain("d.byModel.forEach(function(m){um[m.model]=1})");
    expect(render).toContain("(d.speed||[]).forEach(function(r){um[r.model]=1})");
    expect(render).toContain("dm.forEach(function(m){um[m]=1})");
    expect(render).toContain("assignColors(Object.keys(um))");
    expect(COCKPIT_HTML).toContain("COLOR_PRUNE_DAYS=90");
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
    const bars = COCKPIT_HTML.match(/function stackedBars\([\s\S]*?\n\}\n/)![0];
    expect(bars).toContain("padL=padFor([fmtAxis(max)])");
    expect(bars).toContain("fmtAxis(max*g/3)");
    expect(COCKPIT_HTML.match(/function twoToneModelBars\([\s\S]*?\n\}\n/)![0]).toContain("padL=padFor([fmtAxis(max)])");
  });

  it("no legend item says idle compressed; the caption appears once, only when buckets were compressed", () => {
    expect(COCKPIT_HTML).not.toContain("idle compressed");
    const cap = COCKPIT_HTML.match(/function chartCap\([^\n]*\n/)![0];
    expect(cap).toContain("idle hours compressed");
    expect(COCKPIT_HTML).toContain('chartCap($("seriescap"),gap)');
    expect(COCKPIT_HTML).toContain('chartCap($("dailycap"),dgap)');
    // chartCap is called with the compressed flag: on writes the caption once, off clears it
    const el: any = { innerHTML: "" };
    new Function("el", `${SH}\n${cap}\nchartCap(el,true);`)(el);
    expect(el.innerHTML).toContain("idle hours compressed");
    expect(el.innerHTML).toContain('class="cap dim"');
    expect((el.innerHTML.match(/idle hours compressed/g) ?? []).length).toBe(1);
    new Function("el", `${SH}\n${cap}\nchartCap(el,false);`)(el);
    expect(el.innerHTML).toBe("");
  });

  it("the tokens legend is two captioned lines (kinds with weights, models) and the daily legend has no extra items", () => {
    const legendLine = new Function("esc", `${COCKPIT_HTML.match(/function legendLine\([^\n]*\n/)![0]}; return legendLine;`)((s: unknown) => String(s ?? "")) as (cap: string, items: string) => string;
    const line = legendLine("kinds", '<span><i style="background:#3b6fe0"></i>fresh input x1</span>');
    expect(line).toContain('class="lgline"');
    expect(line).toContain('class="lgcap"');
    expect(line).toContain("kinds");
    const render = COCKPIT_HTML.match(/function render\(\)\{[\s\S]*?\n\}\n/)![0];
    expect(render).toContain('legendLine("kinds"');
    expect(render).toContain('legendLine("models"');
    expect(render).toContain("x'+W[k[0]]");
    expect(render).toContain('chartCap($("seriescap"),gap)');
    expect(render).toContain('legend($("dlegend"),dm)');
    expect(render).not.toContain("idle compressed");
    expect(COCKPIT_HTML).toContain('<div id="seriescap"></div>');
    expect(COCKPIT_HTML).toContain('<div id="dailycap"></div>');
  });

  it("a ring is titled by the model's short name, the alias wins, the provider is the small second line", () => {
    const src = [
      COCKPIT_HTML.match(/function shortModel\([\s\S]*?\n\}\n/)![0],
      COCKPIT_HTML.match(/function ringName\([\s\S]*?\n\}\n/)![0],
    ].join("\n");
    const ringName = new Function("mdl", `${src}\nreturn ringName;`)({
      runtimes: [{ modelLabels: { "huggingface.co/org/qwen3:8b": "My Qwen" } }],
      consumers: [{ model: "glm-5.3", label: "Orchestrator" }],
    }) as (m: string) => string;
    expect(ringName("huggingface.co/org/qwen3:8b")).toBe("My Qwen");
    expect(ringName("glm-5.3")).toBe("Orchestrator");
    expect(ringName("huggingface.co/org/other-model")).toBe("other-model");
    const ringTiles = new Function(
      "mdl", "$", "esc", "donut", "emptyRing", "lowChips", "assignColors", "ringName", "ageMark", "lim", "LOW_REQ", "SRV_STALE_SEC",
      `function setHtml(el,h){el.innerHTML=h;return true}\n${src}\n${TH}\n${COCKPIT_HTML.match(/function ringTiles\([\s\S]*?\n\}\n/)![0]}\nreturn ringTiles;`
    )(
      { runtimes: [{ modelLabels: { "glm/glm-5.3": "Orch" } }], consumers: [] },
      () => ({ innerHTML: "" }),
      (s: unknown) => String(s ?? ""),
      () => "<svg></svg>",
      () => "<svg></svg>",
      () => "",
      () => {},
      (m: string) => (m === "glm/glm-5.3" ? "Orch" : m),
      () => "",
      {},
      5,
      60
    ) as (ms: Record<string, unknown>, servers: unknown[]) => string;
    const html = ringTiles(
      { a: { provider: "glm", model: "glm/glm-5.3", cacheRead: 80, cacheWrite: 10, input: 10, requests: 20 } },
      []
    );
    expect(html).toContain('<div class="n">Orch</div>');
    expect(html).toContain('<div class="s">glm · 20 req</div>');
  });
});

describe("cockpit refresh keeps the page still", () => {
  const helper = COCKPIT_HTML.match(/function dataKey[\s\S]*?\nfunction setHtml[\s\S]*?\n\}\n/)![0];
  function env(opts: { anchorTops?: number[]; onWrite?: () => void } = {}) {
    const calls = { scrollTo: [] as number[], writes: 0, focused: [] as unknown[] };
    const tops = opts.anchorTops ?? [-50, 100];
    let step = 0;
    let scrollY = 0;
    // the first card at or below the viewport top; its top follows the write step, less the scroll applied since
    const card = { isConnected: true, contains: () => false, getAttribute: () => null, getBoundingClientRect: () => ({ top: tops[Math.min(step, tops.length - 1)]! - scrollY }) };
    const doc: any = { activeElement: null, querySelectorAll: () => [card] };
    const win = { get scrollY() { return scrollY; }, scrollX: 0, scrollTo: (o: { top: number }) => { scrollY = o.top; calls.scrollTo.push(o.top); }, addEventListener() {} };
    const raf: Array<() => void> = [];
    const make = new Function("document", "window", "location", "requestAnimationFrame", `${helper}\nreturn setHtml;`);
    const setHtml = make(doc, win, { search: "" }, (f: () => void) => raf.push(f)) as (el: unknown, h: string) => boolean;
    const el: any = {
      style: { minHeight: "" }, offsetHeight: 300, __h: "",
      get innerHTML() { return this.__h; },
      set innerHTML(v: string) { calls.writes++; this.__h = v; step++; opts.onWrite?.(); },
    };
    return { calls, doc, setHtml, el, raf };
  }

  it("identical html is not written again", () => {
    const { calls, setHtml, el } = env();
    expect(setHtml(el, "<b>a</b>")).toBe(true);
    expect(setHtml(el, "<b>a</b>")).toBe(false);
    expect(calls.writes).toBe(1);
    expect(setHtml(el, "<b>b</b>")).toBe(true);
    expect(calls.writes).toBe(2);
  });

  it("a rebuild above the viewport that changes height scrolls back by the anchor drift and holds the old height for one frame", () => {
    const { calls, setHtml, el, raf } = env({ anchorTops: [10, 40] });
    let held = "";
    const e2 = Object.assign(el, {});
    setHtml(e2, "<i>x</i>");
    expect(calls.scrollTo).toEqual([30]);
    expect(e2.style.minHeight).toBe("300px");
    held = e2.style.minHeight;
    raf.forEach((f) => f());
    expect(held).toBe("300px");
    expect(e2.style.minHeight).toBe("");
  });

  it("no scroll correction when the anchor did not move", () => {
    const { calls, setHtml, el } = env({ anchorTops: [10, 10] });
    setHtml(el, "<i>x</i>");
    expect(calls.scrollTo).toEqual([]);
  });

  it("focus inside the panel returns to the element with the same data-* id, without scrolling", () => {
    const { doc, setHtml, el } = env();
    const focused: unknown[] = [];
    const attrs = [{ name: "data-id", value: "w1" }];
    doc.activeElement = { tagName: "BUTTON", attributes: attrs };
    el.contains = (n: unknown) => n === doc.activeElement;
    const fresh = { tagName: "BUTTON", attributes: attrs, focus: (o: unknown) => focused.push(o) };
    el.querySelectorAll = (sel: string) => (sel === "button" ? [{ tagName: "BUTTON", attributes: [{ name: "data-id", value: "other" }], focus: () => focused.push("wrong") }, fresh] : []);
    setHtml(el, "<button data-id=w1>");
    expect(focused).toEqual([{ preventScroll: true }]);
  });

  it("a pending poll after data keeps the old rendering; every .focus() is preventScroll", () => {
    const body = COCKPIT_HTML.match(/function renderModels\(\)\{[\s\S]*?\n\}\n/)![0];
    expect(body).toContain("if(!mdl&&el.__html)return;");
    const el: any = { __html: "<div class=mcard>data</div>", innerHTML: "<div class=mcard>data</div>" };
    const writes: string[] = [];
    const fn = new Function("$", "mdl", "setHtml", "applyModelFold", "setTip", "modelsHtml", `${body}\nrenderModels();`);
    fn(() => el, null, (_e: unknown, h: string) => { writes.push(h); return true; }, () => {}, () => {}, () => "");
    expect(writes).toEqual([]);
    expect(el.innerHTML).toContain("data");
    for (const m of COCKPIT_HTML.matchAll(/\.focus\(([^)]*)\)/g)) expect(m[1]).toContain("preventScroll:true");
  });

  it("no panel is rebuilt with a raw innerHTML write except the fold chevron", () => {
    const raw = COCKPIT_HTML.match(/\w+\.innerHTML=/g) ?? [];
    expect(raw.filter((r) => r !== "b.innerHTML=" && r !== "el.innerHTML=")).toEqual([]);
    expect(COCKPIT_HTML.match(/el\.innerHTML=/g)?.length).toBe(1); // inside setHtml
  });
});

describe("cockpit section ids", () => {
  it("applyCollapse gives sections a prefixed id: every id is unique, $(\"cloud\")/$(\"routing\") stay the inner panels, renders keep the h2 and fold button", () => {
    const src = COCKPIT_HTML.match(/var COLLAPSE_KEY[\s\S]*?\n\}\n/)![0];
    const html = COCKPIT_HTML.match(/<main[\s\S]*<\/main>/)![0];
    const secs = [...html.matchAll(/<section data-section="([a-z]+)"[\s\S]*?<\/section>/g)].map((m) => m[1]!);
    expect(secs).toContain("cloud");
    expect(secs).toContain("routing");
    const inner = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!));
    const byId: Record<string, any> = {};
    const mk = (sec: string) => {
      const h2: any = { textContent: sec, innerHTML: '<button class="fold"></button>' + sec, querySelector: (s: string) => (s === "button.fold" ? { setAttribute() {}, classList: {} } : null), insertBefore() {} };
      const card: any = { id: "", h2, classList: { toggle() {} }, getAttribute: (k: string) => (k === "data-section" ? sec : null), querySelector: (s: string) => (s === "h2" ? h2 : null) };
      return card;
    };
    const cards = secs.map(mk);
    const doc = { querySelectorAll: () => cards };
    const fn = new Function("localStorage", "document", `${src}\nfunction secGrips(){}\napplyCollapse();`);
    fn({ getItem: () => null, setItem() {} }, doc);
    for (const c of cards) { byId[c.id] = c; expect(inner.has(c.id) && !c.id.startsWith("sec-")).toBe(false); }
    expect(new Set(cards.map((c: any) => c.id)).size).toBe(cards.length);
    expect(cards.every((c: any) => c.id.startsWith("sec-"))).toBe(true);
    for (const c of cards) expect(inner.has(c.id)).toBe(false);
    expect(inner.has("cloud")).toBe(true);
    expect(inner.has("routing")).toBe(true);
    // the inner panel for $("cloud") is not a section: a poll's innerHTML write leaves the h2 untouched
    expect(byId["cloud"]).toBeUndefined();
    expect(byId["routing"]).toBeUndefined();
    expect(cards.find((c: any) => c.id === "sec-cloud").h2.innerHTML).toContain("fold");
  });
});

describe("cockpit Models: one local switch, editable aliases", () => {
  const src = [
    COCKPIT_HTML.match(/function metricSpark[\s\S]*?\n\}/)![0],
    COCKPIT_HTML.match(/function metricTile[\s\S]*?\n\}/)![0],
    COCKPIT_HTML.match(/function shortModel\([\s\S]*?\n\}/)![0],
    COCKPIT_HTML.match(/function actRow[\s\S]*?\n\}/)![0],
    COCKPIT_HTML.match(/function tierRow[\s\S]*?\n\}/)![0],
    COCKPIT_HTML.match(/function gb\(b,d\)\{[^\n]*\}/)![0],
    COCKPIT_HTML.match(/function gbm\(m\)\{[^\n]*\}/)![0],
    COCKPIT_HTML.match(/function modelsHtml[\s\S]*?\n\}/)![0],
  ].join("\n");
  const modelsHtml = new Function("esc", "pct", `${src}; return modelsHtml;`)(
    (s: unknown) => String(s ?? ""),
    (x: number) => (x * 100).toFixed(1) + "%"
  ) as (inv: unknown) => string;
  const tiers = [{ tier: "gyro-m", label: "Gyro-M", memoryGb: 60 }];
  const strata = { name: "gyro-m", kind: "strata", status: "running", port: 8035, users: ["worker:flashnext-iq3"], models: [{ model: "flash-next", kind: "coding", loaded: true, memoryMb: 50000, usedBy: ["worker:flashnext-iq3"] }] };
  const ollama = { name: "ollama", kind: "ollama", status: "running", port: 11434, users: ["paperfull-llm"], models: [{ model: "qwen3:8b", kind: "chat", loaded: true, memoryMb: 5000, usedBy: ["paperfull-llm"] }] };
  const base = { at: "x", duplicates: [], consumers: [], live: { at: 1, runtimes: [] }, tiers };
  const count = (h: string) => (h.match(/Local model:/g) ?? []).length;

  it("tierRow renders once, inside the strata card, with two running runtimes", () => {
    const h = modelsHtml({ ...base, running: { model: "flash-next", tier: "gyro-m" }, runtimes: [strata, ollama] });
    expect(count(h)).toBe(1);
    expect(h).toContain('data-a="local.start" data-t="gyro-m"');
    expect(h).not.toContain('data-a="local.switch"');
    const cards = h.split('<div class="mcard').slice(1);
    expect(cards.filter((c) => c.includes("Local model:")).length).toBe(1);
    expect(cards.find((c) => c.includes('data-rt="gyro-m"'))).toContain("Local model:");
    expect(cards.find((c) => c.includes('data-rt="ollama"'))).not.toContain("Local model:");
  });

  it("tierRow sits once at the section bottom when no local engine card is rendered", () => {
    const h = modelsHtml({ ...base, running: null, runtimes: [{ ...strata, status: "stopped", models: [] }, ollama] });
    expect(count(h)).toBe(1);
    expect(h.lastIndexOf("Local model:")).toBeGreaterThan(h.lastIndexOf('<div class="mcard'));
    expect(h.slice(h.indexOf("rt-grid"))).toMatch(/rt-chips[^>]*>.*Local model:/);
  });

  it("an alias in the payload is the card title; the model id stays secondary; the pencil is outside the fold toggle target", () => {
    const h = modelsHtml({ ...base, running: null, runtimes: [{ ...strata, models: [{ ...strata.models[0], label: "My Flash" }] }] });
    expect(h).toContain('<b title="flash-next">My Flash</b>');
    expect(h).toContain('<span class="mid" title="flash-next">flash-next</span>');
    expect(h).toContain('class="lblbtn" data-alias="My Flash"');
  });

  it("the pencil is a header child immediately after the title element", () => {
    const h = modelsHtml({ ...base, running: null, runtimes: [{ ...strata, models: [{ ...strata.models[0], label: "My Flash" }] }] });
    expect(h).toMatch(/<b title="flash-next">My Flash<\/b><button class="lblbtn"/);
    expect(h.indexOf('class="lblbtn"')).toBeLessThan(h.indexOf('class="mid"'));
  });

  /** Runs renderModels against a fake DOM; returns the pencil button and the fake state. */
  function editorHarness(opts: { alias?: string; reply?: (a: unknown[]) => unknown } = {}) {
    const body = COCKPIT_HTML.match(/function renderModels\(\)\{[\s\S]*?\n\}\n/)![0];
    const posts: unknown[][] = [];
    const t: any = { id: "title", tagName: "B" };
    const inputs: any[] = [];
    const extras: any[] = [];
    const loads: number[] = [];
    const state: { renders: number; get: () => boolean } = { renders: 0, get: () => false };
    const head: any = {
      querySelector: (s: string) => (s === "b" ? t : s === "input.lblin" ? inputs.find((i) => i.in) ?? null : null),
      replaceChild: (n: any, o: any) => { if (n.tagName === "INPUT") n.in = true; if (o.tagName === "INPUT") o.in = false; },
      appendChild: (n: any) => { n.in = true; extras.push(n); },
      removeChild: (n: any) => { n.in = false; },
      contains: (n: any) => !!n.in,
    };
    const card = { getAttribute: (k: string) => ({ "data-rt": "gyro-m", "data-model": "huggingface.co/org/qwen3:8b" } as Record<string, string>)[k] };
    head.parentNode = card;
    const btn: any = { parentNode: head, getAttribute: () => opts.alias ?? "Old" };
    const el: any = { __html: "x", querySelectorAll: (s: string) => (s === ".lblbtn" ? [btn] : []) };
    const doc = {
      createElement: (tag: string) => {
        const i: any = { tagName: tag.toUpperCase(), setAttribute() {}, focus() {}, blur() { i.in = false; i.onblur?.(); } };
        if (tag === "input") inputs.push(i);
        return i;
      },
    };
    const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
    const st = (fn: () => void, ms: number) => { timers.push({ fn, ms, live: true }); return timers.length - 1; };
    const ct = (id: number) => { if (timers[id]) timers[id]!.live = false; };
    const fn = new Function(
      "$", "mdl", "setHtml", "applyModelFold", "setTip", "modelsHtml", "document", "postAction", "loadModels", "wireAct", "watchJob", "setTimeout", "clearTimeout", "S",
      `${ACT_STATE_SRC}\nvar mEditing=false,BLUR_CANCEL_MS=400;\nfunction tileGrips(){}function orderTiles(){}function wireMinAll(){}\nfunction applyTileOrder(){}\n${body}\nvar rm=renderModels;renderModels=function(){S.renders++;rm()};\nS.get=function(){return mEditing};\nrm();`
    );
    fn(() => el, { at: "x" }, () => true, () => {}, () => {}, () => "", doc,
      (...a: unknown[]) => { posts.push(a); (a[3] as (j: unknown) => void)(opts.reply ? opts.reply(a) : { ok: true }); },
      () => loads.push(1), () => {}, () => {}, st, ct, state);
    const click = () => btn.onclick({ stopPropagation() {} });
    const find = (cls: string) => extras.filter((x) => x.in).find((x) => x.className?.includes(cls));
    return { btn, t, head, inputs, extras, posts, loads, state, timers, click, find };
  }
  const tap = (b: any) => b.onclick({ stopPropagation() {} });

  it("the pencil swaps the title for an input with check and cross; Enter posts model.label with model:<id>=<alias> (ids with : / . intact)", () => {
    const h = editorHarness();
    h.click();
    expect(h.state.get()).toBe(true);
    expect(h.inputs[0].value).toBe("Old");
    expect(h.inputs[0].placeholder).toBe("alias");
    expect(h.find("lblok")).toBeTruthy();
    expect(h.find("lblno")).toBeTruthy();
    h.inputs[0].value = " Fast ";
    h.inputs[0].onkeydown({ key: "Enter", stopPropagation() {}, preventDefault() {} });
    expect(h.posts.map((p) => p.slice(0, 3))).toEqual([["model.label", "gyro-m", "model:huggingface.co/org/qwen3:8b=Fast"]]);
    expect(h.state.get()).toBe(false);
    expect(h.inputs[0].in).toBe(false);
    expect(h.loads.length).toBe(1);
  });

  it("the check button posts and closes", () => {
    const h = editorHarness();
    h.click();
    h.inputs[0].value = "Fast";
    tap(h.find("lblok"));
    expect(h.posts.map((p) => p.slice(0, 3))).toEqual([["model.label", "gyro-m", "model:huggingface.co/org/qwen3:8b=Fast"]]);
    expect(h.state.get()).toBe(false);
    expect(h.inputs[0].in).toBe(false);
    expect(h.find("lblok")).toBeUndefined();
  });

  it("the cross button and Escape cancel without posting and restore the title", () => {
    const h = editorHarness();
    h.click();
    h.inputs[0].value = "typed";
    tap(h.find("lblno"));
    expect(h.posts.length).toBe(0);
    expect(h.state.get()).toBe(false);
    expect(h.inputs[0].in).toBe(false);
    h.click();
    h.inputs[1].onkeydown({ key: "Escape", stopPropagation() {} });
    expect(h.posts.length).toBe(0);
    expect(h.state.get()).toBe(false);
    expect(h.inputs[1].in).toBe(false);
  });

  it("blur without a tap cancels after a moment and clears mEditing; a tap within the moment still saves; refocus keeps it open", () => {
    const h = editorHarness();
    h.click();
    h.inputs[0].onblur();
    expect(h.state.get()).toBe(true); // blur alone does nothing at once
    expect(h.posts.length).toBe(0);
    h.timers.at(-1)!.fn();
    expect(h.posts.length).toBe(0);
    expect(h.state.get()).toBe(false);
    expect(h.inputs[0].in).toBe(false);
    // blur, then the check is tapped before the timer fires: saves
    h.click();
    h.inputs[1].value = "Fast";
    h.inputs[1].onblur();
    const pending = h.timers.at(-1)!;
    tap(h.find("lblok"));
    expect(h.posts.length).toBe(1);
    expect(pending.live).toBe(false);
    // blur then refocus: the cancel timer is dropped
    h.click();
    h.inputs[2].onblur();
    const t2 = h.timers.at(-1)!;
    h.inputs[2].onfocus();
    expect(t2.live).toBe(false);
    expect(h.state.get()).toBe(true);
  });

  it("reset (only while an alias is set) removes the alias in one tap", () => {
    const none = editorHarness({ alias: "" });
    none.click();
    expect(none.find("lblrs")).toBeUndefined();
    const h = editorHarness();
    h.click();
    h.inputs[0].value = "half typed";
    tap(h.find("lblrs"));
    expect(h.posts.map((p) => p.slice(0, 3))).toEqual([["model.label", "gyro-m", "model:huggingface.co/org/qwen3:8b="]]);
    expect(h.state.get()).toBe(false);
  });

  it("a failed save keeps the input open with the message beside it; the cross still closes and clears the freeze; blur-cancel works after", () => {
    const h = editorHarness({ reply: () => ({ ok: false, message: "boom" }) });
    h.click();
    h.inputs[0].value = "Fast";
    tap(h.find("lblok"));
    expect(h.inputs[0].in).toBe(true);
    expect(h.state.get()).toBe(true);
    expect(h.find("lblmsg").textContent).toBe("boom");
    tap(h.find("lblno"));
    expect(h.inputs[0].in).toBe(false);
    expect(h.state.get()).toBe(false);
    expect(h.posts.length).toBe(1);
    // blur-cancel after a failure
    h.click();
    h.inputs[1].value = "x";
    tap(h.find("lblok"));
    h.inputs[1].onblur();
    h.timers.at(-1)!.fn();
    expect(h.state.get()).toBe(false);
    expect(h.inputs[1].in).toBe(false);
  });

  it("a rebuild is skipped while an alias input is being edited", () => {
    expect(COCKPIT_HTML).toContain("if(mdl&&mEditing)return;");
  });
});

describe("cockpit drag-and-drop layout", () => {
  const src = COCKPIT_HTML.match(/var LKEY[\s\S]*?\nfunction resetLayout[^\n]*\n/)![0];
  const store: Record<string, string> = {};
  const ls = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; }, removeItem: (k: string) => { delete store[k]; } };
  beforeEach(() => { for (const k of Object.keys(store)) delete store[k]; });

  const sec = (name: string, cls: string) => {
    const classes = new Set<string>();
    return {
      className: cls,
      style: {} as Record<string, string>,
      getAttribute: (k: string) => (k === "data-section" ? name : null),
      classList: {
        toggle(cl: string, on: boolean) { if (on) classes.add(cl); else classes.delete(cl); },
        contains: (cl: string) => classes.has(cl),
      },
    };
  };
  /** The shipped page's sections, in page order with their span classes. */
  const pageSecs = () => {
    const html = COCKPIT_HTML.match(/<main[\s\S]*?<\/main>/)![0];
    return [...html.matchAll(/<section data-section="([a-z]+)" class="card (c\d+)">/g)].map((m) => sec(m[1]!, m[2]!));
  };
  const api = (secs: unknown[], mainWidth = 1200) => {
    const main: any = { children: secs.slice(), clientWidth: mainWidth, appendChild(n: any) { const i = main.children.indexOf(n); if (i >= 0) main.children.splice(i, 1); main.children.push(n); } };
    main.querySelectorAll = (sel: string) => (sel === "section[data-section]" ? main.children : []);
    const document = { querySelector: (s: string) => (s === "main" ? main : null), querySelectorAll: (s: string) => main.querySelectorAll(s), createElement: () => ({ setAttribute() {}, appendChild() {} }) };
    const fn = new Function("localStorage", "document", "window", `${src}\nreturn {spanOf:spanOf,deriveRows:deriveRows,PAGE_ROWS:PAGE_ROWS.slice(),savedRows:savedRows,defaultRows:defaultRows,cleanRows:cleanRows,layoutRows:layoutRows,saveRows:saveRows,applyLayout:applyLayout,moveSec:moveSec,tileOrder:tileOrder,saveTileOrder:saveTileOrder,applyTileOrder:applyTileOrder,resetLayout:resetLayout,stackRows:stackRows};`);
    return { a: fn(ls, document, { innerWidth: mainWidth, addEventListener() {} }) as Record<string, (...args: unknown[]) => unknown>, main };
  };

  it("the default rows derive from the section order and the span classes: c8+c4 one row, c6+c6 one row, c12 own rows", () => {
    const { a } = api(pageSecs());
    expect(a.PAGE_ROWS).toEqual([
      ["cloud"], ["routing"], ["workers"], ["pool"], ["models"], ["system"], ["memory"], ["kpis"],
      ["tokens", "cache"], ["speed"], ["pause"], ["sessions"], ["runs", "daily"],
    ]);
  });

  it("a configured router.cockpit.layout.rows wins over the derivation", () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-cockpit-rows-"));
    const prev = process.env.PAI_CONFIG_FILE;
    try {
      writeFileSync(join(dir, "config.yaml"), "router:\n  cockpit:\n    layout:\n      rows:\n        - [cloud, tokens]\n        - [models]\n");
      process.env.PAI_CONFIG_FILE = join(dir, "config.yaml");
      const html = cockpitHtml();
      expect(html).toContain('var DEFAULT_ROWS=[["cloud","tokens"],["models"]]');
      expect(html).not.toBe(COCKPIT_HTML);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (prev === undefined) delete process.env.PAI_CONFIG_FILE;
      else process.env.PAI_CONFIG_FILE = prev;
    }
    // the shipped default is empty: the derivation stands
    expect(COCKPIT_HTML).toContain("var DEFAULT_ROWS=[]");
  });

  it("applyLayout spans each section 12/n and moves the elements in row order (the element itself survives)", () => {
    const a = sec("tokens", "c8"), b = sec("cache", "c4"), c = sec("cloud", "c12");
    const { a: A, main } = api([a, b, c]);
    A.applyLayout([["cloud"], ["tokens", "cache"]]);
    expect((a as any).style.gridColumn).toBe("span 6");
    expect((b as any).style.gridColumn).toBe("span 6");
    expect((c as any).style.gridColumn).toBe("span 12");
    expect(main.children).toEqual([c, a, b]);
  });

  it("moving a section beside another makes both span 6 and persists under pai.cockpit.layout.v1", () => {
    const secs = pageSecs();
    const { a: A } = api(secs);
    const rows = A.layoutRows(secs) as string[][];
    const moved = A.moveSec("cloud", rows, "tokens", "left") as string[][];
    expect(moved.some((r) => r.join(",") === "cloud,tokens,cache")).toBe(true);
    expect(moved.some((r) => r.length === 1 && r[0] === "cloud")).toBe(false);
    A.saveRows(moved);
    expect(JSON.parse(store["pai.cockpit.layout.v1"])).toEqual(moved);
    A.applyLayout(moved);
    const tokens = secs[8] as any, cache = secs[9] as any, cloud = secs[0] as any;
    expect(tokens.style.gridColumn).toBe("span 4");
    expect(cache.style.gridColumn).toBe("span 4");
    expect(cloud.style.gridColumn).toBe("span 4");
  });

  it("a 4th beside a full row is refused: moveSec returns the rows untouched", () => {
    const { a: A } = api([]);
    const rows = [["tokens", "cache", "speed"]];
    expect(A.moveSec("cloud", rows, "cache", "left")).toBe(rows);
    expect(A.moveSec("cloud", rows, "cache", "right")).toBe(rows);
  });

  it("moving above or below creates a row and the old row closes up", () => {
    const { a: A } = api([]);
    const rows = [["a"], ["b", "c"], ["d"]];
    expect(A.moveSec("d", [["a"], ["b", "c"], ["d"]], "b", "above")).toEqual([["a"], ["d"], ["b", "c"]]);
    expect(A.moveSec("a", [["a"], ["b", "c"], ["d"]], "c", "below")).toEqual([["b", "c"], ["a"], ["d"]]);
    // moving the only member of a row out removes the emptied row
    expect(A.moveSec("a", [["a"], ["b", "c"]], "c", "right")).toEqual([["b", "c", "a"]]);
  });

  it("reset clears the saved layout and restores the default rows", () => {
    const secs = pageSecs();
    const { a: A, main } = api(secs);
    store["pai.cockpit.layout.v1"] = JSON.stringify([["models"], ["cloud"]]);
    A.applyLayout(A.layoutRows(secs));
    // the saved rows keep their order; a section the save does not know goes after its default predecessor
    expect(main.children[0]).toBe(secs[4]);
    expect(main.children.indexOf(secs[0] as any)).toBeGreaterThan(0);
    expect(main.children[main.children.indexOf(secs[0] as any) + 1]).toBe(secs[1]);
    expect((secs[4] as any).style.gridColumn).toBe("span 12");
    expect(main.children.length).toBe(15);
    A.resetLayout();
    expect(store["pai.cockpit.layout.v1"]).toBeUndefined();
    // the default rows are back: page order, tokens+cache share a row
    expect(main.children[0]).toBe(secs[0]);
    expect(main.children[13]).toBe(secs[13]);
    expect(main.children[14]).toBe(secs[14]);
    expect((secs[8] as any).style.gridColumn).toBe("span 6");
    expect((secs[9] as any).style.gridColumn).toBe("span 6");
  });

  it("a row of 2 at an 822 px main width stays side by side; a row of 3 stacks (minSectionPx 380)", () => {
    const a = sec("tokens", "c8"), b = sec("cache", "c4"), c = sec("cloud", "c12"), d = sec("speed", "c12");
    const { a: A } = api([a, b, c, d], 822);
    A.applyLayout([["tokens", "cache"], ["cloud"], ["speed"]]);
    expect((a as any).classList.contains("stacked")).toBe(false);
    expect((b as any).classList.contains("stacked")).toBe(false);
    // a row of 3 at 822 px: 274 each, under 380 — the row stacks
    A.applyLayout([["tokens", "cache", "speed"], ["cloud"]]);
    expect((a as any).classList.contains("stacked")).toBe(true);
    expect((b as any).classList.contains("stacked")).toBe(true);
    expect((c as any).classList.contains("stacked")).toBe(false);
    // a wide main un-stacks the row of 3 (1200/3 = 400 >= 380)
    const wide = api([a, b, c, d], 1200);
    wide.a.applyLayout([["tokens", "cache", "speed"], ["cloud"]]);
    expect((a as any).classList.contains("stacked")).toBe(false);
    // the class rule is the stacking mechanism, not a fixed media query
    expect(COCKPIT_HTML).toContain("section[data-section].stacked{grid-column:span 12!important}");
    expect(COCKPIT_HTML).toContain("MINSEC=380");
    // the live main width drives it: ResizeObserver on main, else a resize listener
    expect(COCKPIT_HTML).toContain('new ResizeObserver(function(){stackRows();fitTables()}).observe(document.querySelector("main"))');
    expect(COCKPIT_HTML).toContain('window.addEventListener("resize",function(){stackRows();fitTables()})');
  });

  it("unknown names in the saved layout are dropped, new sections append as own rows", () => {
    const secs = [sec("a", "c12"), sec("b", "c12")];
    const { a: A } = api(secs);
    store["pai.cockpit.layout.v1"] = JSON.stringify([["gone"], ["b", "ghost"], ["a"]]);
    expect(A.layoutRows(secs)).toEqual([["b"], ["a"]]);
  });

  it("tile order persists across a setHtml rebuild: applyTileOrder reorders by data-tid, new tiles go last", () => {
    // parentNode set by appendChild, like a real element: applyTileOrder orders live children only
    const mk = (id: string, parent: any) => ({ style: {}, parentNode: parent, classList: { toggle() {} }, appendChild() {}, getAttribute: (k: string) => (k === "data-tid" ? id : null) });
    const el: any = { __tkey: "rt / m tiles", __html: "src", classList: { toggle() {} } };
    const t1 = mk("Speed", el), t2 = mk("Memory", el), t3 = mk("Workers", el);
    const kids = [t1, t2, t3];
    Object.defineProperty(el, "children", { get: () => kids });
    el.appendChild = (n: any) => { const i = kids.indexOf(n); if (i >= 0) kids.splice(i, 1); n.parentNode = el; kids.push(n); };
    const { a: A } = api([]);
    A.applyTileOrder(el); // no saved order: untouched
    expect(el.children).toEqual([t1, t2, t3]);
    const o = A.tileOrder() as Record<string, string[]>;
    o[el.__tkey] = ["Workers", "Memory"];
    A.saveTileOrder(o);
    // the poll rebuild: fresh elements, source order
    const el2: any = { __tkey: el.__tkey, __html: "src", classList: { toggle() {} } };
    const r1 = mk("Speed", el2), r2 = mk("Memory", el2), r3 = mk("Workers", el2);
    const kids2 = [r1, r2, r3];
    Object.defineProperty(el2, "children", { get: () => kids2 });
    el2.appendChild = (n: any) => { const i = kids2.indexOf(n); if (i >= 0) kids2.splice(i, 1); n.parentNode = el2; kids2.push(n); };
    A.applyTileOrder(el2);
    expect(el2.children).toEqual([r3, r2, r1]);
    // a tile the order does not know goes last
    const r4 = mk("Cache", el2);
    kids2.push(r4);
    A.applyTileOrder(el2);
    expect(el2.children).toEqual([r3, r2, r1, r4]);
  });

  it("a touch press shorter than the delay does not arm the drag; at the delay it arms", () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const setTimeoutStub = (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; };
    const clearTimeoutStub = () => {};
    const secEl = { querySelector: () => ({ textContent: "Cloud" }), getAttribute: () => "cloud", parentNode: { __tkey: "k" } };
    const mkGrip = () => ({ setPointerCapture() {}, addEventListener() {}, removeEventListener() {}, parentNode: null, closest: () => secEl });
    const document = { querySelector: () => null, createElement: () => ({ style: {}, dataset: {}, classList: { toggle() {} }, remove() {} }), body: { appendChild() {} } };
    const windowStub = { addEventListener() {}, removeEventListener() {}, scrollBy() {} };
    const fn = new Function("localStorage", "document", "window", "setTimeout", "clearTimeout", `${src}\nreturn {startDrag:sDrag,getDrag:function(){return drag},abortDrag:aDrag};`);
    const a = fn(ls, document, windowStub, setTimeoutStub, clearTimeoutStub) as { startDrag: (e: unknown, grip: unknown, kind: string) => void; getDrag: () => any; abortDrag: () => void };
    a.startDrag({ button: 0, pointerType: "touch", pointerId: 1, clientX: 5, clientY: 5, preventDefault() {} }, mkGrip(), "section");
    expect(timers[0]!.ms).toBe(350);
    expect(a.getDrag().armed).toBeUndefined();
    // releasing before the press delay: no drag, nothing armed
    a.abortDrag();
    // a mouse arms at once, no timer
    a.startDrag({ button: 0, pointerType: "mouse", pointerId: 2, clientX: 5, clientY: 5, preventDefault() {} }, mkGrip(), "tile");
    expect(timers.length).toBe(1);
    expect(a.getDrag().armed).toBe(true);
    // the touch timer firing at the delay arms the drag
    a.abortDrag();
    a.startDrag({ button: 0, pointerType: "touch", pointerId: 3, clientX: 5, clientY: 5, preventDefault() {} }, mkGrip(), "section");
    expect(a.getDrag().armed).toBeUndefined();
    timers[1]!.fn();
    expect(a.getDrag().armed).toBe(true);
  });

  it("the keyboard Alt+ArrowUp moves a section one row (the wiring is in the page)", () => {
    expect(COCKPIT_HTML).toContain('g.addEventListener("keydown",function(e){');
    expect(COCKPIT_HTML).toContain("if(!e.altKey&&!g.__grab)return;");
    expect(COCKPIT_HTML).toContain('if(e.key==="Enter"||e.key===" "){e.preventDefault();grabToggle(g);return}');
    expect(COCKPIT_HTML).toContain('if(e.key==="ArrowUp"||e.key==="ArrowDown")');
    expect(COCKPIT_HTML).toContain('if(e.key==="ArrowLeft"||e.key==="ArrowRight")');
    // the grip carries the aria-label and sits before the fold chevron
    expect(COCKPIT_HTML).toContain('g.setAttribute("aria-label","move "+(h.textContent||"").trim())');
    expect(COCKPIT_HTML).toContain('h.insertBefore(g,b)');
    // the header reset button
    expect(COCKPIT_HTML).toContain('<button id="reset" type="button" title="reset layout" aria-label="reset layout">⟲</button>');
    expect(COCKPIT_HTML).toContain('$("reset").onclick=resetLayout');
    // pointer events, edge scroll, escape/cancel abort
    expect(COCKPIT_HTML).toContain('g.addEventListener("pointerdown",function(e){sDrag(e,g,"section")})');
    expect(COCKPIT_HTML).toContain("if(y<EDGE_PX)window.scrollBy(0,-8)");
    expect(COCKPIT_HTML).toContain('if(e.key==="Escape")aDrag()');
    expect(COCKPIT_HTML).toContain('window.addEventListener("pointercancel",aDrag)');
    expect(COCKPIT_HTML).toContain('window.addEventListener("pointerup",uDrag)');
    // below the phone breakpoint the span classes go full width; the row stacking
    // itself is the .stacked class from the live main width, not this media query
    expect(COCKPIT_HTML).toContain("@media(max-width:1000px){.c8,.c6,.c4{grid-column:span 12}}");
    // the tunables are baked from the config
    expect(COCKPIT_HTML).toContain("MAXROW=3");
    expect(COCKPIT_HTML).toContain("PRESS_MS=350");
    expect(COCKPIT_HTML).toContain("EDGE_PX=40");
  });
});

/** The page's stop-confirm code (wireAct + the baked CONFIRM_MS), run against a fake
 *  action row whose buttons carry the rendered data-* attributes. */
function confirmHarness(cfText: string | null, confirmMs = 4000) {
  const src = COCKPIT_HTML.match(/var CONFIRM_MS=[^\n]*\n[\s\S]*?function wireAct[\s\S]*?\n\}\n/)![0];
  const msg: any = { textContent: "", className: "msg" };
  const btn: any = {
    confirmed: false, disabled: false, textContent: "stop",
    getAttribute: (k: string) => ({ "data-confirm": cfText, "data-a": "runtime", "data-t": "ollama", "data-v": "stop" } as Record<string, string | null>)[k] ?? null,
  };
  const el = { querySelectorAll: () => [btn], querySelector: () => msg, getAttribute: () => null };
  const posts: unknown[][] = [];
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const fn = new Function("postAction", "setTimeout", "clearTimeout", "CONFIRM_MS", `${src}\nreturn wireAct;`)(
    (...a: unknown[]) => posts.push(a),
    (f: () => void, ms: number) => { timers.push({ fn: f, ms, live: true }); return timers.length - 1; },
    // clearTimeout takes the id setTimeout returned (the page stores the real id)
    (id: number) => { const t = timers[id]; if (t) t.live = false; },
    confirmMs
  ) as (el: unknown, cb?: unknown) => void;
  fn(el, () => {});
  return { btn, msg, posts, timers, click: () => btn.onclick({ stopPropagation() {} }) };
}

/** The page's renderModels wired against the miniDom of the real modelsHtml output:
 *  the real stop button, the real wireAct, a fake postAction that records posts. */
function stopHarness(inv: unknown, confirmMs = 4000, watched: string[] = []) {
  const renderBody = COCKPIT_HTML.match(/function renderModels\(\)\{[\s\S]*?\n\}\n/)![0];
  const confirmSrc = COCKPIT_HTML.match(/var CONFIRM_MS=[^\n]*\n[\s\S]*?function wireAct[\s\S]*?\n\}\n/)![0];
  // the miniDom nodes are plain objects: an onclick assignment sticks
  const dom = miniDom(realModelsHtml(inv), (n: any) => Object.defineProperty(n, "onclick", { value: undefined, writable: true, configurable: true, enumerable: true }));
  const posts: unknown[][] = [];
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const fn = new Function(
    "$", "mdl", "setHtml", "applyModelFold", "setTip", "esc", "pct", "document", "postAction", "loadModels", "watchJob", "setTimeout", "clearTimeout", "CONFIRM_MS",
    `var mEditing=false;\nfunction tileGrips(){}function orderTiles(){}function wireMinAll(){}\nfunction applyTileOrder(){}\nfunction setTip(){}\n${confirmSrc}\n${TILE_RENDER_SRC}\n${renderBody}\nreturn renderModels;`
  );
  const renderModels = fn(
    () => dom.panel, inv, () => true, () => {}, () => {},
    (s: unknown) => String(s ?? ""), (x: number) => (x * 100).toFixed(1) + "%",
    dom.document,
    (...a: unknown[]) => { posts.push(a); (a[3] as (j: unknown) => void)({ ok: true }); },
    () => {}, (id: string) => { watched.push(id); },
    (f: () => void, ms: number) => { timers.push({ fn: f, ms, live: true }); return timers.length - 1; },
    // clearTimeout takes the id setTimeout returned (the page stores the real id)
    (id: number) => { if (timers[id]) timers[id]!.live = false; },
    confirmMs
  ) as () => void;
  try { renderModels(); } catch (e) { throw new Error(`renderModels threw: ${(e as Error).message}`); }
  // the stop button of the card for a given runtime, as the real markup renders it
  // (the button sits in the header's .act span, not directly in the card)
  const stopBtn = (rt: string) => {
    const card = dom.all.find((n: any) => n.classes.has("mcard") && n.getAttribute("data-rt") === rt);
    const btn = card && dom.all.find((n: any) => {
      if (n.tag !== "button" || n.getAttribute("data-a") !== "runtime" || n.getAttribute("data-v") !== "stop") return false;
      for (let p = n.parentNode; p; p = p.parentNode) if (p === card) return true;
      return false;
    });
    if (!btn) throw new Error(`no stop button on the ${rt} card`);
    return btn;
  };
  // the miniDom drops text nodes: give every node a textContent, decoded from its own markup
  const textOf = (n: any) => {
    const open = Object.keys(n.attrs).map((k) => (n.attrs[k] === "" ? ` ${k}` : ` ${k}="${n.attrs[k]}"`)).join("");
    const m = new RegExp(`<${n.tag}${open}>([^<]*)</${n.tag}>`).exec(dom.panel.innerHTML);
    return m ? m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">") : "";
  };
  for (const n of dom.all) n.textContent = textOf(n);
  const click = (btn: any) => {
    if (typeof btn.onclick !== "function") throw new Error(`onclick not wired on ${btn.getAttribute("data-v")} (wired rows: ${dom.all.filter((n: any) => typeof n.onclick === "function").length})`);
    btn.onclick({ stopPropagation() {} });
  };
  // advance past CONFIRM_MS: every timer still live fires, like a real clock
  const advance = (ms: number) => { for (const t of timers) if (t.live && t.ms <= ms) { t.live = false; t.fn(); } };
  const fire = (i: number) => { if (timers[i]?.live) { timers[i]!.live = false; timers[i]!.fn(); } };
  return { posts, timers, click, fire, advance, stopBtn, textOf };
}

/** The page-level armed-confirm / action-message state and its re-apply helpers (wireAct and renderModels use them). */
const ACT_STATE_SRC = COCKPIT_HTML.match(/var armedKey=[\s\S]*?function noteMsg[^\n]*\n/)![0];

/** The page's render helpers, extracted verbatim from the shipped page. */
const TILE_RENDER_SRC = [
  COCKPIT_HTML.match(/function metricSpark[\s\S]*?\n\}/)![0],
  COCKPIT_HTML.match(/function metricTile[\s\S]*?\n\}/)![0],
  COCKPIT_HTML.match(/function shortModel\([\s\S]*?\n\}/)![0],
  COCKPIT_HTML.match(/function actRow[\s\S]*?\n\}/)![0],
  COCKPIT_HTML.match(/function tierRow[\s\S]*?\n\}/)![0],
  COCKPIT_HTML.match(/function gb\(b,d\)\{[^\n]*\}/)![0],
  COCKPIT_HTML.match(/function gbm\(m\)\{[^\n]*\}/)![0],
  COCKPIT_HTML.match(/function modelsHtml[\s\S]*?\n\}/)![0],
].join("\n");
const realModelsHtml = new Function("esc", "pct", `${TILE_RENDER_SRC}; return modelsHtml;`)(
  (s: unknown) => String(s ?? ""), (x: number) => (x * 100).toFixed(1) + "%"
) as (inv: unknown) => string;

/** A minimal DOM that parses the rendered html: children, parentNode, getAttribute,
 *  querySelector, appendChild, and addEventListener that records handlers, so the page's
 *  own wiring runs against the real markup. No hand-made fixtures. */
function miniDom(html: string, init?: (node: any) => void) {
  const roots: any[] = [];
  const stack: any[] = [];
  for (const m of html.matchAll(/<\/([a-zA-Z][a-zA-Z0-9]*)\s*>|<([a-zA-Z][a-zA-Z0-9]*)([^>]*)\/?>|([^<]+)/g)) {
    if (m[4] !== undefined) continue;
    const closing = m[1] !== undefined;
    // a trailing "/" is inside the attribute values (a model id like "huggingface.co/…"),
    // so only an XML-style "/>" is self-closing
    const self = !closing && m[0].endsWith("/>");
    const attrs: Record<string, string | null> = {};
    // an attribute name starts at the tag's start or after a space: a "/" inside a value
    // ("huggingface.co/…") must not split the value into a bogus attribute
    for (const a of (m[3] ?? "").matchAll(/(^|\s)([a-zA-Z-]+)(?:="([^"]*)")?/g)) attrs[a[2]!] = a[3] ?? "";
    const node: any = {
      tag: closing ? m[1]! : m[2]!, attrs, classes: new Set<string>((attrs["class"] ?? "").split(/\s+/).filter(Boolean)),
      children: [], parentNode: null, handlers: [] as Array<{ type: string; fn: (e: unknown) => void }>,
      getAttribute: (k: string) => attrs[k] ?? null,
      classList: { contains: (c: string) => node.classes.has(c), toggle: (c: string, on: boolean) => { if (on) node.classes.add(c); else node.classes.delete(c); } },
      setAttribute: (k: string, v: string) => { attrs[k] = v; },
      get nextSibling() { const p = node.parentNode; if (!p) return null; const k = p.children.filter((c: any) => c.parentNode === p); return k[k.indexOf(node) + 1] ?? null; },
      insertBefore(n: any, ref: any) {
        const o = n.parentNode; if (o) { const i = o.children.indexOf(n); if (i >= 0) o.children.splice(i, 1); }
        n.parentNode = node; const at = ref ? node.children.indexOf(ref) : -1;
        if (at >= 0) node.children.splice(at, 0, n); else node.children.push(n);
      },
      removeChild(n: any) { const i = node.children.indexOf(n); if (i >= 0) node.children.splice(i, 1); n.parentNode = null; },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 40 }),
      addEventListener: (type: string, fn: (e: unknown) => void) => { node.handlers.push({ type, fn }); },
      removeEventListener() {}, setPointerCapture() {},
      closest: (sel: string) => {
        // nearest self-or-ancestor matching the selector, like the real closest()
        const match = (n: any) => (sel === "[data-tgrip]" ? n.attrs["data-tgrip"] !== undefined : sel === "[data-tid]" ? n.getAttribute("data-tid") !== null : false);
        for (let n: any = node; n; n = n.parentNode) if (match(n)) return n;
        return null;
      },
      querySelectorAll: (sel: string) => {
        const out: any[] = [];
        const match = (n: any) =>
          sel.startsWith(".") ? n.classes.has(sel.slice(1))
            : sel.startsWith("[") ? n.attrs[sel.slice(1, -1)] !== undefined
              : n.tag === sel;
        const walk = (n: any) => { if (match(n)) out.push(n); for (const c of liveKids(n)) walk(c); };
        for (const c of liveKids(node)) walk(c); // descendants, like the real querySelectorAll
        return out;
      },
      querySelector: (sel: string) => {
        let found: any = null;
        const match = (n: any) =>
          sel.startsWith(".") ? n.classes.has(sel.slice(1))
            : sel.startsWith("[") ? n.attrs[sel.slice(1, -1)] !== undefined
              : n.tag === sel;
        const walk = (n: any) => { if (!found && match(n)) found = n; for (const c of liveKids(n)) walk(c); };
        for (const c of liveKids(node)) walk(c); // a real querySelector matches descendants, not the element itself
        return found;
      },
      appendChild(n: any) {
        // a real appendChild moves the node: out of its old parent, into this one
        const p = n.parentNode;
        if (p) { const i = p.children.indexOf(n); if (i >= 0) p.children.splice(i, 1); }
        n.parentNode = node; node.children.push(n);
      },
    };
    if (closing) stack.pop();
    else {
      if (init) init(node);
      // the stack's top is the innermost open element (closing tags pop it): the new node's parent
      const parent = stack.length ? stack[stack.length - 1] : null;
      if (parent) { node.parentNode = parent; parent.children.push(node); } else roots.push(node);
      if (!self) stack.push(node);
    }
  }
  const all: any[] = [];
  const walk = (n: any) => { all.push(n); for (const c of n.children) walk(c); };
  for (const r of roots) walk(r);
  // live children of a node: the parse order, minus the nodes appendChild moved away
  const liveKids = (n: any) => n.children.filter((c: any) => c.parentNode === n);
  const bySel = (sel: string) => all.filter((n) =>
    sel === "[data-tgrip]" ? n.attrs["data-tgrip"] !== undefined
      : sel === ".rt-tiles" ? n.classes.has("rt-tiles")
      : sel === "[data-tkey]" ? n.attrs["data-tkey"] !== undefined
      : sel === ".mcard" ? n.classes.has("mcard") : false);
  const document: any = {
    querySelectorAll: bySel,
    querySelector: (sel: string) => all.find((n) => sel === "main" && n.tag === "main") ?? null,
    createElement: (tag: string) => {
      const attrs: Record<string, string | null> = {};
      const classes = new Set<string>();
      const n: any = {
        tag, attrs, classes, style: {}, dataset: {}, children: [], parentNode: null, className: "", remove() {},
        classList: { contains: (c: string) => classes.has(c), toggle: (c: string, on: boolean) => { if (on) classes.add(c); else classes.delete(c); } },
        getAttribute: (k: string) => attrs[k] ?? null, setAttribute: (k: string, v: string) => { attrs[k] = v; },
        appendChild(c: any) { const p = c.parentNode; if (p) { const i = p.children.indexOf(c); if (i >= 0) p.children.splice(i, 1); } c.parentNode = n; n.children.push(c); },
        get nextSibling() { return null; },
      };
      return n;
    },
    body: { appendChild() {} },
  };
  // like a real element: querySelectorAll matches descendants by class, attribute or tag
  const panelQSA = (sel: string) => {
    const out: any[] = [];
    const match = (n: any) =>
      sel.startsWith(".") ? n.classes.has(sel.slice(1))
        : sel.startsWith("[") ? n.attrs[sel.slice(1, -1)] !== undefined
          : n.tag === sel;
    const walk = (n: any) => { if (match(n)) out.push(n); for (const c of liveKids(n)) walk(c); };
    for (const r of roots) walk(r);
    return out;
  };
  const panel: any = { innerHTML: html, __html: html, querySelectorAll: (sel: string) => (bySel(sel) as any[]).length ? bySel(sel) : panelQSA(sel) };
  return { roots, all, document, panel };
}

/** The page's tile-order/grip/drag code (the LKEY block) plus the real renderModels,
 *  run against the real modelsHtml output for a live-shaped inventory. */
function tileDragHarness(inv: unknown) {
  const src = COCKPIT_HTML.match(/var LKEY[\s\S]*?\nfunction resetLayout[^\n]*\n/)![0];
  const renderBody = COCKPIT_HTML.match(/function renderModels\(\)\{[\s\S]*?\n\}\n/)![0];
  const store: Record<string, string> = {};
  const ls = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; }, removeItem: (k: string) => { delete store[k]; } };
  // the drag listens on the window: record them so the test fires the real handlers
  const winHandlers: Array<{ type: string; fn: (e: unknown) => void }> = [];
  const windowStub = {
    innerWidth: 1200, scrollBy() {}, scrollX: 0, scrollY: 0, scrollTo() {}, requestAnimationFrame() {},
    addEventListener: (type: string, fn: (e: unknown) => void) => { winHandlers.push({ type, fn }); },
    removeEventListener: (type: string, fn: unknown) => { const i = winHandlers.findIndex((w) => w.type === type && w.fn === fn); if (i >= 0) winHandlers.splice(i, 1); },
  };
  const dom = miniDom(realModelsHtml(inv));
  // edgeScroll reads document.documentElement.clientHeight
  dom.document.documentElement = { clientHeight: 800 };
  const fn = new Function(
    "localStorage", "document", "window", "setTimeout", "clearTimeout", "$", "mdl", "setHtml", "applyModelFold", "setTip", "esc", "pct",
    `${ACT_STATE_SRC}\nfunction liveWrite(e,w){return w()}\n${src}\nfunction stackRows(){}\n${TILE_RENDER_SRC}\nfunction applyModelFold(){}\nfunction setTip(){}function wireMinAll(){}\nvar mEditing=false;\n${renderBody}\nreturn {renderModels:renderModels,tileOrder:tileOrder,saveTileOrder:saveTileOrder,applyTileOrder:applyTileOrder,startDrag:sDrag,moveDrag:mDrag,upDrag:uDrag,getDrag:function(){return drag}};`
  );
  const api = fn(ls, dom.document, windowStub, () => 0, () => {}, () => dom.panel, inv, () => true, () => {}, () => {},
    (s: unknown) => String(s ?? ""), (x: number) => (x * 100).toFixed(1) + "%") as Record<string, (...args: unknown[]) => unknown>;
  const tilesOf = (cont: any) => cont.children.filter((c: any) => c.parentNode === cont && c.getAttribute("data-tid"));
  const keydownOf = (grip: any) => grip.handlers.find((h: { type: string }) => h.type === "keydown")?.fn as ((e: unknown) => void) | undefined;
  const loadedTiles = () => dom.document.querySelectorAll(".rt-tiles").find((c: any) => c.getAttribute("data-tkey") === "gyro-m / flash-next tiles");
  return { api, dom, store, tilesOf, keydownOf, loadedTiles, winHandlers };
}

describe("cockpit tile drag on the real rendered page (live bug: tiles had no data-tid)", () => {
  // the live shape: a running coding runtime with the four metric tiles in .rt-tiles,
  // an idle card with the two compact tiles, model cards in the grid
  const inv = {
    at: "2026-10-21T03:00:00.000Z",
    runtimes: [
      { name: "gyro-m", kind: "strata", status: "running", port: 8035, label: "Coding workers (gyro-m)", users: ["worker:flashnext-iq3"], models: [{ model: "flash-next", kind: "coding", loaded: true, memoryMb: 50000, usedBy: ["worker:flashnext-iq3"] }] },
      { name: "ollama", kind: "ollama", status: "idle", port: 11434, users: ["pai-embedding"], models: [{ model: "qwen3:8b", kind: "chat", loaded: false, sizeMb: 4792, usedBy: ["pai-embedding"] }] },
    ],
    duplicates: [],
    consumers: [],
    live: {
      at: 1,
      runtimes: [
        { name: "gyro-m", status: "running", live: { engine: { decode: 73.4, prefill: 715, phase: "idle", parked: 2, slots: 4, reusedPct: 90, lastDecode: 73.4, lastPrompt: 155000, lastReused: 150000, lastPromptMs: 5000, lastUsed: 155500, gpuMemUsed: 1530000000, gpuMemTotal: 115964116992, maxContext: 262144, liveUsed: null }, rssMb: 36148, workers: [], queued: 2, cap: 1, conversationSlots: 4, sparesReady: 1, sparesConfig: 1 }, history: { decode: [70, 73.4], prefill: [700, 715], memoryMb: [49000, 50000], queued: [0, 2], reusedPct: [88, 90], pressurePct: [60, 62] } },
        { name: "ollama", status: "idle", live: null, history: null },
      ],
    },
  };

  it("the real render emits draggable tiles: every metric tile and model card carries a distinct data-tid", () => {
    const h = realModelsHtml(inv);
    const tiles = [...h.matchAll(/<div class="mt" data-tid="([^"]*)"/g)].map((m) => m[1]!);
    expect(tiles.length).toBeGreaterThanOrEqual(6); // 4 loaded tiles + 2 idle-card tiles
    expect(new Set(tiles).size).toBe(tiles.length);
    for (const t of ["speed", "memory", "workers", "conversation-cache", "memory-size", "users"]) expect(tiles).toContain(t);
    // no tile renders without an id
    expect(h.match(/<div class="mt">/g) ?? []).toEqual([]);
    // model cards carry the fold-state id (runtime / model)
    const cards = [...h.matchAll(/<div class="mcard[^"]*" data-tid="([^"]*)"/g)].map((m) => m[1]!);
    expect(cards).toEqual(["gyro-m / flash-next", "ollama / qwen3:8b"]);
    // a grip on every metric tile
    expect((h.match(/data-tgrip/g) ?? []).length).toBe(tiles.length + cards.length);
  });

  // the real listeners: tileGrips() wires pointerdown on the grip; sDrag adds pointermove/up on it
  const dragViaListeners = (h: ReturnType<typeof tileDragHarness>, from: number, to: number, pos: "left" | "right" | "top" | "bottom", opts: { stacked?: boolean } = {}) => {
    const cont = h.loadedTiles();
    const tiles = h.tilesOf(cont);
    // 4 tiles of 100x40: one row, or stacked in one column
    tiles.forEach((t: any, i: number) => { t.getBoundingClientRect = () => (opts.stacked ? { left: 0, top: i * 50, width: 100, height: 40 } : { left: i * 110, top: 0, width: 100, height: 40 }); });
    cont.getBoundingClientRect = () => (opts.stacked ? { left: 0, top: 0, width: 100, height: 200 } : { left: 0, top: 0, width: 440, height: 40 });
    const grip = tiles[from].querySelector("[data-tgrip]");
    const box = tiles[to].getBoundingClientRect();
    const x = pos === "left" ? box.left + 10 : pos === "right" ? box.left + 90 : box.left + 50;
    const y = pos === "top" ? box.top + 5 : pos === "bottom" ? box.top + 35 : box.top + 20;
    const fire = (type: string, cx: number, cy: number) => {
      const e = { type, button: 0, pointerType: "mouse", pointerId: 7, clientX: cx, clientY: cy, preventDefault() {} };
      // pointerdown is wired on the grip, the rest on the window (sDrag adds them)
      const hs = type === "pointerdown" ? grip.handlers : [...h.winHandlers];
      for (const hd of hs.filter((hh: { type: string }) => hh.type === type)) hd.fn(e);
    };
    const gb = tiles[from].getBoundingClientRect();
    fire("pointerdown", gb.left + 5, gb.top + 5);
    for (let i = 1; i <= 10; i++) fire("pointermove", gb.left + 5 + ((x - gb.left - 5) * i) / 10, gb.top + 5 + ((y - gb.top - 5) * i) / 10);
    fire("pointerup", x, y);
    return h.tilesOf(cont).map((t: any) => t.getAttribute("data-tid"));
  };

  it("dropping on the right half of the third tile moves Speed after Workers and persists", () => {
    const h = tileDragHarness(inv);
    h.api.renderModels();
    const after = dragViaListeners(h, 0, 2, "right");
    expect(after).toEqual(["memory", "workers", "speed", "conversation-cache"]);
    expect(JSON.parse(h.store["pai.cockpit.tiles.v1"])).toEqual({ "gyro-m / flash-next tiles": after });
    // a poll rebuild keeps the order
    h.api.renderModels();
    expect(h.tilesOf(h.loadedTiles()).map((t: any) => t.getAttribute("data-tid"))).toEqual(after);
  });

  it("the left half drops before the tile under the pointer; a different tile than the first decides", () => {
    const h = tileDragHarness(inv);
    h.api.renderModels();
    expect(dragViaListeners(h, 0, 2, "left")).toEqual(["memory", "speed", "workers", "conversation-cache"]);
  });

  it("wrapped rows: across rows the vertical midpoint decides", () => {
    const h = tileDragHarness(inv);
    h.api.renderModels();
    expect(dragViaListeners(h, 0, 2, "bottom", { stacked: true })).toEqual(["memory", "workers", "speed", "conversation-cache"]);
    const h2 = tileDragHarness(inv);
    h2.api.renderModels();
    expect(dragViaListeners(h2, 0, 2, "top", { stacked: true })).toEqual(["memory", "speed", "workers", "conversation-cache"]);
  });

  it("dropping on itself is a no-op and saves nothing", () => {
    const h = tileDragHarness(inv);
    h.api.renderModels();
    expect(dragViaListeners(h, 1, 1, "right")).toEqual(["speed", "memory", "workers", "conversation-cache"]);
    expect(h.store["pai.cockpit.tiles.v1"]).toBeUndefined();
  });

  it("the move/up listeners live on the window, not the grip: a poll that replaces the grip mid-drag cannot strand the drag (live no-op root cause)", () => {
    const h = tileDragHarness(inv);
    h.api.renderModels();
    const tiles = h.tilesOf(h.loadedTiles());
    const grip = tiles[0].querySelector("[data-tgrip]");
    for (const hd of grip.handlers.filter((hh: { type: string }) => hh.type === "pointerdown")) hd.fn({ button: 0, pointerType: "mouse", pointerId: 7, clientX: 5, clientY: 5, preventDefault() {} });
    expect(grip.handlers.map((x: { type: string }) => x.type)).not.toContain("pointermove");
    expect(h.winHandlers.map((x) => x.type)).toEqual(expect.arrayContaining(["pointermove", "pointerup", "pointercancel", "keydown"]));
    // Escape clears them all
    h.winHandlers.find((x) => x.type === "keydown")!.fn({ key: "Escape" });
    expect(h.winHandlers.length).toBe(0);
  });

  it("the keyboard Alt+ArrowRight path reorders the real rendered tiles and persists", () => {
    const { api, store, tilesOf, keydownOf, loadedTiles } = tileDragHarness(inv);
    api.renderModels();
    const cont = loadedTiles();
    const grip = tilesOf(cont)[1].querySelector("[data-tgrip]"); // Memory tile
    const keydown = keydownOf(grip); // wired by tileGrips() inside renderModels
    expect(typeof keydown).toBe("function");
    keydown!({ altKey: true, key: "ArrowRight", preventDefault() {} });
    const after = tilesOf(cont).map((t: any) => t.getAttribute("data-tid"));
    expect(after).toEqual(["speed", "workers", "memory", "conversation-cache"]);
    expect(JSON.parse(store["pai.cockpit.tiles.v1"])).toEqual({ "gyro-m / flash-next tiles": after });
  });

  it("after a setHtml re-render the saved order is re-applied to the fresh tiles", () => {
    const { api, dom, store, tilesOf } = tileDragHarness(inv);
    api.renderModels();
    store["pai.cockpit.tiles.v1"] = JSON.stringify({ "gyro-m / flash-next tiles": ["conversation-cache", "workers", "memory", "speed"] });
    // the poll rebuild: the same source html, fresh elements
    const dom2 = miniDom(realModelsHtml(inv));
    dom.panel.querySelectorAll = dom2.document.querySelectorAll;
    api.renderModels();
    const cont2 = dom2.document.querySelectorAll(".rt-tiles").find((c: any) => c.getAttribute("data-tkey") === "gyro-m / flash-next tiles");
    expect(tilesOf(cont2).map((t: any) => t.getAttribute("data-tid"))).toEqual(["conversation-cache", "workers", "memory", "speed"]);
  });
});

describe("cockpit stop confirm: a shared runtime names what else it stops", () => {
  const sharedInv = {
    at: "x",
    runtimes: [{ name: "ollama", kind: "ollama", status: "running", port: 11434, users: ["paperfull-chat", "pai-embedding"], models: [
      { model: "qwen3:8b", kind: "chat", loaded: true, memoryMb: 5000, usedBy: ["paperfull-chat"] },
      { model: "arctic-embed", kind: "embedding", loaded: false, usedBy: ["pai-embedding"] },
    ] }],
    runtimeCommands: { ollama: { start: "ollama serve", stop: "kill" } },
    consumers: [
      { name: "paperfull-chat", runtime: "ollama", model: "qwen3:8b", label: "Paperfull chat" },
      { name: "pai-embedding", runtime: "ollama", model: "arctic-embed", label: "PAI embedding" },
    ],
    duplicates: [],
    live: { at: 1, runtimes: [] },
  };
  const singleInv = {
    at: "x",
    runtimes: [{ name: "ollama", kind: "ollama", status: "running", port: 11434, users: ["paperfull-chat"], models: [
      { model: "qwen3:8b", kind: "chat", loaded: true, memoryMb: 5000, usedBy: ["paperfull-chat"] },
    ] }],
    runtimeCommands: { ollama: { start: "ollama serve", stop: "kill" } },
    consumers: [{ name: "paperfull-chat", runtime: "ollama", model: "qwen3:8b", label: "Paperfull chat" }],
    duplicates: [],
    live: { at: 1, runtimes: [] },
  };

  it("a shared runtime's stop button carries the confirm text naming the other consumers", () => {
    const h = realModelsHtml(sharedInv);
    const chat = h.split('<div class="mcard').find((c) => c.includes('data-model="qwen3:8b"'))!;
    expect(chat).toContain('data-a="runtime" data-t="ollama" data-v="stop" data-confirm="stop ollama: also PAI embedding - click again"');
    const emb = h.split('<div class="mcard').find((c) => c.includes('data-model="arctic-embed"'))!;
    expect(emb).toContain('data-confirm="stop ollama: also Paperfull chat - click again"');
    // a runtime serving only this card's consumers stops in one click: no confirm at all
    const s = realModelsHtml(singleInv);
    expect(s).toContain('data-a="runtime" data-t="ollama" data-v="stop">stop</button>');
    expect(s).not.toContain("click again");
    // start/load buttons are unaffected
    const stopped = realModelsHtml({
      at: "x",
      runtimes: [{ name: "ollama", kind: "ollama", status: "stopped", port: 11434, users: ["paperfull-chat", "pai-embedding"], models: [] }],
      runtimeCommands: { ollama: { start: "ollama serve", stop: "kill" } },
      consumers: [
        { name: "paperfull-chat", runtime: "ollama", model: "qwen3:8b", label: "Paperfull chat" },
        { name: "pai-embedding", runtime: "ollama", model: "arctic-embed", label: "PAI embedding" },
      ],
      live: { at: 1, runtimes: [] },
    });
    expect(stopped).toContain('data-v="start">start</button>');
    expect(stopped).not.toContain("click again");
  });

  it("shared runtime: first click shows the confirm text and does not post; the second posts the stop action", () => {
    const h = stopHarness(sharedInv);
    const btn = h.stopBtn("ollama");
    expect(btn.textContent).toBe("stop");
    h.click(btn);
    expect(h.posts.length).toBe(0);
    expect(btn.textContent).toBe("stop ollama: also PAI embedding - click again");
    h.click(btn);
    expect(h.posts.map((p) => p.slice(0, 3))).toEqual([["runtime", "ollama", "stop"]]);
  });

  it("the confirm reverts when the second click never comes", () => {
    const h = stopHarness(sharedInv);
    const btn = h.stopBtn("ollama");
    h.click(btn);
    expect(h.posts.length).toBe(0);
    expect(h.timers[0]!.ms).toBe(4000);
    h.fire(0); // the confirm window closes
    expect(btn.textContent).toBe("stop");
    h.click(btn); // a click after the revert arms again, still without posting
    expect(h.posts.length).toBe(0);
    expect(btn.textContent).toBe("stop ollama: also PAI embedding - click again");
  });

  it("a single-consumer runtime stops on the first click", () => {
    const h = stopHarness(singleInv);
    h.click(h.stopBtn("ollama"));
    expect(h.posts.map((p) => p.slice(0, 3))).toEqual([["runtime", "ollama", "stop"]]);
  });

  it("confirmMs is config-driven (router.cockpit.layout.confirmMs)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-cockpit-confirm-"));
    const prev = process.env.PAI_CONFIG_FILE;
    try {
      writeFileSync(join(dir, "config.yaml"), "router:\n  cockpit:\n    layout:\n      confirmMs: 2500\n");
      process.env.PAI_CONFIG_FILE = join(dir, "config.yaml");
      expect(cockpitHtml()).toContain("CONFIRM_MS=2500");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (prev === undefined) delete process.env.PAI_CONFIG_FILE;
      else process.env.PAI_CONFIG_FILE = prev;
    }
    expect(COCKPIT_HTML).toContain("CONFIRM_MS=4000");
  });

  it("wireAct: a button without data-confirm posts at once; the revert timer clears on the second click", () => {
    const plain = confirmHarness(null);
    plain.click();
    expect(plain.posts.map((p) => p.slice(0, 3))).toEqual([["runtime", "ollama", "stop"]]);
    expect(plain.timers.length).toBe(0);
    const armed = confirmHarness("stop ollama: also PAI embedding - click again");
    armed.click();
    expect(armed.posts.length).toBe(0);
    expect(armed.btn.textContent).toBe("stop ollama: also PAI embedding - click again");
    armed.click();
    expect(armed.posts.map((p) => p.slice(0, 3))).toEqual([["runtime", "ollama", "stop"]]);
    expect(armed.timers[0]!.live).toBe(false);
    expect(armed.btn.textContent).toBe("stop");
  });

  it("an armed confirm and the action message survive the poll re-render (page-level state re-applied)", () => {
    const api = new Function(`${ACT_STATE_SRC}\nreturn {arm:function(k){armedKey=k},reapplyActs:reapplyActs,noteMsg:noteMsg};`)() as {
      arm: (k: string) => void; reapplyActs: (r: unknown) => void; noteMsg: (rt: string, t: string, ok: boolean) => void;
    };
    const attrs = { "data-a": "runtime", "data-t": "ollama", "data-v": "stop", "data-confirm": "stop ollama - click again" } as Record<string, string>;
    const fresh: any = { textContent: "stop", getAttribute: (k: string) => attrs[k] ?? null };
    const msg: any = { textContent: "", className: "msg" };
    const row: any = { getAttribute: () => "ollama", querySelector: () => msg };
    const root = { querySelectorAll: (q: string) => (q.startsWith("button") ? [fresh] : [row]) };
    api.arm("runtime|ollama|stop");
    api.noteMsg("ollama", "starting ollama", true);
    api.reapplyActs(root);
    expect(fresh.confirmed).toBe(true);
    expect(fresh.textContent).toBe("stop ollama - click again");
    expect(msg.textContent).toBe("starting ollama");
  });

  it("the second click clears the revert timer: past CONFIRM_MS the label stays reverted and confirmed stays false", () => {
    const h = stopHarness(sharedInv);
    const btn = h.stopBtn("ollama");
    h.click(btn); // arms: the confirm label shows, the revert timer runs
    expect(btn.textContent).toBe("stop ollama: also PAI embedding - click again");
    h.click(btn); // confirms: posts, reverts the label, must clear the timer
    expect(h.posts.length).toBe(1);
    expect(btn.textContent).toBe("stop");
    expect(h.timers[0]!.live).toBe(false);
    h.advance(4000); // past CONFIRM_MS: the cleared timer must not fire
    expect(btn.textContent).toBe("stop");
    expect(btn.confirmed).toBe(false);
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

  it("the kpis section has an h2, so it gets the fold, id and grip like every section", () => {
    expect(COCKPIT_HTML).toContain('<section data-section="kpis" class="card c12"><h2>Totals in this window');
    const html = COCKPIT_HTML.match(/<main[\s\S]*?<\/main>/)![0];
    const noH2 = [...html.matchAll(/<section data-section="([a-z]+)" class="card[^"]*">(?!<h2)/g)].map((m) => m[1]);
    expect(noH2).toEqual([]);
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

  it("the system tiles carry their units next to the value", () => {
    const r = renderSys(sysOf([], { memUsed: 8 * GB, memTotal: 36 * GB, cpu: 42, cpuW: 12.3, totalW: 30.5, socTemp: 55.2 }));
    const h = r.sys;
    expect(h).toContain('<span class="mt-value">8.0<small>GB</small></span>');
    expect(h).toContain("of 36 GB");
    expect(h).toContain('<span class="mt-value">42<small>%</small></span>');
    expect(h).toContain('<span class="mt-value">12.3<small>W</small></span>');
    expect(h).toContain('<span class="mt-value">30.5<small>W</small></span>');
    expect(h).toContain('<span class="mt-value">55.2<small>°C</small></span>');
    expect(h).toContain('<span class="mt-value">4<small>Wh</small></span>');
  });

  it("a disabled pool with a down host renders one compact line, not the dashboard of zeros", () => {
    const js = POOL_PANEL_JS;
    const els: Record<string, any> = { poolpanel: { innerHTML: "", __html: "" }, pooltip: { setAttribute() {} } };
    const fn = new Function("$", "setHtml", "setTip", "esc", "fmt", "pct", `${SH}\n${js}\nreturn renderPool;`);
    const renderPool = fn(
      (id: string) => els[id],
      (el: any, h: string) => { el.innerHTML = h; return true; },
      () => {},
      (s: unknown) => String(s ?? ""),
      (n: number) => String(n),
      (x: number) => (x * 100).toFixed(1) + "%"
    ) as (p: unknown) => void;
    renderPool({
      enabled: false, hostUp: false, port: 8798, maxSlots: 3, idleKillSecs: 1800,
      hostSince: null, hostLastSeen: "2026-10-19 22:41:03", hostBuiltAt: "2026-10-19 21:00:00", hostStale: false,
      slots: [], totals: { tasksServed: 0, tokensCarried: 0, hitRatio: null, carriedTasks: 0 },
      last24h: { runs: 0, pooled: 0, notPooled: 0, reasons: [], topReason: null, unattributed: 0, poolOff: 0 },
      spares: [], spareClaims: 0, spareMisses: [],
      offReason: "host down",
      message: "Pool is enabled but its host is DOWN (host down): every worker starts cold. Start it with `pai worker pool on`.",
    });
    const h = els.poolpanel.innerHTML;
    expect(h).toContain("Pool off · host not running");
    expect(h).toContain("last seen 2026-10-19 22:41:03");
    expect(h).toContain("last built 2026-10-19 21:00:00");
    // provider-neutral: the pool pre-starts spares for every provider, never just claude
    expect(h).not.toMatch(/claude/i);
    expect(h).toContain("every worker starts cold");
    // the reason it is off, from the panel's own fields
    expect(h).toContain("why: host down");
    expect(h).not.toContain("rt-tiles");
    expect(h).not.toContain("tasks served");
    // config disabled says so instead of host down
    renderPool({
      enabled: false, hostUp: false, port: 8798, maxSlots: 3, idleKillSecs: 1800,
      hostSince: null, hostLastSeen: null, hostBuiltAt: null, hostStale: false,
      slots: [], totals: { tasksServed: 0, tokensCarried: 0, hitRatio: null, carriedTasks: 0 },
      last24h: { runs: 0, pooled: 0, notPooled: 0, reasons: [], topReason: null, unattributed: 0, poolOff: 0 },
      spares: [], spareClaims: 0, spareMisses: [],
      offReason: "config disabled",
      message: "Pool is OFF (config disabled): every worker starts cold. Turn on with `pai worker pool on`.",
    });
    expect(els.poolpanel.innerHTML).toContain("why: config disabled");
    expect(els.poolpanel.innerHTML).not.toContain("why: host down");
    // enabled or running: the full view still renders, spares and hit shown per provider
    renderPool({
      enabled: true, hostUp: true, port: 8798, maxSlots: 3, idleKillSecs: 1800,
      hostSince: "x", hostLastSeen: "y", hostBuiltAt: null, hostStale: false,
      slots: [], totals: { tasksServed: 2, tokensCarried: 100, hitRatio: 0.5, carriedTasks: 2 },
      last24h: { runs: 4, pooled: 2, notPooled: 2, reasons: [], topReason: null, unattributed: 0, poolOff: 0 },
      spares: [{ provider: "anthropic", ready: 2, starting: 1 }, { provider: "glm", ready: 1, starting: 0 }],
      spareClaims: 2,
      spareMisses: [{ reason: "pane rule: a pane owns every run", misses: 3 }],
      offReason: null,
      message: "up",
    });
    // the shared tile grid (last-row fill), every tile named with its window
    expect(els.poolpanel.innerHTML).toContain("<div class=\"rt-tiles\"");
    expect(els.poolpanel.innerHTML).not.toContain("class=\"kpis\"");
    expect((els.poolpanel.innerHTML.match(/<div class="mt">/g) ?? []).length).toBe(6);
    expect(els.poolpanel.innerHTML).toContain("tasks served · since host start");
    expect(els.poolpanel.innerHTML).toContain("first-request hit · lifetime");
    expect(els.poolpanel.innerHTML).toContain("not pooled · 24 h");
    expect(els.poolpanel.innerHTML).toContain("spares · now");
    expect(els.poolpanel.innerHTML).toContain("spares");
    expect(els.poolpanel.innerHTML).toContain("anthropic 2 ready");
    expect(els.poolpanel.innerHTML).toContain("glm 1 ready");
    expect(els.poolpanel.innerHTML).toContain("first-request hit");
    expect(els.poolpanel.innerHTML).not.toMatch(/claude/i);
  });
});

describe("local server tile and section title", () => {
  const render = (l: Record<string, unknown>, mdl: unknown = null) => {
    const body = COCKPIT_HTML.match(/function renderLimits[\s\S]*?\n\}/)![0];
    const els: Record<string, { innerHTML: string }> = { cloud: { innerHTML: "" }, local: { innerHTML: "" } };
    new Function("lim", "$", "esc", "gauge", "ago", "dur", "mdl", `function keepDowns(){}\n${SH}\n${LT}\n${TH}\n${body}\nrenderLimits();`)(
      { limits: [l] }, (id: string) => els[id], (s: unknown) => String(s ?? ""), () => "", () => "", () => "", mdl);
    return els.local!.innerHTML;
  };
  const live = { provider: "gyro-m", kind: "local", up: true, rssMb: 51601, tokensPerSec: 58.2, served: ["mlx-community/qwen3.8-flash-next-gyro-m"] };
  it("reads like a provider tile: header with name and status, memory in GB, tok/s in one nowrap span, model short name with the id in the title", () => {
    const h = render(live);
    expect(h).toContain('<div class="phead"><span class="lname" title="gyro-m">gyro-m</span><span class="ok nw">● up</span></div>');
    expect(h).toContain('<span class="nw">50.4 GB</span>');
    expect(h).not.toContain(" MB");
    expect(h).toContain('<span class="nw">58 tok/s</span>');
    expect(h).toContain('<span class="nw" title="mlx-community/qwen3.8-flash-next-gyro-m">qwen3.8-flash-next-gyro-m</span>');
    expect(COCKPIT_HTML).toMatch(/\.nw\{white-space:nowrap\}/);
    expect(COCKPIT_HTML).toMatch(/\.ltab\{[^}]*text-align:left/);
  });
  it("the header shows the alias set via models.labels", () => {
    const h = render(live, { runtimes: [{ modelLabels: { "mlx-community/qwen3.8-flash-next-gyro-m": "Gyro" } }], consumers: [] });
    expect(h).toContain('<span class="lname" title="gyro-m">Gyro</span>');
  });
  it("the section is titled 'Limits and local servers' with an explaining tooltip; data-section key unchanged", () => {
    expect(COCKPIT_HTML).toMatch(/<section data-section="cloud" class="card c12"><h2>Limits and local servers<span class="tip"[^>]*data-tip="Cloud usage windows per provider; local model servers"/);
    expect(COCKPIT_HTML).toContain('<section data-section="cloud"');
  });
});

describe("chart text keeps its size at any chart width", () => {
  const get = (n: string) => COCKPIT_HTML.match(new RegExp(`function ${n}\\([\\s\\S]*?\\n\\}\\n`))![0];
  const chartSrc = ["chartW", "chartSvg", "padFor", "fmtAxis", "esc", "gapCols", "gapLayout", "gapMark", "labelStep", "mergeFactor", "mergeLabels", "mergeSeries", "mergeModelBuckets", "aggCap", "barCap", "stackedBars", "twoToneModelBars", "lineChart"].map(get).join("\n");
  const CONSTS = "var MIN_LABEL_GAP_PX=48,MIN_BAR_PX=3,data={bucketMs:300000},KINDS=[[\"input\",\"i\"],[\"cacheWrite\",\"w\"],[\"cacheRead\",\"r\"],[\"output\",\"o\"]];";
  const colorOf = () => "#3b6fe0";
  const fmt = (n: number) => String(n);
  // the page's CSS font-size of svg text: 10 px (svg text{fill:var(--dim);font-size:10px})
  const FONT_PX = (COCKPIT_HTML.match(/svg text\{[^}]*font-size:(\d+)px\}/)![1] as unknown as number) * 1;

  /** The real renderer: stackedBars into a container of the given pixel width. */
  const renderAt = (clientWidth: number): { vbW: number; inner: string; cw: number } => {
    const el: any = { innerHTML: "", clientWidth };
    new Function("el", "$", "colorOf", "fmt", "setHtml", `${SH}\n${CONSTS}\n${chartSrc}\nstackedBars(el,["10h","11h","12h"],[{input:1_570_000_000},{input:1_570_000_000},{input:1_570_000_000}],["input"],760,220);`)(
      el, (id: string) => ({ innerHTML: "" }), colorOf, fmt
    );
    const m = el.innerHTML.match(/<svg width="100%" viewBox="0 0 ([0-9.]+) 220"/);
    return { vbW: m ? +m[1] : 0, inner: el.innerHTML, cw: el.__cw };
  };

  it("the viewBox width is the container's measured pixel width, not the configured canvas width", () => {
    expect(renderAt(400).vbW).toBe(400);
    expect(renderAt(1200).vbW).toBe(1200);
    // an unmeasurable container falls back to the configured width
    expect(renderAt(0).vbW).toBe(760);
  });

  it("the same data at 400 and 1200 px: the axis label font-size in user units equals the CSS px — text does not scale with the chart", () => {
    const a = renderAt(400), b = renderAt(1200);
    // viewBox width == container width: a user unit is one CSS px at both widths, so the
    // CSS font-size (10 px) is 10 user units at either width — the rendered size is constant
    const fontUnits = (r: { vbW: number; cw: number }) => FONT_PX * (r.cw / r.vbW);
    expect(fontUnits(a)).toBe(10);
    expect(fontUnits(b)).toBe(10);
    // the old fixed viewBox scaled the text: 10 px rendered as 10*760/400 at 400 px and
    // 10*760/1200 at 1200 px — the same data at two widths gave different label sizes
    const scaled = (w: number) => FONT_PX * (760 / w);
    expect(scaled(400)).not.toBe(scaled(1200));
    // the axis label text is the same at both widths
    expect(a.inner).toContain(">1.57G</text>");
    expect(b.inner).toContain(">1.57G</text>");
  });

  it("the bars and gridlines span the drawn width at either width", () => {
    const a = renderAt(400), b = renderAt(1200);
    for (const r of [a, b]) {
      // the last column's slot ends at vbW-6; its rect starts 1 px in and ends 1 px short of the slot
      const xs = [...r.inner.matchAll(/<rect x="([0-9.]+)"[^>]*width="([0-9.]+)"/g)].map((m) => +m[1] + +m[2]);
      expect(Math.max(...xs)).toBeCloseTo(r.vbW - 7, 1);
      const grid = [...r.inner.matchAll(/<line x1="[0-9.]+" x2="([0-9.]+)"/g)].map((m) => +m[1]);
      expect(Math.max(...grid)).toBeCloseTo(r.vbW - 6, 1);
    }
  });

  it("the resize path redraws a chart only when its container width changed past the slack, debounced", () => {
    expect(COCKPIT_HTML).toContain("CHART_RESIZE_SLACK_PX=8");
    expect(COCKPIT_HTML).toContain("CHART_RESIZE_DEBOUNCE_MS=150");
    const cr = COCKPIT_HTML.match(/var CHARTS=[^\n]*\n/)![0] + COCKPIT_HTML.match(/function chartResize\(\)\{[\s\S]*?\n\}\n/)![0];
    const el: any = { clientWidth: 500, __cw: 400 }; // grew past the slack
    const el2: any = { clientWidth: 404, __cw: 400 }; // grew within the slack
    const win: any = { render: () => {} };
    let calls = 0;
    win.render = () => calls++;
    const timers: Array<() => void> = [];
    new Function("$", "window", "clearTimeout", "setTimeout", "CHART_RESIZE_SLACK_PX", "CHART_RESIZE_DEBOUNCE_MS", "chartTimer", `${cr}chartResize();`)(
      (id: string) => (id === "series" ? el : id === "daily" ? el2 : { clientWidth: 0 }),
      win,
      () => {},
      (f: () => void) => { timers.push(f); return 1; },
      8, 150, null
    );
    expect(timers.length).toBe(1); // debounced
    timers[0]();
    expect(calls).toBe(1); // series redraws; daily (4 px change) does not
    // the redraw re-measures: __cw is stamped by chartW during the draw
    expect(renderAt(500).cw).toBe(500);
  });

  it("the page wires the chart redraw to a ResizeObserver on main and the resize event", () => {
    expect(COCKPIT_HTML).toContain("new ResizeObserver(chartResize).observe(document.querySelector(\"main\"))");
    expect(COCKPIT_HTML).toContain('window.addEventListener("resize",chartResize)');
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

describe("readable time axes, power chart under System, tokens chart at half width", () => {
  const get = (n: string) => COCKPIT_HTML.match(new RegExp(`function ${n}\\([\\s\\S]*?\\n\\}\\n`))![0];
  const src = ["chartW", "chartSvg", "padFor", "fmtAxis", "esc", "gapCols", "gapLayout", "gapMark", "labelStep", "mergeFactor", "mergeLabels", "mergeSeries", "mergeModelBuckets", "aggCap", "barCap", "trimEmpty", "emptyChart", "stackedBars", "twoToneModelBars", "lineChart"].map(get).join("\n");
  const CONSTS = 'var MIN_LABEL_GAP_PX=48,MIN_BAR_PX=3,data={bucketMs:300000},KINDS=[["input","i"],["cacheWrite","w"],["cacheRead","r"],["output","o"]];';
  const run = (body: string, el: any) => new Function("el", "$", "colorOf", "fmt", "setHtml", `${SH}\n${CONSTS}\n${src}\n${body}`)(el, () => ({ innerHTML: "" }), () => "#3b6fe0", String);
  const stamps = (n: number) => Array.from({ length: n }, (_, i) => `${String(Math.floor(i / 12) + 6).padStart(2, "0")}:${String((i % 12) * 5).padStart(2, "0")}`);
  const xs = (html: string, y: number) => [...html.matchAll(new RegExp(`<text x="([0-9.]+)" y="${y}" text-anchor="middle">`, "g"))].map((m) => +m[1]);
  const minGap = (v: number[]) => Math.min(...v.slice(1).map((x, i) => x - v[i]));

  it("lineChart thins time labels by the real width: >= 48 px apart at 385 px, every bucket still labelled at 1200 px", () => {
    const labels = stamps(60), series = labels.map((_, i) => ({ totalW: 10 + i, gpu: 5, cpu: 5 }));
    const keys = [["totalW", "power W", "#d98a1c", 0], ["gpu", "GPU", "#3b6fe0", 1]];
    const at = (w: number) => { const el: any = { innerHTML: "", clientWidth: w }; run(`lineChart(el,${JSON.stringify(labels)},${JSON.stringify(series)},${JSON.stringify(keys)},760,150);`, el); return xs(el.innerHTML, 146); };
    const narrow = at(385), wide = at(1200);
    expect(narrow.length).toBeGreaterThan(1);
    expect(minGap(narrow)).toBeGreaterThanOrEqual(48);
    expect(minGap(wide)).toBeGreaterThanOrEqual(48);
    expect(wide.length).toBeGreaterThan(narrow.length);
    expect(at(4000).length).toBe(60);
  });

  it("stackedBars and twoToneModelBars thin their labels too", () => {
    const labels = stamps(24), kinds = ["input", "output"];
    const series = labels.map((_, i) => ({ input: 100 + i, output: 50 }));
    const el: any = { innerHTML: "", clientWidth: 385 };
    run(`stackedBars(el,${JSON.stringify(labels)},${JSON.stringify(series)},${JSON.stringify(kinds)},760,220);`, el);
    const v = xs(el.innerHTML, 216);
    expect(v.length).toBeGreaterThan(1);
    expect(minGap(v)).toBeGreaterThanOrEqual(48);
  });

  it("merging buckets keeps every bar >= minBarPx and the caption names the bucket size", () => {
    const labels = stamps(144); // 12 h of 5-minute buckets
    const buckets = labels.map((_, i) => [{ model: "a", requests: 1, input: 10 + i, cacheWrite: 0, cacheRead: 5, output: 3, total: 18 + i }, { model: "b", requests: 2, input: 4, cacheWrite: 0, cacheRead: 0, output: 1, total: 5 }]);
    const barW = (html: string) => [...html.matchAll(/<rect [^>]*width="([0-9.]+)"/g)].map((m) => +m[1]);
    for (const w of [385, 822, 1200]) {
      const el: any = { innerHTML: "", clientWidth: w, id: "series" };
      const cap = run(`return twoToneModelBars(el,${JSON.stringify(labels)},${JSON.stringify(buckets)},["a","b"],760,220);`, el);
      const widths = barW(el.innerHTML).filter((x) => x > 1.5);
      expect(Math.min(...widths)).toBeGreaterThanOrEqual(3);
      if (w === 385) { expect(cap).toMatch(/^\d+-minute buckets$/); expect(parseInt(cap, 10)).toBeGreaterThan(5); expect(el.__agg).toBeGreaterThan(1); }
    }
    // merged totals are conserved: the tallest 385 px bar equals the sum of its merged buckets
    const el: any = { innerHTML: "", clientWidth: 385, id: "series" };
    run(`twoToneModelBars(el,${JSON.stringify(labels)},${JSON.stringify(buckets)},["a","b"],760,220);`, el);
    const f = el.__agg as number;
    const sumA = Array.from({ length: f }, (_, i) => 18 + (144 - f + i)).reduce((a, b) => a + b, 0);
    expect(sumA).toBeGreaterThan(0);
    const wide: any = { innerHTML: "", clientWidth: 1200, id: "series" };
    expect(run(`return twoToneModelBars(el,${JSON.stringify(labels.slice(0, 48))},${JSON.stringify(buckets.slice(0, 48))},["a","b"],760,220);`, wide)).toBe(false);
    expect(wide.__agg).toBe(1);
  });

  it("the caption shows a merged-bucket text via chartCap", () => {
    const cap = get("chartCap");
    const el: any = { innerHTML: "" };
    new Function("el", `${SH}\n${cap}\nchartCap(el,"10-minute buckets");`)(el);
    expect(el.innerHTML).toContain("10-minute buckets");
    expect(el.innerHTML).not.toContain("idle hours");
  });

  it("the power chart sits in the System section, between the KPI tiles and the server table; tokens holds none", () => {
    const sys = COCKPIT_HTML.match(/<section data-section="system"[\s\S]*?<\/section>/)![0];
    const tok = COCKPIT_HTML.match(/<section data-section="tokens"[\s\S]*?<\/section>/)![0];
    expect(sys).toContain('id="power"');
    expect(sys).toContain('id="plegend"');
    expect(sys.indexOf('id="sys"')).toBeLessThan(sys.indexOf('id="power"'));
    expect(sys.indexOf('id="power"')).toBeLessThan(sys.indexOf('id="sysservers"'));
    expect(tok).not.toContain('id="power"');
    expect(tok).not.toContain("Power and GPU/CPU load");
    expect(tok).toContain('id="series"');
  });
});

describe("cockpit tables read at any width (sessions, worker runs, speed, providers)", () => {
  const tableSrc = COCKPIT_HTML.match(/function table\([\s\S]*?\n\}\n/)![0];
  const fn = (n: string) => COCKPIT_HTML.match(new RegExp("function " + n + "\\([^]*?\\n\\}\\n"))![0];
  const vcls = COCKPIT_HTML.match(/function vcls\([\s\S]*?\n/)![0];
  const store: Record<string, string> = {};
  const localStorage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } };
  const mount = (data: unknown, call: string, id: string, extra = "") => {
    const els: Record<string, { innerHTML: string; onclick?: unknown }> = {};
    const $ = (i: string) => (els[i] ??= { innerHTML: "" });
    const src = `${tableSrc}\n${vcls}\n${fn("vshort")}\n${RENDERERS}\n${fn("renderSpeed")}\n${extra}\nvar SESSION_ROWS=100,WORKER_ROWS=15;\nreturn function(){${call}};`;
    const run = new Function("data", "$", "setHtml", "esc", "fmt", "pct", "tot", "cls", "hitCls", "ERROR_WARN", "ERROR_BAD", "ago", "localStorage", "sys", "provHit", src)(
      data, $, (el: { innerHTML: string }, h: string) => { el.innerHTML = h; return true; },
      (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"),
      (n: number) => String(n), (x: number) => Math.round(x * 100) + "%",
      (t: any) => t.input + t.output + t.cacheWrite + t.cacheRead, () => "", () => "", 0.02, 0.1, () => "1m", localStorage, null,
      (p: any) => String(Math.round(p.hitRatio * 100)) + "%"
    ) as () => void;
    return { run, el: () => els[id]!, els };
  };
  const sess = (i: number, tokens: number, over: Record<string, unknown> = {}) => ({
    name: i < 3 ? `named-${i}` : "", session: `s${String(i).padStart(7, "0")}`, models: ["glm-5.3-flash"], requests: 1,
    input: tokens, cacheWrite: 0, cacheRead: 0, output: 0, hitRatio: 0, busts: 0, errors: 0, lastTs: "2026-10-21T07:00:00Z", ...over,
  });

  it("sessions: top rows by tokens, the rest fold into one '+N more sessions (X tokens)' row that expands on click and stays expanded across refresh", () => {
    delete store["pai.cockpit.sessmore"];
    const rows = Array.from({ length: 25 }, (_, i) => sess(i, 1000 - i * 10));
    const m = mount({ bySession: rows }, "renderSessions(data)", "sessions");
    m.run();
    let html = m.el().innerHTML;
    expect((html.match(/<tr>/g) ?? []).length).toBe(10 + 1 + 1); // header row + 10 + the fold row
    expect(html).toContain("+15 more sessions (");
    expect(html).toContain("width:35%;max-width:0");
    const rest = rows.slice(10).reduce((a, s) => a + s.input, 0);
    expect(html).toContain(`(${rest} tokens)`);
    // click: the delegated handler stores the state and redraws expanded
    (m.el().onclick as (e: unknown) => void)({ target: { getAttribute: (a: string) => (a === "data-sessmore" ? "1" : null), parentNode: null }, preventDefault() {} });
    html = m.el().innerHTML;
    expect((html.match(/<tr>/g) ?? []).length).toBe(25 + 1 + 1);
    expect(html).toContain("show fewer sessions");
    // refresh keeps the state
    m.run();
    expect(m.el().innerHTML).toContain("show fewer sessions");
    delete store["pai.cockpit.sessmore"];
  });

  it("sessions: the models cell shows the first model + N with the full list in its title; the name carries the full name in a title", () => {
    delete store["pai.cockpit.sessmore"];
    const m = mount({ bySession: [sess(0, 5, { models: ["claude-opus-5-5", "claude-haiku-5-5", "glm-5.3"], name: "a very long session name" })] }, "renderSessions(data)", "sessions");
    m.run();
    const html = m.el().innerHTML;
    expect(html).toContain('<span title="claude-opus-5-5, claude-haiku-5-5, glm-5.3">claude-opus-5-5 <span class="dim">+2</span></span>');
    expect(html).toContain('title="a very long session name · s0000000"');
    expect(html).not.toContain("more sessions");
  });

  describe("worker runs as compact grouped rows", () => {
    const WR = () => `${fn("workerGroups")}\n${fn("wrFolded")}\nvar WR_FOLD_KEY="pai.cockpit.wrfold";\n${fn("dur")}`;
    const run = (id: string, over: Record<string, unknown> = {}) => ({
      worker: id, name: `label ${id}`, workerProvider: "glm", models: ["glm-5.3-flash"], requests: 4, hitRatio: 0.5,
      input: 100, cacheWrite: 0, cacheRead: 0, output: 0, verdict: "ok", workerParent: "PAI", workerStart: 1000, workerEnd: 61000, ...over,
    });
    const mountWr = (workers: unknown[]) => mount({ workers }, "renderWorkers(data)", "workers", WR());

    it("groups per spawning session, newest run first, groups by their newest run; the header shows run count and weighted total", () => {
      delete store["pai.cockpit.wrfold"];
      const m = mountWr([run("old", { workerStart: 1000 }), run("a-new", { workerParent: "AIBroker", workerStart: 9000 }), run("new", { workerStart: 5000 })]);
      m.run();
      const h = m.el().innerHTML;
      expect(h.indexOf("data-wrfold=\"AIBroker\"")).toBeLessThan(h.indexOf("data-wrfold=\"PAI\""));
      expect(h.indexOf("label new")).toBeLessThan(h.indexOf("label old"));
      expect(h).toContain("2 runs · 200"); // weighted: input x1
      expect(h).toContain("1 run · 100");
      expect(h).not.toContain("<table");
    });

    it("bar widths share one scale; the number sits beside the bar; the label carries the full text in a tooltip", () => {
      const m = mountWr([run("big", { input: 400, output: 20 }), run("small", { input: 100 })]); // big = 400 + 20*5
      m.run();
      const h = m.el().innerHTML;
      expect(h).toContain('<i style="width:100%"></i>');
      expect(h).toContain('<i style="width:20%"></i>'); // 100 / 500
      expect(h).toContain('<span class="wr-n">500</span>');
      expect(h).toContain('title="label big · run big · glm · ok"');
      expect(h).toContain('<span class="wr-du">1m 00s</span>');
      expect(h).toContain('<span class="badge" title="glm-5.3-flash">glm-5.3-flash</span>');
    });

    it("status dot: running, ok, failed; missing values render as a dash", () => {
      const m = mountWr([
        run("r", { verdict: "running", workerEnd: null, workerStart: Date.now() }), run("o"), run("f", { verdict: "failed" }),
        run("x", { verdict: null, models: [], requests: 0, input: 0, workerStart: null, workerEnd: null, workerParent: null }),
      ]);
      m.run();
      const h = m.el().innerHTML;
      expect(h).toContain("wr-dot wr-run");
      expect(h).toContain("wr-dot wr-ok");
      expect(h).toContain("wr-dot wr-bad");
      const x = h.slice(h.indexOf('data-wrfold="other"'));
      expect(x).toContain('<span class="badge" title="no model">–</span>');
      expect(x).toContain('<span class="wr-n">–</span>');
      expect(x).toContain('<span class="wr-du">–</span>');
      expect(x).toContain('title="cache hit">–</span>');
      expect(x).toContain('<i style="width:0%"></i>');
    });

    it("a group header click folds the group; the state survives a refresh", () => {
      delete store["pai.cockpit.wrfold"];
      const m = mountWr([run("a")]);
      m.run();
      (m.el().onclick as (e: unknown) => void)({ target: { getAttribute: (a: string) => (a === "data-wrfold" ? "PAI" : null), parentNode: null }, preventDefault() {} });
      expect(m.el().innerHTML).not.toContain("wr-row");
      expect(m.el().innerHTML).toContain("▸");
      m.run();
      expect(m.el().innerHTML).not.toContain("wr-row");
      delete store["pai.cockpit.wrfold"];
    });

    it("empty window keeps the empty state", () => {
      const m = mountWr([]);
      m.run();
      expect(m.el().innerHTML).toContain("no worker sessions in this window");
    });
  });

  it("speed: bars, not a table; renderSpeed follows the window and marks local servers", () => {
    const h = (r: number, t: number | null) => ({ requests: r, ttftP50: t, ttftP90: t == null ? null : t * 2, readTps: t == null ? null : 100, writeTps: t == null ? null : 40 });
    const m = mount({ speed: [{ provider: "glm", model: "glm-5.3", h1: h(3, 400), h24: h(30, 500) }, { provider: "anthropic", model: "opus", h1: h(0, null), h24: h(2, 900) }] }, "renderSpeed()", "speed", fn("speedBars") + "\nvar win=\"1h\",lim=null;");
    m.run();
    const html = m.el().innerHTML;
    expect(html).not.toContain("<table");
    expect(html).toContain("0.4 s (p90 0.8 s)");
    expect(html).toContain("last hour");
  });

  it("providers: provider, req, err%, hit% by default; retries, avg ms, ttft p50 and tokens in the provider cell's title", () => {
    const p = { provider: "glm", requests: 10, errors: 1, retries: 2, avgMs: 1200, ttftP50: 300, input: 5, output: 1, cacheWrite: 0, cacheRead: 4, hitRatio: 0.8 };
    const m = mount({ byProvider: [p], bustParts: {} }, "renderProviders(data)", "providers");
    m.run();
    const html = m.el().innerHTML;
    expect([...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((x) => x[1])).toEqual(["provider", "req", "err%", "hit%"]);
    expect(html).toContain('title="retries 2 · avg 1200 ms · ttft p50 300 ms · tokens 10"');
    expect(html).toContain('<span class="warn">↻2</span>');
    expect(html).not.toContain("<th>avg ms</th>");
  });
});

describe("runtime start/stop progress on the card", () => {
  const WATCH_SRC = COCKPIT_HTML.match(/function watchJob\(id\)\{[\s\S]*?\n\}\n/)![0];
  type Fake = { textContent: string; title: string; className: string };
  // one card's action span: a .msg and two buttons, found by the selectors the page uses
  const makeAct = (rt: string) => {
    const msg: Fake = { textContent: "", title: "", className: "msg" };
    const btns = [{ disabled: false }, { disabled: false }];
    const act = { getAttribute: (k: string) => (k === "data-rt" ? rt : null), querySelector: (s: string) => (s === ".msg" ? msg : null), querySelectorAll: (s: string) => (s === "button" ? btns : []) };
    return { act, msg, btns };
  };
  function harness(jobs: unknown[]) {
    const state = { card: makeAct("ollama"), loads: 0, fetched: [] as string[] };
    const root = {
      querySelectorAll: (s: string) => (s === ".act[data-rt]" ? [state.card.act] : []),
    };
    const queue = [...jobs];
    const timers: Array<() => void> = [];
    const fn = new Function(
      "$", "fetch", "loadModels", "setTimeout", "JOB_TRIES", "JOB_POLL", "JOB_FIRST", "CONFIRM_MS",
      `${ACT_STATE_SRC}\n${WATCH_SRC}\nreturn { watchJob: watchJob, reapplyActs: reapplyActs };`
    );
    const api = fn(
      () => root,
      (url: string) => { state.fetched.push(url); const j = queue.length > 1 ? queue.shift() : queue[0]; return Promise.resolve({ json: () => Promise.resolve(j) }); },
      () => { state.loads++; },
      (f: () => void) => { timers.push(f); return 0; },
      120, 5000, 2000, 4000
    ) as { watchJob: (id: string) => void; reapplyActs: (r: unknown) => void };
    // run the pending poll and let its promise chain settle
    const poll = async () => { timers.shift()!(); await new Promise((r) => setTimeout(r, 0)); };
    const rerender = () => { state.card = makeAct("ollama"); api.reapplyActs(root); };
    return { state, api, poll, rerender, timers };
  }
  const running = { id: "j1", kind: "runtime", runtime: "ollama", op: "start", state: "running", message: "start ollama", elapsedSec: 23, tail: "loading shard 2/4" };

  it("a running start job shows 'starting… N s · last log line' and disables the buttons, also after the 5 s poll re-render", async () => {
    const h = harness([running]);
    h.api.watchJob("j1");
    await h.poll();
    expect(h.state.card.msg.textContent).toBe("starting… 23 s · loading shard 2/4");
    expect(h.state.card.btns.every((b) => b.disabled)).toBe(true);
    h.rerender();
    expect(h.state.card.msg.textContent).toBe("starting… 23 s · loading shard 2/4");
    expect(h.state.card.btns.every((b) => b.disabled)).toBe(true);
    expect(h.state.loads).toBe(0);
  });

  it("a stop job reads 'stopping…'", async () => {
    const h = harness([{ ...running, op: "stop", elapsedSec: 1, tail: "" }]);
    h.api.watchJob("j1");
    await h.poll();
    expect(h.state.card.msg.textContent).toBe("stopping… 1 s");
  });

  it("when the job ends the result message stays through re-renders, the buttons are free again and the inventory is reloaded", async () => {
    const h = harness([running, { ...running, state: "done", message: "ollama up (http://127.0.0.1:11434/api/tags)" }]);
    h.api.watchJob("j1");
    await h.poll();
    await h.poll();
    expect(h.state.loads).toBe(1);
    expect(h.state.card.msg.textContent).toBe("ollama up (http://127.0.0.1:11434/api/tags)");
    h.rerender();
    expect(h.state.card.msg.textContent).toBe("ollama up (http://127.0.0.1:11434/api/tags)");
    expect(h.state.card.msg.className).toBe("msg");
    expect(h.state.card.btns.some((b) => b.disabled)).toBe(false);
  });

  it("a failed job shows the error text styled bad", async () => {
    const h = harness([{ ...running, state: "failed", message: "ollama start exited (7); see /logs/local/ollama.log" }]);
    h.api.watchJob("j1");
    await h.poll();
    h.rerender();
    expect(h.state.card.msg.textContent).toContain("see /logs/local/ollama.log");
    expect(h.state.card.msg.className).toBe("msg bad");
  });

  it("a runtime job the server reports as running is watched on load (busy state comes from noteMsg, covered by the reapplyActs tests)", () => {
    const watched: string[] = [];
    const h = stopHarness({
      at: "x",
      runtimes: [{ name: "ollama", kind: "ollama", status: "running", port: 11434, users: ["c"], models: [{ model: "qwen3:8b", kind: "chat", loaded: true, memoryMb: 5000, usedBy: ["c"] }] }],
      runtimeCommands: { ollama: { start: "ollama serve", stop: "kill" } },
      consumers: [{ name: "c", runtime: "ollama", model: "qwen3:8b", label: "C" }],
      duplicates: [],
      live: { at: 1, runtimes: [] },
      runtimeJobs: { ollama: { id: "j9", op: "stop", elapsedSec: 4, tail: "unloading" } },
    }, 4000, watched);
    expect(watched).toEqual(["j9"]);
    expect(h.stopBtn("ollama")).toBeTruthy();
  });

  it("the runtime buttons sit in a header span that has its own .msg element (the action text has somewhere to land)", () => {
    const h = stopHarness({
      at: "x",
      runtimes: [{ name: "ollama", kind: "ollama", status: "running", port: 11434, users: ["c"], models: [{ model: "qwen3:8b", kind: "chat", loaded: true, memoryMb: 5000, usedBy: ["c"] }] }],
      runtimeCommands: { ollama: { start: "ollama serve", stop: "kill" } },
      consumers: [{ name: "c", runtime: "ollama", model: "qwen3:8b", label: "C" }],
      duplicates: [],
      live: { at: 1, runtimes: [] },
    });
    const btn = h.stopBtn("ollama");
    const act = btn.parentNode;
    expect(act.classes.has("rt-act")).toBe(true);
    expect(act.children.some((c: any) => c.classes.has("msg"))).toBe(true);
  });
});

describe("local server tiles say why they are empty", () => {
  it("end-to-end tile carries the window reason and the 24 h counts; prefix cache says the server reports none", () => {
    expect(COCKPIT_HTML).toContain("no requests in the last hour (24 h: ");
    expect(COCKPIT_HTML).toContain("ttft p50 ");
    expect(COCKPIT_HTML).toContain("server reports no prefix-cache counter");
  });
});

describe("cockpit Models: instances per model", () => {
  const src = [
    COCKPIT_HTML.match(/function metricSpark[\s\S]*?\n\}/)![0],
    COCKPIT_HTML.match(/function metricTile[\s\S]*?\n\}/)![0],
    COCKPIT_HTML.match(/function shortModel\([\s\S]*?\n\}/)![0],
    COCKPIT_HTML.match(/function actRow[\s\S]*?\n\}/)![0],
    COCKPIT_HTML.match(/function tierRow[\s\S]*?\n\}/)![0],
    COCKPIT_HTML.match(/function gb\(b,d\)\{[^\n]*\}/)![0],
    COCKPIT_HTML.match(/function gbm\(m\)\{[^\n]*\}/)![0],
    COCKPIT_HTML.match(/function modelsHtml[\s\S]*?\n\}/)![0],
  ].join("\n");
  const modelsHtml = new Function("esc", "pct", `${src}; return modelsHtml;`)(
    (s: unknown) => String(s ?? ""),
    (x: number) => (x * 100).toFixed(1) + "%"
  ) as (inv: unknown) => string;
  const tiers = [
    { tier: "gyro-m", label: "Gyro-M", memoryGb: 60, maxInstances: 2 },
    { tier: "small", label: "Small" },
  ];
  const inst = (id: string, inflight: number) => ({ id, model: "gyro-m", port: 8035, pid: 11, state: "ready", inflight });
  const base = { at: "x", duplicates: [], consumers: [], live: { at: 1, runtimes: [] }, tiers, runtimes: [], running: null };

  it("a stopped catalogue model is a startable row; no stop, scale down disabled", () => {
    const h = modelsHtml({ ...base, instances: [] });
    expect(h).toContain('data-a="local.start" data-t="small"');
    expect(h).not.toContain('data-a="local.stop"');
    expect(h).toMatch(/data-a="local.scale" data-t="small" data-v="0" disabled/);
    expect(h).toContain('data-a="local.scale" data-t="small" data-v="1"');
  });

  it("a running model shows its instances (port, pid, in flight); stop with requests in flight arms a confirm and sends value=confirm", () => {
    const h = modelsHtml({ ...base, instances: [inst("gyro-m#1", 2), inst("gyro-m#2", 0)] });
    expect(h).toContain("gyro-m#1");
    expect(h).toContain(":8035 · pid 11");
    expect(h).toContain("2 in flight");
    expect(h).toContain('data-a="local.stop" data-t="gyro-m#1" data-confirm="2 in flight - click again to stop" data-v="confirm"');
    expect(h).toContain('data-a="local.stop" data-t="gyro-m#2">');
    expect(h).toContain('data-a="local.stop" data-t="gyro-m" data-confirm="2 requests in flight - click again to stop" data-v="confirm"');
    // at maxInstances the start and + buttons are off
    expect(h).toMatch(/data-a="local.start" data-t="gyro-m" disabled/);
    expect(h).toMatch(/data-a="local.scale" data-t="gyro-m" data-v="3" disabled/);
  });
});
