/**
 * B4 `pool`: the real page with  shows the totals as a group of six metric cards in main#win-root;
 * without the flag the old page is unchanged. Headless Chromium, skipped when none is installed.
 * PAI_WIN_SHOTS=<dir> writes pool-<width>-<theme>.png.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cockpitHtml } from "./cockpit-page.js";
import { CHROME, dumpDom, killChromes, screenshot } from "./cdp-browser.js";

const data = () => ({
  window: "1h", totals: { requests: 5000, input: 9e6, output: 4e5, cacheWrite: 1e6, cacheRead: 9e7, errors: 0, hitRatio: 0.9 },
  byModel: [], series: [], weights: { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 }, cachePause: [], byProvider: [],
  bustParts: {}, bySession: [], workers: [], daily: { models: {}, days: [] }, sessionSplit: null, speed: [], promptByProvider: {}, promptSince: {},
});
let poolOn = true;
/** "live": the shape captured from a running router (pool on, no slots, no spares, reasons only in last24h); "partial": last24h without `reasons`, which the old panel render cannot take. */
let shape: "fixture" | "live" | "partial" = "fixture";
const livePool = () => ({
  enabled: true, hostUp: true, port: 4711, maxSlots: 3, idleKillSecs: 1800, hostSince: "2026-10-21 23:47:16", hostLastSeen: "2026-10-21 23:47:16", hostBuiltAt: "2026-10-21 23:46:20", hostStale: false,
  slots: [], spares: [], spareClaims: 0, spareMisses: [], totals: { tasksServed: 0, tokensCarried: 394467, hitRatio: 0.36, carriedTasks: 182 },
  last24h: { runs: 367, pooled: 59, notPooled: 308, reasons: [{ reason: "opted-out", runs: 214 }, { reason: "spares-off", runs: 98 }], topReason: "opted-out", unattributed: 0, poolOff: 92 }, offReason: null, message: "m",
});
const pool = () => shape === "fixture" ? fixturePool() : shape === "live" ? livePool() : (() => { const p = livePool(); delete (p.last24h as { reasons?: unknown }).reasons; return p; })();
const fixturePool = () => ({
  enabled: poolOn, hostUp: poolOn, port: 4711, maxSlots: 3, idleKillSecs: 600, hostSince: "2026-10-21 08:00", hostBuiltAt: null, hostStale: false,
  hostLastSeen: "2026-10-20 12:00", slots: poolOn ? [{ provider: "claude", model: "opus", cwd: "/a/b/c", state: "busy", ageSecs: 100, idleSecs: 5, tasks: 2, tokensCarried: 5000, hitRatio: 0.8, task: "t1", branch: null, firstRequest: "warm" }] : [],
  spares: [{ provider: "claude", ready: 1, starting: 0 }], spareClaims: 2, spareMisses: [], totals: { tasksServed: 7, tokensCarried: 12000, hitRatio: 0.5, carriedTasks: 3 },
  last24h: { runs: 10, pooled: 6, notPooled: 4, reasons: [], topReason: null, unattributed: 4, poolOff: 0 }, offReason: poolOn ? null : "config disabled", message: "m",
});

/** Reads which cards are shown and their texts. */
const PROBE = `<script>setTimeout(function(){
function vis(){return Array.prototype.filter.call(document.querySelectorAll("#win-root .card"),function(c){return c.style.display!=="none"}).map(function(c){return c.getAttribute("data-card")})}
function txt(id){var c=document.querySelector('#win-root [data-card="'+id+'"]');return c?c.textContent.replace(/\\s+/g," "):null}
var o={err:window.__err||null,vis:vis(),host:txt("pool.host"),tasks:txt("pool.tasks"),slots:txt("pool.slots"),off:txt("pool.off"),
 heads:Array.prototype.map.call(document.querySelectorAll("#win-root .chead"),function(h){return Array.prototype.map.call(h.children,function(k){return k.className.split(" ")[0]}).join(",")})};
document.body.setAttribute("data-r",JSON.stringify(o));
},1500)</script>`;

let server: Server;
let base = "";
let tmp = "";
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "cockpit-win-pool-"));
  server = createServer((req, res) => {
    const url = req.url ?? "";
    res.setHeader("content-type", "application/json");
    if (url.startsWith("/cockpit/data")) return res.end(JSON.stringify(data()));
    if (url.startsWith("/cockpit/pool")) return res.end(JSON.stringify(pool()));
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
  const o = { width, height: 900, budgetMs: 6000 };
  const url = `${base}/page${query}`;
  const dom = await dumpDom(url, o);
  if (shot) await screenshot(url, shot, o);
  const m = /data-r="([^"]*)"/.exec(dom);
  if (!m) throw new Error("no probe result in dump");
  return JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
}

describe.skipIf(!CHROME)("B4 pool on the win runtime", () => {
  it("on: six kv cards over the slots table, no note; the old section is hidden", async () => {
    poolOn = true;
    const shots = process.env.PAI_WIN_SHOTS;
    const r = await open("", 1400, shots ? join(shots, "pool-1400-light.png") : undefined);
    expect(r.err).toBeNull();
    expect(r.vis).toEqual(expect.arrayContaining(["pool", "pool.pool", "pool.host", "pool.tasks", "pool.hit", "pool.spares", "pool.not-pooled", "pool.slots"]));
    expect(r.vis).not.toContain("pool.off");
    expect(r.host).toContain("up");
    expect(r.tasks).toContain("7");
    expect(r.slots).toContain("opus");
    for (const h of r.heads) expect(h).toMatch(/^cgrip,ctitle,cstatus(,cbtn|,wctl)*$/);
  }, 120_000);

  it("off with the host down: one note card, no kv cards", async () => {
    poolOn = false;
    const r = await open("", 1400);
    expect(r.err).toBeNull();
    expect(r.vis).toContain("pool.off");
    expect(r.vis).not.toContain("pool.host");
    expect(r.vis).not.toContain("pool.slots");
    expect(r.off).toContain("Pool off");
    expect(r.off).toContain("config disabled");
  }, 120_000);

  it.each(["live", "partial"] as const)("%s payload: kv values and the slots card are filled, no note", async (sh) => {
    poolOn = true;
    shape = sh;
    const r = await open("", 1400);
    shape = "fixture";
    expect(r.vis).toEqual(expect.arrayContaining(["pool.host", "pool.tasks", "pool.slots"]));
    expect(r.vis).not.toContain("pool.off");
    expect(r.host).toContain("up");
    expect(r.tasks).toContain("0");
    expect(r.slots).toContain("no slots");
  }, 120_000);

});
