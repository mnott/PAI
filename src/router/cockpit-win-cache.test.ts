/**
 * B10 `cache`: the real page with  shows the cache group (a ring card per model, chips cards, the local prefix cache
 * list, the providers table) in main#win-root; a single model gives the one big-donut card; without the flag the old page is
 * unchanged. Headless Chromium, skipped when none is installed. PAI_WIN_SHOTS=<dir> writes cache-<width>.png.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cockpitHtml } from "./cockpit-page.js";
import { CHROME, dumpDom, killChromes, screenshot } from "./cdp-browser.js";

const model = (provider: string, m: string, requests: number, cacheRead: number, cacheWrite: number, input: number) =>
  ({ provider, model: m, requests, cacheRead, cacheWrite, input, output: 1000, errors: 0 });
let solo = false;
let twoLocal = false;
const data = () => ({
  window: "1h", totals: { requests: 5000, input: 9e6, output: 4e5, cacheWrite: 1e6, cacheRead: 9e7, errors: 0, hitRatio: 0.9 },
  byModel: solo
    ? [model("anthropic", "claude-opus", 4000, 9e7, 1e6, 9e6)]
    : [model("anthropic", "claude-opus", 4000, 9e7, 1e6, 9e6), model("glm", "glm-5", 900, 4e6, 1e5, 1e6), model("local", "gyro-m", 80, 0, 0, 5e5), model("tiny", "t-1", 2, 10, 10, 10)],
  series: [], weights: { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 }, cachePause: [], bustParts: { ttl: 2 }, bySession: [], workers: [],
  daily: { models: {}, days: [] }, speed: [], promptByProvider: { local: 600000 }, promptSince: {},
  byProvider: [{ provider: "anthropic", requests: 4000, errors: 0, retries: 0, avgMs: 900, ttftP50: 300, input: 9e6, output: 4e5, cacheRead: 9e7, cacheWrite: 1e6, hitRatio: 0.9 },
    { provider: "local", requests: 80, errors: 0, retries: 0, avgMs: 2000, ttftP50: 800, input: 5e5, output: 1e4, cacheRead: 0, cacheWrite: 0, hitRatio: 0 }],
  sessionSplit: { continuous: { hitRatio: 0.92, sessions: 3, requests: 4000 }, oneShot: { hitRatio: 0.4, sessions: 9, requests: 100 } }, pool: { tasks: 4, tokensCarried: 123456 },
});
const sys = () => ({ servers: [{ provider: "local", up: true, prefixCache: { hits: 70, misses: 10, hitRate: 0.875, tokensSaved: 400000, entries: 5, memoryMb: 300 }, prefixCacheAgeSec: 3 },
  ...(twoLocal ? [{ provider: "idle", up: true, prefixCache: { hits: 0, misses: 0, hitRate: 0, tokensSaved: 0, entries: 0, memoryMb: 19926 }, prefixCacheAgeSec: 3 }] : [])] });

const PROBE = `<script>setTimeout(function(){
function vis(){return Array.prototype.filter.call(document.querySelectorAll("#win-root .card"),function(c){return c.style.display!=="none"}).map(function(c){return c.getAttribute("data-card")})}
function txt(id){var c=document.querySelector('#win-root [data-card="'+id+'"]');return c?c.textContent.replace(/\\s+/g," "):null}
function rc(id){var c=document.querySelector('#win-root [data-card="'+id+'"]');if(!c)return null;var r=c.getBoundingClientRect();return[r.left,r.top,r.right,r.bottom]}
var o={err:window.__err||null,vis:vis(),rects:["cache.ring:anthropic/claude-opus","cache.ring:glm/glm-5","cache.ring:local/gyro-m","cache.ring:tiny/t-1","cache.note","cache.local","cache.providers"].map(rc),rings:document.querySelectorAll('#win-root [data-card^="cache.ring:"] svg').length,
 solo:txt("cache.solo"),soloSvg:(document.querySelector('#win-root [data-card="cache.solo"] svg')||{getAttribute:function(){return null}}).getAttribute("width"),
 glm:txt("cache.ring:glm/glm-5"),local:txt("cache.ring:local/gyro-m"),low:txt("cache.ring:tiny/t-1"),lowCls:(document.querySelector('#win-root [data-card="cache.ring:tiny/t-1"] .ring')||{className:""}).className,lowW:(document.querySelector('#win-root [data-card="cache.ring:tiny/t-1"] svg')||{getBoundingClientRect:function(){return{width:0}}}).getBoundingClientRect().width,note:txt("cache.note"),prefix:txt("cache.local"),prov:txt("cache.providers"),
 none:txt("cache.none"),pcRows:Array.prototype.map.call(document.querySelectorAll('#win-root [data-card="cache.local"] .pcrow'),function(r){return{t:r.textContent.replace(/\\s+/g," "),ratio:r.querySelectorAll(".pcc")[0].querySelectorAll(".bar").length,saved:r.querySelectorAll(".pcc")[1].querySelectorAll(".bar").length}}),};
document.body.setAttribute("data-r",JSON.stringify(o));
},2500)</script>`;

let server: Server;
let base = "";
let tmp = "";
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "cockpit-win-cache-"));
  server = createServer((req, res) => {
    const url = req.url ?? "";
    res.setHeader("content-type", "application/json");
    if (url.startsWith("/cockpit/data")) return res.end(JSON.stringify(data()));
    if (url.startsWith("/cockpit/system")) return res.end(JSON.stringify(sys()));
    if (url.startsWith("/cockpit/")) return res.end("{}");
    if (url.startsWith("/page")) {
      res.setHeader("content-type", "text/html");
      return res.end(cockpitHtml().replace("</head>", '<script>window.onerror=function(m,s,l,c){window.__err=String(m)+" @"+l+":"+c}</script></head>').replace("</body>", PROBE + "</body>"));
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => { killChromes(); server?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

async function open(query: string, width: number, shot?: string) {
  const o = { width, height: 1500, budgetMs: 8000 };
  const url = `${base}/page${query}`;
  const dom = await dumpDom(url, o);
  if (shot) await screenshot(url, shot, o);
  const m = /data-r="([^"]*)"/.exec(dom);
  if (!m) throw new Error("no probe result in dump");
  return JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
}

describe.skipIf(!CHROME)("B10 cache on the win runtime", () => {
  it("a ring card per model (the low-request one small and dimmed), chips, local prefix cache list and providers table", async () => {
    solo = false;
    const shots = process.env.PAI_WIN_SHOTS;
    const o = await open("", 1400, shots ? join(shots, "cache-1400.png") : undefined);
    expect(o.err).toBeNull();
    expect(o.vis).toEqual(expect.arrayContaining(["cache", "cache-rings", "cache.ring:anthropic/claude-opus", "cache.ring:glm/glm-5", "cache.ring:local/gyro-m", "cache.ring:tiny/t-1", "cache.note", "cache.local", "cache.providers"]));
    expect(o.vis).not.toContain("cache.none");
    expect(o.vis).not.toContain("cache.solo");
    expect(o.rings).toBe(4);
    expect(o.glm).toContain("glm-5");
    expect(o.local).toContain("server prefix cache");
    expect(o.vis).not.toContain("cache.low");
    expect(o.low).toContain("t-1");
    expect(o.low).toContain("2 req · few requests");
    expect(o.lowCls).toContain("low");
    expect(o.lowW).toBeLessThan(80);
    expect(o.note).toContain("overall");
    expect(o.note).toContain("one-shot");
    expect(o.note).toContain("pool");
    expect(o.prefix).toContain("70 hit / 10 miss");
    expect(o.prov).toContain("anthropic");
    expect(o.prov).toContain("Busts: ttl x2");
    const rs = o.rects as number[][];
    for (const r of rs) { expect(r).not.toBeNull(); expect(r[2]! - r[0]!).toBeGreaterThan(100); expect(r[3]! - r[1]!).toBeGreaterThan(40); }
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i]!, b = rs[j]!;
      expect(a[0]! < b[2]! - 1 && b[0]! < a[2]! - 1 && a[1]! < b[3]! - 1 && b[1]! < a[3]! - 1, `cards ${i} and ${j} overlap`).toBe(false);
    }
  }, 120_000);

  it("local prefix cache: one visual row per model, ratio bar and saved bar, zero requests shows a dash", async () => {
    solo = false;
    twoLocal = true;
    const o = await open("", 1400, process.env.PAI_WIN_SHOTS ? join(process.env.PAI_WIN_SHOTS, "cache-prefix.png") : undefined);
    twoLocal = false;
    expect(o.err).toBeNull();
    const rows = o.pcRows as { t: string; ratio: number; saved: number }[];
    expect(rows.length).toBe(2);
    expect(rows[0]!.t).toContain("local");
    expect(rows[0]!.t).toContain("87.5%");
    expect(rows[0]!.ratio).toBe(1);
    expect(rows[0]!.saved).toBe(1);
    expect(rows[1]!.t).toContain("idle");
    expect(rows[1]!.t).toContain("–");
    expect(rows[1]!.t).toContain("19.5 GB");
    expect(rows[1]!.ratio).toBe(0);
  }, 120_000);

  it("one model with cache fields gives the single big-donut card", async () => {
    solo = true;
    const o = await open("", 1400);
    expect(o.err).toBeNull();
    expect(o.vis).toContain("cache.solo");
    expect(o.vis).not.toContain("cache.none");
    expect(o.rings).toBe(0);
    expect(o.solo).toContain("overall hit ratio");
    expect(o.soloSvg).toBe("170");
  }, 120_000);

});
