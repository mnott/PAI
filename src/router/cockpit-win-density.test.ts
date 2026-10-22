/**
 * Density: a card's default height is its content's height (within the type's minimum), so the page has no large empty card areas.
 * Pure: layout() with cfg.fit shrinks default bands, saved px and no-fit layouts are unchanged.
 * Headless Chromium on the real page (, no saved layout): every measured card is at most SLACK px taller than its content.
 * PAI_DENSITY_SHOT=<png> writes a 1300x5000 screenshot; PAI_DENSITY_TABLE=1 prints the table.
 */

import { execFile, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cockpitHtml } from "./cockpit-page.js";
import { WIN_LAYOUT_JS } from "./cockpit-page/win/layout.js";
import { WIN_TREE_JS } from "./cockpit-page/win/tree.js";

const CHROME = process.env.CHROME_BIN ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));
const SLACK = 24;

type Lay = (t: unknown, k: unknown, box: { w: number; h?: number }, st: unknown, cfg: unknown) => { rects: Record<string, { y: number; h: number }>; height: number };
const api = new Function(`${WIN_TREE_JS}\n${WIN_LAYOUT_JS}\nreturn {leaf:leaf,split:split,layout:layout};`)() as { leaf: (id: string) => unknown; split: (d: string, ch: unknown[], sz: number[]) => unknown; layout: Lay };
const cfgBase = { HEAD_H: 28, GAP: 8, GUTTER: 8, minW: 100, types: { note: { minH: 48, defaultH: 60 } } };
const tree = () => api.split("c", [api.leaf("a"), api.leaf("b")], [300, 200]);

describe("layout with cfg.fit (pure)", () => {
  it("a default band is as tall as its measured content (above its px too), never below the type minimum", () => {
    const cfg = { ...cfgBase, leafTypes: { a: "note", b: "note" }, fit: { a: 70, b: 20 } };
    const r = api.layout(tree(), {}, { w: 600 }, {}, cfg);
    expect(r.rects.a!.h).toBe(70);
    expect(r.rects.b!.h).toBe(48);
    const big = api.layout(tree(), {}, { w: 600 }, {}, { ...cfg, fit: { a: 900, b: 20 } });
    expect(big.rects.a!.h).toBe(900);
  });
  it("without cfg.fit, without a reading, or with a saved px the sizes are the saved ones", () => {
    const base = api.layout(tree(), {}, { w: 600 }, {}, cfgBase);
    expect([base.rects.a!.h, base.rects.b!.h]).toEqual([300, 200]);
    const none = api.layout(tree(), {}, { w: 600 }, {}, { ...cfgBase, fit: {} });
    expect([none.rects.a!.h, none.rects.b!.h]).toEqual([300, 200]);
    const px = api.layout(tree(), {}, { w: 600 }, { a: { px: 250 } }, { ...cfgBase, fit: { a: 70, b: 70 } });
    expect([px.rects.a!.h, px.rects.b!.h]).toEqual([250, 70]);
  });
  it("a group of stacked cards is as tall as its head plus its kids", () => {
    const kids = { g: api.split("c", [api.leaf("a"), api.leaf("b")], [1, 1]) };
    const t = api.split("c", [api.leaf("g")], [500]);
    const r = api.layout(t, kids, { w: 600 }, {}, { ...cfgBase, fit: { a: 60, b: 90 } });
    expect(r.rects.g!.h).toBe(28 + 60 + 8 + 90);
    expect([r.rects.a!.h, r.rects.b!.h]).toEqual([60, 90]);
  });
});

const data = () => ({
  window: "1h", totals: { requests: 5000, input: 9e6, output: 4e5, cacheWrite: 1e6, cacheRead: 9e7, errors: 0, hitRatio: 0.9 },
  byModel: [], series: [], weights: { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 }, cachePause: [], byProvider: [],
  bustParts: {}, bySession: [], workers: [], daily: { models: {}, days: [] }, sessionSplit: null, speed: [], promptByProvider: {}, promptSince: {},
});
const pool = () => ({
  enabled: true, hostUp: true, port: 4711, maxSlots: 3, idleKillSecs: 600, hostSince: "2026-10-21 08:00", hostBuiltAt: null, hostStale: false,
  hostLastSeen: "2026-10-20 12:00", slots: [], spares: [], spareClaims: 0, spareMisses: [], totals: { tasksServed: 0, tokensCarried: 0, hitRatio: 0, carriedTasks: 0 },
  last24h: { runs: 0, pooled: 0, notPooled: 0, reasons: [], topReason: null, unattributed: 0, poolOff: 0 }, offReason: null, message: "m",
});
const limits = () => ({ activeLocal: null, limits: [{ provider: "glm", kind: "cloud", windows: [{ name: "5h", percent: 30, resetAt: Date.now() + 3600_000 }] }] });

/** Per card: rendered height and content height (HEAD_H + the lowest leaf element in the body), for cards the runtime fits. */
const PROBE = `<script>setTimeout(function(){
var out={};Array.prototype.forEach.call(document.querySelectorAll("#win-root .card"),function(c){
 if(c.style.display==="none"||c.classList.contains("min"))return;
 var ty=c.getAttribute("data-type"),def=(Win.cfg().types||{})[ty]||{};
 if((def.resize&&c.getAttribute("data-card")!=="pool.slots")||c.querySelector(".card"))return; // the slots table with only its note is fitted by content
 var b=c.querySelector(".cbody").getBoundingClientRect(),max=0;
 Array.prototype.forEach.call(c.querySelectorAll(".cbody *"),function(e){if(e.children.length||!e.getClientRects().length)return;var r=e.getBoundingClientRect();if(r.height>0&&r.bottom-b.top>max)max=r.bottom-b.top});
 out[c.getAttribute("data-card")]={y:Math.round(c.getBoundingClientRect().top),type:ty,h:Math.round(c.getBoundingClientRect().height),content:Math.round(28+max)};
});
var bands={};Array.prototype.forEach.call(document.querySelectorAll("#win-root .card"),function(c){
 if(c.parentNode.closest&&c.parentNode.closest(".card")||c.style.display==="none")return;
 var r=c.getBoundingClientRect(),low=r.top+28,kc=c.querySelectorAll(".card"),vis=0,i;
 for(i=0;i<kc.length;i++)if(kc[i].style.display!=="none")vis++;
 if(kc.length&&!vis)return; // a band holding only its hidden placeholder
 if(!kc.length&&((Win.cfg().types||{})[c.getAttribute("data-type")]||{}).resize)return; // a card that draws at the body size has no content height
 Array.prototype.forEach.call(c.querySelectorAll(".card"),function(k){if(k.style.display==="none")return;var b=k.getBoundingClientRect();if(b.height>0&&b.bottom>low)low=b.bottom});
 if(!c.querySelector(".card")){var bd=c.querySelector(".cbody");if(bd)Array.prototype.forEach.call(bd.querySelectorAll("*"),function(e){if(e.children.length||!e.getClientRects().length)return;var b=e.getBoundingClientRect();if(b.height>0&&b.bottom>low)low=b.bottom})}
 bands[c.getAttribute("data-card")]={h:Math.round(r.height),empty:Math.round(r.bottom-low)};
});
document.body.setAttribute("data-r",JSON.stringify({err:window.__err||null,cards:out,bands:bands}));
},2500)</script>`;

let server: Server;
let base = "";
let tmp = "";
const browsers = new Set<ChildProcess>();
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "cockpit-win-density-"));
  server = createServer((req, res) => {
    const url = req.url ?? "";
    res.setHeader("content-type", "application/json");
    if (url.startsWith("/cockpit/data")) return res.end(JSON.stringify(data()));
    if (url.startsWith("/cockpit/pool")) return res.end(JSON.stringify(pool()));
    if (url.startsWith("/cockpit/limits")) return res.end(JSON.stringify(limits()));
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
afterAll(() => { for (const c of browsers) c.kill("SIGKILL"); server?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = execFile(CHROME!, args, { encoding: "utf8", timeout: 60_000, maxBuffer: 64 << 20 }, (err, stdout) => { browsers.delete(c); err ? reject(err) : resolve(stdout); });
    browsers.add(c);
  });
}

type Probe = { err: string | null; bands: Record<string, { h: number; empty: number }>; cards: Record<string, { y: number; type: string; h: number; content: number }> };
async function probe(size: string, shot?: string): Promise<Probe> {
  const args = ["--headless=new", "--disable-gpu", "--use-mock-keychain", "--password-store=basic", "--no-first-run", "--hide-scrollbars", `--user-data-dir=${join(tmp, "p" + size)}`, `--window-size=${size}`, "--virtual-time-budget=8000"];
  const url = `${base}/page`;
  const dom = await run([...args, "--dump-dom", url]);
  if (shot) await run([...args, `--screenshot=${shot}`, url]);
  const m = /data-r="([^"]*)"/.exec(dom);
  if (!m) throw new Error("no probe result in dump");
  return JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")) as Probe;
}

describe.skipIf(!CHROME)("every default card is as tall as its content", () => {
  it(`no card is more than ${SLACK} px taller than its content`, async () => {
    const r = await probe("1300,5000", process.env.PAI_DENSITY_SHOT);
    expect(r.err).toBeNull();
    const ids = Object.keys(r.cards).filter((i) => i !== "cache.none"); // the empty-data placeholder rides the ring type (min 130)
    expect(ids.length).toBeGreaterThan(15);
    if (process.env.PAI_DENSITY_TABLE) console.log(ids.map((i) => `${i}\t${r.cards[i]!.type}\t${r.cards[i]!.h}\t${r.cards[i]!.content}\t${r.cards[i]!.h - r.cards[i]!.content}`).join("\n"));
    // cards side by side share the band: the slack is against the tallest content of the row
    const rowContent = (i: string) => Math.max(...ids.filter((j) => Math.abs(r.cards[j]!.y - r.cards[i]!.y) < 2).map((j) => r.cards[j]!.content));
    const off = ids.filter((i) => r.cards[i]!.h - rowContent(i) > SLACK).map((i) => `${i}(${r.cards[i]!.h} vs ${rowContent(i)})`);
    expect(off).toEqual([]);
  }, 120_000);

  for (const w of [1500, 1300]) {
    it(`${w} px: the slots table showing only "no slots" is at most ${SLACK} px taller than its content`, async () => {
      const r = await probe(`${w},700`);
      expect(r.err).toBeNull();
      const c = r.cards["pool.slots"]!;
      expect(c, "pool.slots is measured").toBeDefined();
      expect(c.h, `pool.slots ${c.h} vs content ${c.content}`).toBeLessThanOrEqual(c.content + SLACK);
    }, 120_000);
  }

  for (const w of [1500, 1300]) {
    it(`${w} px: every root band in auto layout has at most ${SLACK} px empty below its last card`, async () => {
      const r = await probe(`${w},700`);
      expect(r.err).toBeNull();
      const ids = Object.keys(r.bands);
      if (process.env.PAI_DENSITY_TABLE) console.log(ids.map((i) => `${i}\t${r.bands[i]!.h}\t${r.bands[i]!.empty}`).join("\n"));
      expect(ids.length).toBeGreaterThan(5);
      expect(ids.filter((i) => r.bands[i]!.empty > SLACK).map((i) => `${i}(${r.bands[i]!.empty})`)).toEqual([]);
    }, 120_000);
  }
});
