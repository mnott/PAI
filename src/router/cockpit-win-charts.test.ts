/**
 * B9 `tokens` + `daily`: the real page with  shows two chart cards drawn at the card's own pixel size;
 * mode toggle (aria-pressed), model Select, caption and legend slots, no box change on updates. Headless Chromium, skipped when none is installed.
 * PAI_WIN_SHOTS=<dir> writes charts-<width>.png.
 */

import { execFile, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cockpitHtml } from "./cockpit-page.js";

const CHROME = process.env.CHROME_BIN ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));

const models = ["claude-opus", "gyro-m"];
const bucket = (i: number) => ({ t: 1_700_000_000_000 + i * 600_000, models: { "claude-opus": { requests: 3, input: 1000 * i, output: 500, cacheRead: 9000, cacheWrite: 100 }, "gyro-m": { requests: 2, input: 200 * i, output: 300, cacheRead: 100, cacheWrite: 0 } } });
const data = (k = 1) => ({
  window: "1h", totals: { requests: 5000 * k, input: 9e6, output: 4e5, cacheWrite: 1e6, cacheRead: 9e7, errors: 10, hitRatio: 0.9 },
  byModel: models.map((m) => ({ model: m, requests: 10, input: 1, output: 1, cacheRead: 1, cacheWrite: 1 })), series: [1, 2, 3, 4, 5, 6].map(bucket),
  weights: { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 }, cachePause: [], byProvider: [], bustParts: {}, bySession: [], workers: [],
  daily: { models: { "claude-opus": [5e6, 6e6 * k, 7e6, 4e6], "gyro-m": [1e6, 2e6, 0, 3e6] }, days: [1, 2, 3, 4].map((d) => 1_700_000_000_000 + d * 86_400_000) },
  sessionSplit: null, promptByProvider: {}, promptSince: {}, speed: [],
});

const PROBE = `<script>setTimeout(function(){try{
function box(id){var c=document.querySelector('#win-root [data-card="'+id+'"]'),r=c.getBoundingClientRect();return[r.left,r.top,r.width,r.height].map(Math.round).join(",")}
function info(id){var c=document.querySelector('#win-root [data-card="'+id+'"]'),s=c.querySelector("svg"),b=c.querySelector(".cbody").getBoundingClientRect();
 return{svgW:s?+s.getAttribute("width"):0,svgH:s?+s.getAttribute("height"):0,bodyW:Math.round(b.width),rects:c.querySelectorAll("svg rect").length,cap:c.querySelector('[data-k="cap"]').textContent,legend:c.querySelectorAll('[data-k="legend"] span').length,
  heads:Array.prototype.map.call(c.querySelectorAll(".chead > *"),function(k){return k.className.split(" ")[0]}),pressed:Array.prototype.map.call(c.querySelectorAll("[aria-pressed][data-act]"),function(k){return k.getAttribute("data-act")+"="+k.getAttribute("aria-pressed")}).join(",")}}
var o={err:window.__err||null,tokens:info("tokens"),daily:info("daily"),
 selects:document.querySelectorAll("#win-root select").length,boxes:box("tokens")+"|"+box("daily"),rectsTwoTone:0};
var rawBtn=document.querySelector('#win-root [data-card="tokens"] [data-act="mode-raw"]');rawBtn.click();o.afterRaw=info("tokens");o.modeSaved=localStorage.getItem("cockpitMode");
window.Win.update("data",window.WINPAY);o.boxes2=box("tokens")+"|"+box("daily");o.tokens2=info("tokens");
var sel=document.querySelector('#win-root [data-card="tokens"] .wsel-btn');sel.click();var opt=document.querySelectorAll(".wpop .wopt");o.opts=Array.prototype.map.call(opt,function(x){return x.textContent});opt[2].click();o.afterSel=info("tokens");o.selLabel=sel.textContent;
document.body.setAttribute("data-r",JSON.stringify(o));
}catch(e){document.body.setAttribute("data-r",JSON.stringify({err:String(e.stack)}))}},1500)</script>`;

let server: Server;
let base = "";
let tmp = "";
const browsers = new Set<ChildProcess>();
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "cockpit-win-charts-"));
  server = createServer((req, res) => {
    const url = req.url ?? "";
    res.setHeader("content-type", "application/json");
    if (url.startsWith("/cockpit/data")) return res.end(JSON.stringify(data()));
    if (url.startsWith("/cockpit/")) return res.end("{}");
    if (url.startsWith("/page")) {
      res.setHeader("content-type", "text/html");
      return res.end(cockpitHtml().replace("</head>", '<script>window.onerror=function(m,s,l,c){window.__err=String(m)+" @"+l+":"+c}</script></head>').replace("</body>", "<script>window.WINPAY=" + JSON.stringify(data(2)) + "</script>" + PROBE + "</body>"));
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => { for (const c of browsers) c.kill("SIGKILL"); server?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = execFile(CHROME!, args, { encoding: "utf8", timeout: 60_000, maxBuffer: 64 << 20 }, (err, stdout) => { browsers.delete(c); err ? reject(err) : resolve(stdout); });
    browsers.add(c);
  });
}
async function open(query: string, width: number, shot?: string) {
  const args = ["--headless=new", "--disable-gpu", "--use-mock-keychain", "--password-store=basic", "--no-first-run", "--hide-scrollbars", `--user-data-dir=${join(tmp, "p" + Math.random().toString(36).slice(2))}`, `--window-size=${width},900`, "--virtual-time-budget=6000"];
  const url = `${base}/page${query}`;
  const dom = await run([...args, "--dump-dom", url]);
  if (shot) await run([...args, `--screenshot=${shot}`, url]);
  const m = /data-r="([^"]*)"/.exec(dom);
  if (!m) throw new Error("no probe result in dump: " + dom.slice(-600));
  return JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
}


describe.skipIf(!CHROME)("B9 tokens + daily on the win runtime", () => {
  it("draws both charts at the card's pixel size; the toggle, the Select and the update change the svg, never a box", async () => {
    const shots = process.env.PAI_WIN_SHOTS;
    const r = await open("", 1400, shots ? join(shots, "charts-1400.png") : undefined);
    expect(r.err).toBeNull();
    expect(r.selects).toBe(0);
    // the svg is exactly the card body's width (no viewBox scaling, nothing measured by the chart)
    expect(r.tokens.svgW).toBe(r.tokens.bodyW);
    expect(r.daily.svgW).toBe(r.daily.bodyW);
    expect(r.tokens.rects).toBeGreaterThan(0);
    expect(r.daily.rects).toBeGreaterThan(0);
    expect(r.tokens.legend).toBeGreaterThan(4);
    expect(r.daily.legend).toBe(2);
    expect(r.tokens.heads).toEqual(["cgrip", "ctitle", "cstatus", "cbtn", "cbtn", "wctl", "cbtn"]);
    expect(r.daily.heads).toEqual(["cgrip", "ctitle", "cstatus", "cbtn"]);
    expect(r.tokens.pressed).toBe("mode-weighted=true,mode-raw=false");
    // raw: pressed flips, mode saved, legend has no price ratios
    expect(r.afterRaw.pressed).toBe("mode-weighted=false,mode-raw=true");
    expect(r.modeSaved).toBe("raw");
    // a value-only payload moves no box
    expect(r.boxes2).toBe(r.boxes);
    // the Select lists all models then each model; picking one switches to the stacked kinds chart (4 kinds in the legend)
    expect(r.opts).toEqual(["all models", "claude-opus", "gyro-m"]);
    expect(r.selLabel).toContain("gyro-m");
    expect(r.afterSel.legend).toBe(5); // the caption + 4 kinds, no model legend
  }, 120_000);
});

// ---- C1 restored guards: chart thinning and sparkline (the page's own functions, node only) ----
import { COCKPIT_HTML as PAGE } from "./cockpit-page.js";
import { WIN_CHARTS_JS } from "./cockpit-page/win/cards-charts.js";
import { fnSrc, varSrc } from "./cockpit-page-src.js";

const FNS = ["esc", "fmt", "fmtAxis", "padFor", "labelStep", "mergeFactor", "mergeLabels", "mergeSeries", "aggCap", "gapCols", "gapLayout", "gapMark", "barCap", "stackedBarsSvg"];
const chartLib = () => new Function(`var data={bucketMs:60000};function colorOf(){return"#3b6fe0"}\n${varSrc(PAGE, "MIN_LABEL_GAP_PX")}\n${FNS.map((n) => fnSrc(PAGE, n)).join("\n")}\nreturn{stackedBarsSvg:stackedBarsSvg,MIN_BAR_PX:MIN_BAR_PX,MIN_LABEL_GAP_PX:MIN_LABEL_GAP_PX};`)() as {
  stackedBarsSvg: (ref: unknown, cw: number, labels: string[], series: Record<string, number>[], keys: string[], h: number, head: string) => { html: string; cap: string | false; agg: number };
  MIN_BAR_PX: number; MIN_LABEL_GAP_PX: number;
};
const buckets = (n: number) => ({ labels: Array.from({ length: n }, (_, i) => `b${i}`), series: Array.from({ length: n }, (_, i) => ({ a: 10 + (i % 7) })) });

describe("C1 guards: charts", () => {
  // w=4 chart thinning: labels keep MIN_LABEL_GAP_PX apart on a narrow card and all show on a wide one; merged bars stay >= MIN_BAR_PX and the caption names the bucket size.
  it("thins the time labels to the gap, merges bars to the minimum width, and redraws at the measured width", () => {
    const L = chartLib(), { labels, series } = buckets(24);
    const xs = (html: string) => [...html.matchAll(/<text x="([\d.]+)" y="\d+" text-anchor="middle"/g)].map((m) => Number(m[1]));
    const narrow = xs(L.stackedBarsSvg({ id: "series" }, 385, labels, series, ["a"], 200, "<svg>").html);
    expect(narrow.length).toBeGreaterThan(1);
    expect(narrow.length).toBeLessThan(24);
    for (let i = 1; i < narrow.length; i++) expect(narrow[i]! - narrow[i - 1]!).toBeGreaterThanOrEqual(L.MIN_LABEL_GAP_PX - 0.5);
    expect(xs(L.stackedBarsSvg({ id: "series" }, 1200, labels, series, ["a"], 200, "<svg>").html).length).toBe(24);

    const big = buckets(400), r = L.stackedBarsSvg({ id: "series" }, 385, big.labels, big.series, ["a"], 200, "<svg>");
    expect(r.agg).toBeGreaterThan(1);
    expect(r.cap).toBe(`${r.agg}-minute buckets`);
    const widths = [...r.html.matchAll(/<rect [^>]*width="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(widths.length).toBeGreaterThan(0);
    for (const w of widths) expect(w).toBeGreaterThanOrEqual(L.MIN_BAR_PX - 0.05);

    // the resize hook redraws at the width it is handed: the svg viewBox width follows the container
    const painted: string[] = [];
    const src = `var T={},WCH={},WinT={leaf:function(){},split:function(){}},WinA={},Win={};var DAILY_DAYS=14,mode="weighted",msel="";function assignColors(){}\n${fnSrc(PAGE, "label")}\n${FNS.map((n) => fnSrc(PAGE, n)).join("\n")}\nvar data={bucketMs:60000};function colorOf(){return"#3b6fe0"}\n${varSrc(PAGE, "MIN_LABEL_GAP_PX")}\n${WIN_CHARTS_JS}\nreturn WCHX.daily;`;
    const hook = new Function(src)() as { update: Function; resize: Function };
    const d = { byModel: [], speed: [], daily: { models: { m: [1, 2, 3, 4] }, days: [1, 2, 3, 4].map((i) => 1_700_000_000_000 + i * 86_400_000) } };
    const ctx = { id: "daily", html: (k: string, h: string) => { if (k === "svg") painted.push(h); } };
    hook.update(ctx, d);
    hook.resize(ctx, 640, 300);
    hook.resize(ctx, 385, 300);
    expect(painted.map((h) => /viewBox="0 0 (\d+) \d+"/.exec(h)![1])).toEqual(["640", "385"]);
  });

  // w=4b sparkline: a null point is interpolated into one continuous path; leading and trailing nulls drop.
  it("metricSpark interpolates a null point and drops leading and trailing nulls", () => {
    const spark = new Function(`${fnSrc(PAGE, "esc")}\n${fnSrc(PAGE, "metricSpark")}\nreturn metricSpark;`)() as (s: unknown[]) => string;
    const html = spark([{ data: [null, 2, null, 4, null] }]);
    const line = /class="line[^"]*"[^>]* d="([^"]+)"/.exec(html)![1]!;
    expect(line.match(/M/g)!.length).toBe(1); // one continuous path
    const pts = line.slice(1).split("L").map((p) => p.split(",").map(Number));
    expect(pts.length).toBe(3); // indices 1..3: both end nulls dropped, the middle one kept
    expect(pts[1]![1]).toBeCloseTo((pts[0]![1]! + pts[2]![1]!) / 2, 1);
  });
});
