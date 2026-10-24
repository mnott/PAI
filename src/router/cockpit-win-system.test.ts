/**
 * B1 `kpis`: the real page with  shows the totals as a group of six metric cards in main#win-root;
 * without the flag the old page is unchanged. Headless Chromium, skipped when none is installed.
 * PAI_WIN_SHOTS=<dir> writes system-<width>-<theme>.png.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cockpitHtml } from "./cockpit-page.js";
import { CHROME, dumpDom, killChromes, screenshot } from "./cdp-browser.js";

const GB = 1073741824;
const data = () => ({
  window: "1h", totals: { requests: 5000, input: 9e6, output: 4e5, cacheWrite: 1e6, cacheRead: 9e7, errors: 10, hitRatio: 0.9 },
  byModel: [], series: [], weights: { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 }, cachePause: [], byProvider: [],
  bustParts: {}, bySession: [], workers: [], daily: { models: {}, days: [] }, sessionSplit: null, promptByProvider: {}, promptSince: {},
  speed: [{ provider: "gyro-m", h1: { writeTps: 61, requests: 4 }, h24: { writeTps: 60, requests: 90 } }],
});
/** zero: ANE/CPU W/GPU W/ANE W all 0 over the window; two servers, one down. */
const sysPayload = (i: number, servers = 1) => ({
  window: "1h", slowAgeS: 12,
  current: { memUsed: (8 + i) * GB, memTotal: 36 * GB, pressureLevel: 80, swapUsed: i * GB, swapTotal: 4 * GB, wired: 3 * GB, compressed: GB, cpu: 10 + i, gpu: 20 + i, ane: 0, socTemp: 50 + i, cpuW: 0, gpuW: 0, aneW: 0, systemW: 20 + i, totalW: 30 + i, gpuFreqMhz: 1200, source: "test" },
  series: { wh: { "1h": 4 + i }, coveredMin: { "1h": 60 }, series: [1, 2, 3, 4, 5].map((k) => ({ t: 1_700_000_000_000 + k * 60_000, n: 1, cpu: 10 * k + i, gpu: 5 * k, ane: 0, cpuW: 0, gpuW: 0, aneW: 0, totalW: 10 + k + i, systemW: 20, socTemp: 50 })) },
  servers: [{ provider: "gyro-m", up: true, rssMb: 40000 + i * 100, tokensPerSec: 50 + i, prefixCache: { hitRate: 0.5, hits: 5, misses: 5 } }, ...(servers > 1 ? [{ provider: "second", up: true, rssMb: 1000, tokensPerSec: 5, prefixCache: { hitRate: 0.1, hits: 1, misses: 9 } }] : []), { provider: "off", up: false }],
});
/** No server up at all: the note card stands in for the server cards. */
const sysPayloadNone = (i: number) => ({
  window: "1h", slowAgeS: 12,
  current: { memUsed: (8 + i) * GB, memTotal: 36 * GB, pressureLevel: 80, swapUsed: i * GB, swapTotal: 4 * GB, wired: 3 * GB, compressed: GB, cpu: 10 + i, gpu: 20 + i, ane: 0, socTemp: 50 + i, cpuW: 0, gpuW: 0, aneW: 0, systemW: 20 + i, totalW: 30 + i, gpuFreqMhz: 1200, source: "test" },
  series: { wh: { "1h": 4 + i }, coveredMin: { "1h": 60 }, series: [1, 2, 3, 4, 5].map((k) => ({ t: 1_700_000_000_000 + k * 60_000, n: 1, cpu: 10 * k + i, gpu: 5 * k, ane: 0, cpuW: 0, gpuW: 0, aneW: 0, totalW: 10 + k + i, systemW: 20, socTemp: 50 })) },
  servers: [{ provider: "off", up: false }],
});

/** Reads the card boxes and values, pushes a second system payload (values change, no structural change), reads again,
 *  then a third with one more server (structural: only new cards may appear). */
const PROBE = `<script>setTimeout(function(){try{
function boxes(){return Array.prototype.map.call(document.querySelectorAll("#win-root .card"),function(c){var r=c.getBoundingClientRect();return c.getAttribute("data-card")+":"+[r.left,r.top,r.width,r.height].map(Math.round).join(",")}).join("|")}
function vals(){return Array.prototype.map.call(document.querySelectorAll('#win-root [data-card^="system."][data-type="metric"]'),function(c){var v=c.querySelector('[data-k="v"]'),s=c.querySelector('[data-k="s"]');return c.getAttribute("data-card")+"="+(v?v.textContent:"")+(c.classList.contains("min")?" min":"")+" / "+(s?s.textContent:"")}).join("|")}
function overlap(){var cs=Array.prototype.slice.call(document.querySelectorAll("#win-root .card")).filter(function(c){return c.style.display!=="none"}),n=0;
 for(var i=0;i<cs.length;i++)for(var j=i+1;j<cs.length;j++){if(cs[i].contains(cs[j])||cs[j].contains(cs[i]))continue;var a=cs[i].getBoundingClientRect(),b=cs[j].getBoundingClientRect();if(a.left<b.right-.5&&b.left<a.right-.5&&a.top<b.bottom-.5&&b.top<a.bottom-.5){n++;(window.__ov=window.__ov||[]).push(cs[i].getAttribute('data-card')+'|'+cs[j].getAttribute('data-card')+JSON.stringify([a,b].map(function(r){return[r.left,r.top,r.right,r.bottom].map(Math.round)})))}}return n}
var root=document.getElementById("win-root");
var o={cards:document.querySelectorAll("#win-root .card").length,ids:Array.prototype.map.call(document.querySelectorAll("#win-root .card"),function(c){return c.getAttribute("data-card")}),
 heads:Array.prototype.map.call(document.querySelectorAll("#win-root .chead"),function(h){return Array.prototype.map.call(h.children,function(k){return k.className.split(" ")[0]}).join(",")}),
 syshid:!!document.querySelector("#win-root #syshid"),
 vals:vals(),boxes:boxes(),overlap:overlap(),paths:document.querySelectorAll('#win-root [data-card="system.power-chart"] path').length,legend:document.querySelectorAll('#win-root [data-card="system.power-chart"] .legend span').length,
 spark:document.querySelectorAll('#win-root [data-card="system.memory"] svg path').length,err:window.__err||null,ov:window.__ov};
(function(){var c=document.querySelector('#win-root [data-card="system.power-chart"]'),b=c.querySelector(".cbody"),stt=window.Win.state().st,id="system.power-chart";o.leg=[];
 [0,180,300,500].forEach(function(h){if(h){stt[id]=stt[id]||{};stt[id].h=h+28}else if(stt[id])delete stt[id].h;window.Win.relayout();var lg=c.querySelector('[data-k="legend"]'),bt=b.getBoundingClientRect().top;o.leg.push({h:h,bodyH:Math.round(b.clientHeight),legTop:Math.round(lg.getBoundingClientRect().top-bt),legBottom:Math.round(lg.getBoundingClientRect().bottom-bt),legH:Math.round(lg.getBoundingClientRect().height),svgBottom:Math.round(c.querySelector("svg").getBoundingClientRect().bottom-bt)})});
 if(stt[id])delete stt[id].h;window.Win.relayout();o.boxes=boxes()})();
window.WINPAY&&(function(){
 window.Win.toggleMin('system.ane-load');window.Win.toggleMin('system.cpu-w');o.restored=vals();window.Win.toggleMin('system.ane-load');window.Win.toggleMin('system.cpu-w');o.boxesR=boxes();window.Win.update("system",window.WINPAY[1]);o.vals2=vals();o.boxes2=boxes();
 window.winFeedSystem(window.WINPAY[2]);o.ids3=Array.prototype.map.call(document.querySelectorAll("#win-root .card"),function(c){return c.getAttribute("data-card")});o.boxes3=boxes();o.overlap3=overlap()})();
document.body.setAttribute("data-r",JSON.stringify(o));
}catch(e){document.body.setAttribute("data-r",JSON.stringify({err:String(e.stack)}))}},1500)</script>`;

/** No server up: the note card shows and takes space; one up: its four cards show and the note takes none;
 *  up then down: the decode card reads "–" / "down". */
const PROBE_NONE = `<script>setTimeout(function(){try{
function boxes(){return Array.prototype.map.call(document.querySelectorAll("#win-root .card"),function(c){var r=c.getBoundingClientRect();return c.getAttribute("data-card")+":"+[r.left,r.top,r.width,r.height].map(Math.round).join(",")}).join("|")}
function srv(){return Array.prototype.map.call(document.querySelectorAll('#win-root [data-card^="system.srv:"]'),function(c){var v=c.querySelector('[data-k="v"]'),n=c.querySelector('[data-k="n"]'),s=c.querySelector('[data-k="s"]');return c.getAttribute("data-card")+"="+(v?v.textContent:"")+"/"+(n?n.textContent:s?s.textContent:"")}).join("|")}
var o={ids:Array.prototype.map.call(document.querySelectorAll("#win-root .card"),function(c){return c.getAttribute("data-card")}),
 boxes:boxes(),none:srv(),err:window.__err||null};
function done(){document.body.setAttribute("data-r",JSON.stringify(o))}
setTimeout(function(){o.srv2=srv();o.boxes2=boxes();o.kids=JSON.stringify(window.Win.state().kids["sys-servers"]);
 setTimeout(function(){o.srv3=srv();o.boxes3=boxes();done()},5000)},5000);
}catch(e){document.body.setAttribute("data-r",JSON.stringify({err:String(e.stack)}))}},1500)</script>`;

let server: Server;
/** The /none page polls the system feed every 5 s: its first read is no server up, then one up, then that one down. */
let sysCalls = 0;
let base = "";
let tmp = "";
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "cockpit-win-system-"));
  server = createServer((req, res) => {
    const url = req.url ?? "";
    res.setHeader("content-type", "application/json");
    if (url.startsWith("/cockpit/data")) return res.end(JSON.stringify(data()));
    if (url.startsWith("/cockpit/system")) return res.end(JSON.stringify(url.includes("window=24h") ? [sysPayloadNone(0), sysPayload(1), { ...sysPayloadNone(2), servers: [{ provider: "gyro-m", up: false }] }][Math.min(sysCalls++, 2)] : sysPayload(0)));
    if (url.startsWith("/cockpit/")) return res.end("{}");
    if (url.startsWith("/none")) {
      res.setHeader("content-type", "text/html");
      return res.end(cockpitHtml().replace("</head>", '<script>window.onerror=function(m,s,l,c){window.__err=String(m)+" @"+l+":"+c};try{localStorage.setItem("cockpitWin","24h")}catch(e){}</script></head>').replace("</body>", "<script>window.WINPAY=" + "null" + "</script>" + PROBE_NONE + "</body>"));
    }
    if (url.startsWith("/page")) {
      res.setHeader("content-type", "text/html");
      return res.end(cockpitHtml().replace("</head>", '<script>window.onerror=function(m,s,l,c){window.__err=String(m)+" @"+l+":"+c}</script></head>').replace("</body>", "<script>window.WINPAY=" + JSON.stringify([0, sysPayload(3), sysPayload(5, 2)]) + "</script>" + PROBE + "</body>"));
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => { killChromes(); server?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

async function open(query: string, width: number, shot?: string, budget = 6000) {
  const o = { width, height: 900, budgetMs: budget };
  const url = `${base}${query}`;
  const dom = await dumpDom(url, o);
  if (shot) await screenshot(url, shot, o);
  const m = /data-r="([^"]*)"/.exec(dom);
  if (!m) throw new Error("no probe result in dump: " + dom.slice(-600));
  return JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
}

describe.skipIf(!CHROME)("B2 system on the win runtime", () => {
  it("shows 20 metric cards (6 of them extra), the chart and the up server's cards; zero metrics are minimized; updates move no box; a new server adds only its cards", async () => {
    const shots = process.env.PAI_WIN_SHOTS;
    const r = await open("/page", 1400, shots ? join(shots, "system-1400-light.png") : undefined);
    expect(r.err).toBeNull();
    for (const id of ["system", "sys-metrics", "sys-power", "sys-servers", "system.power-chart", "system.memory", "system.energy", "system.ane-load", "system.cpu-w", "system.gpu-w", "system.ane-w"]) expect(r.ids).toContain(id);
    expect(r.ids.filter((i: string) => /^system\.srv:gyro-m\//.test(i))).toEqual(["system.srv:gyro-m/rss", "system.srv:gyro-m/e2e", "system.srv:gyro-m/decode", "system.srv:gyro-m/prefix"]);
    expect(r.syshid).toBe(false);
    for (const h of r.heads) expect(h).toMatch(/^cgrip,ctitle,cstatus(,cbtn|,wctl|,wsearch)*$/);
    expect(r.vals).toContain("system.memory=8.0 / of 36 GB · pressure 20%");
    expect(r.vals).toContain("system.cpu-load=10 / all clusters");
    // the four zero metrics start minimized (unmounted until restored); restoring shows 0 and the reason
    for (const n of ["ane-load", "cpu-w", "gpu-w", "ane-w"]) expect(r.vals).toContain(`system.${n}= min / `);
    expect(r.restored).toContain("system.ane-load=0 / 0 in this window");
    expect(r.restored).toContain("system.cpu-w=0 / 0 in this window");
    expect(r.boxesR).toBe(r.boxes);
    expect(r.vals).toContain("system.energy=4 / 60 min of 1-min samples");
    expect(r.vals).toContain("system.srv:gyro-m/rss=39.1 / resident memory");
    expect(r.vals).toContain("system.srv:gyro-m/decode=61 / decode");
    expect(r.vals).toContain("system.srv:gyro-m/prefix=50.0 / 5/10");
    // the legend is whole inside the card body at body heights 160 (default) / 180 / 300 / 500
    expect(r.leg.length).toBe(4);
    for (const l of r.leg) expect(l.legBottom, `legend bottom at body ${l.bodyH}`).toBeLessThanOrEqual(l.bodyH);
    // paths only for series with data: the fixture has none for power in / charger limit / battery discharge
    expect(r.paths).toBe(3);
    expect(r.legend).toBe(6); // 3 original lines + power in, charger limit, battery discharge
    expect(r.spark).toBeGreaterThan(0);
    expect(r.ov ?? []).toEqual([]);expect(r.overlap).toBe(0);
    // a value-only payload changes values, not one box
    expect(r.vals2).not.toBe(r.vals);
    expect(r.vals2).toContain("system.memory=11.0");
    expect(r.boxes2).toBe(r.boxes);
    // a second up server: only its four cards are new; the other cards keep their ids
    const added = r.ids3.filter((i: string) => !r.ids.includes(i));
    expect(added).toEqual(["system.srv:second/rss", "system.srv:second/e2e", "system.srv:second/decode", "system.srv:second/prefix"]);
    expect(r.overlap3).toBe(0);
  }, 120_000);

  it("no server up shows the note card; one up hides it; a down server's cards say down", async () => {
    const r = await open("/none?window=24h", 1400, undefined, 16000);
    expect(r.err).toBeNull();
    // no server up: the note card is present and takes space
    expect(r.ids).toContain("system.srv:none");
    expect(r.none).not.toContain("system.srv:gyro-m/");
    expect(r.boxes).toContain("system.srv:none:");
    expect(r.none).toContain("system.srv:none=/no local model server is up");
    // one server up: its four cards mount beside the kept note leaf; the note takes no space
    expect(r.srv2).toContain("system.srv:gyro-m/rss=39.2/resident memory");
    expect(r.srv2).toContain("system.srv:gyro-m/decode=61/decode");
    // addCards on a group holding one leaf: the leaf stays on top, the server's row goes below it
    const kids = JSON.parse(r.kids);
    expect(kids.d).toBe("c");
    expect(kids.ch[0]).toEqual({ k: "c", id: "system.srv:none" });
    expect(kids.ch.slice(1).map((c: { id: string }) => c.id)).toEqual(["rss", "e2e", "decode", "prefix"].map((w) => `system.srv:gyro-m/${w}`));
    // a server that was up and goes down: its cards stay and read "–" / "down"
    expect(r.srv3).toContain("system.srv:gyro-m/rss=–/down");
    expect(r.srv3).toContain("system.srv:gyro-m/decode=–/down");
    expect(r.boxes3).toContain("system.srv:none:");
  }, 120_000);
});
