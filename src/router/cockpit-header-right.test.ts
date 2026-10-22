/** The header's right group (live stamp, reset, theme) stays at the right edge, with the newer-build link hidden or shown.
 *  Headless Chromium, skipped when none is installed. */

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleCockpit, setCockpitBuildId } from "./cockpit.js";
import { CHROME, dumpDom, killChromes } from "./cdp-browser.js";

const PROBE = `<script>setTimeout(function(){var s=document.getElementById("stamp").getBoundingClientRect(),h=document.querySelector("header").getBoundingClientRect(),n=document.getElementById("newer");
document.body.setAttribute("data-r",JSON.stringify({gap:Math.round(h.right-s.right),newerShown:n.offsetParent!==null,newerBeforeStamp:n.getBoundingClientRect().right<=s.left}))},2000)</script>`;

let server: Server;
let base = "";
let pollBuild = "A";
beforeAll(async () => {
  setCockpitBuildId("A");
  server = createServer((req, res) => {
    if ((req.url ?? "").startsWith("/cockpit/data")) {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ window: "1h", build: pollBuild, totals: { requests: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, errors: 0, hitRatio: 0 }, byModel: [], series: [], byProvider: [], bySession: [], cachePause: [], speed: [], promptByProvider: {} }));
    }
    if ((req.url ?? "").startsWith("/cockpit/")) return res.setHeader("content-type", "application/json"), res.end("{}");
    const sent = { body: "" };
    const fake = { setHeader: () => undefined, writeHead: () => undefined, end: (b: string) => void (sent.body = b) } as never;
    handleCockpit({ url: "/cockpit", method: "GET" } as never, fake, { get: async () => [] } as never, () => [], () => new Map(), undefined, () => []);
    res.setHeader("content-type", "text/html");
    res.end(sent.body.replace("</body>", PROBE + "</body>"));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => { killChromes(); server?.close(); setCockpitBuildId(null); });

async function probe() {
  const dom = await dumpDom(`${base}/page`, { width: 1500, height: 800, budgetMs: 6000 });
  const m = /data-r="([^"]*)"/.exec(dom);
  if (!m) throw new Error("no probe result in dump");
  return JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
}

describe.skipIf(!CHROME)("header right group at 1500 px", () => {
  it("newer link hidden: the live stamp sits at the header's right edge", async () => {
    pollBuild = "A";
    const r = await probe();
    expect(r.newerShown).toBe(false);
    expect(r.gap).toBeLessThan(120);
  }, 30000);
  it("newer link shown: it sits left of the stamp and the stamp stays at the right edge", async () => {
    pollBuild = "B";
    const r = await probe();
    expect(r.newerShown).toBe(true);
    expect(r.newerBeforeStamp).toBe(true);
    expect(r.gap).toBeLessThan(120);
  }, 30000);
});

const WRAP = `<script>setTimeout(function(){var h=document.querySelector("header"),t=[];[].forEach.call(h.children,function(c){if(c.offsetParent!==null)t.push(Math.round((c.getBoundingClientRect().top+c.getBoundingClientRect().bottom)/2))});
var posts=0,of=window.fetch;window.fetch=function(u,o){if(o&&o.method==="POST"&&/layout-default/.test(u))posts++;return Promise.resolve({ok:true,json:function(){return {}}})};
var r={spread:Math.max.apply(null,t)-Math.min.apply(null,t)};
document.getElementById("savedef").click();r.askShown=!document.getElementById("ask").hidden;r.starHidden=document.getElementById("savedef").hidden;
document.getElementById("askno").click();r.noPost=posts===0&&document.getElementById("ask").hidden;
document.getElementById("savedef").click();document.getElementById("askyes").click();
setTimeout(function(){r.posts=posts;r.toast=!document.getElementById("toast").hidden;
document.getElementById("savedef").click();setTimeout(function(){r.auto=document.getElementById("ask").hidden&&posts===1;
document.body.setAttribute("data-r",JSON.stringify(r))},4300)},300)},2000)</script>`;

describe.skipIf(!CHROME)("header stays on one line and the star confirms", () => {
  for (const width of [360, 550, 1100]) {
    it(`${width} px: one line; star asks first, ✕/4 s cancel, ✓ POSTs once`, async () => {
      pollBuild = "A";
      const orig = server.listeners("request")[0] as (...a: unknown[]) => void;
      server.removeAllListeners("request");
      server.on("request", (req, res) => {
        const w = res.end.bind(res);
        res.end = ((b: string) => w(typeof b === "string" ? b.replace("</body>", WRAP + "</body>") : b)) as never;
        orig(req, res);
      });
      const dom = await dumpDom(`${base}/page`, { width, height: 800, budgetMs: 9000 });
      server.removeAllListeners("request");
      server.on("request", orig);
      const m = /data-r="([^"]*)"/.exec(dom);
      if (!m) throw new Error("no probe result in dump");
      const r = JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
      expect(r.spread).toBeLessThanOrEqual(4);
      expect(r.askShown && r.starHidden && r.noPost).toBe(true);
      expect(r.posts).toBe(1);
      expect(r.toast).toBe(true);
      expect(r.auto).toBe(true);
    }, 40000);
  }
});

const LOCKPROBE = `<script>setTimeout(function(){var h=document.querySelector("header"),k=[].slice.call(h.querySelectorAll("button")),l=document.getElementById("lock"),r={};
r.starBeforeLock=k.indexOf(document.getElementById("savedef"))<k.indexOf(l);r.starLeft=document.getElementById("savedef").getBoundingClientRect().right<=l.getBoundingClientRect().left+1;
r.a0=l.getAttribute("aria-label");r.p0=l.getAttribute("aria-pressed");r.g0=l.innerHTML;r.c0=getComputedStyle(l).color;r.d0=l.querySelector("path").getAttribute("d");l.click();l.blur();l.style.pointerEvents="none";
r.a1=l.getAttribute("aria-label");r.p1=l.getAttribute("aria-pressed");r.g1=l.innerHTML;r.c1=getComputedStyle(l).color;r.d1=l.querySelector("path").getAttribute("d");
document.body.setAttribute("data-r",JSON.stringify(r))},2000)</script>`;

describe.skipIf(!CHROME)("star sits left of the lock; the lock shows its state", () => {
  it("DOM order, distinct glyphs and labels per state", async () => {
    pollBuild = "A";
    const orig = server.listeners("request")[0] as (...a: unknown[]) => void;
    server.removeAllListeners("request");
    server.on("request", (req, res) => {
      const w = res.end.bind(res);
      res.end = ((b: string) => w(typeof b === "string" ? b.replace("</body>", LOCKPROBE + "</body>") : b)) as never;
      orig(req, res);
    });
    const dom = await dumpDom(`${base}/page`, { width: 1100, height: 800, budgetMs: 6000 });
    server.removeAllListeners("request");
    server.on("request", orig);
    const m = /data-r="([^"]*)"/.exec(dom);
    if (!m) throw new Error("no probe result in dump");
    const r = JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
    expect(r.starBeforeLock && r.starLeft).toBe(true);
    expect([r.a0, r.p0, r.a1, r.p1]).toEqual(["layout unlocked", "false", "layout locked", "true"]);
    expect(r.g0).toMatch(/(<|&lt;)svg/);
    expect(r.g1).toMatch(/(<|&lt;)svg/);
    expect(r.g0).not.toBe(r.g1);
    expect(r.d0).not.toBe(r.d1);
    expect(r.c0).not.toBe(r.c1);
  }, 30000);
});

const VERPROBE = `<script>setTimeout(function(){var h=document.querySelector("header"),t=[],v=document.getElementById("ver");[].forEach.call(h.children,function(c){if(c.offsetParent!==null)t.push(Math.round((c.getBoundingClientRect().top+c.getBoundingClientRect().bottom)/2))});
document.body.setAttribute("data-r",JSON.stringify({spread:Math.max.apply(null,t)-Math.min.apply(null,t),ver:v.offsetParent!==null,txt:v.textContent,w:Math.round(v.getBoundingClientRect().width),sw:v.scrollWidth}))},2000)</script>`;

// no width breakpoints: the version is a flex item whose patch part (.vp) yields first, then the whole version
it("the version has no width breakpoints; its patch part collapses first", async () => {
  const sent = { body: "" };
  handleCockpit({ url: "/cockpit", method: "GET" } as never, { setHeader: () => undefined, writeHead: () => undefined, end: (b: string) => void (sent.body = b) } as never, { get: async () => [] } as never, () => [], () => new Map(), undefined, () => []);
  expect(sent.body).toMatch(/#ver\{display:flex;flex:0 100 auto;min-width:0;overflow:hidden;/);
  expect(sent.body).toContain("#ver .vp{flex:0 1000 auto;min-width:0;overflow:hidden}");
  expect(sent.body).not.toMatch(/@media[^{]*\{[^}]*#ver/);
});

describe.skipIf(!CHROME)("header version", () => {
  for (const [width, ver, txt] of [[540, true, /^v\d+\.\d+\.\d+/], [1100, true, /^v\d+\.\d+\.\d+/]] as const) {
    it(`${width} px: one line, version ${ver ? "shown" : "hidden"}`, async () => {
      pollBuild = "A";
      const orig = server.listeners("request")[0] as (...a: unknown[]) => void;
      server.removeAllListeners("request");
      server.on("request", (req, res) => {
        const w = res.end.bind(res);
        res.end = ((b: string) => w(typeof b === "string" ? b.replace("</body>", VERPROBE + "</body>") : b)) as never;
        orig(req, res);
      });
      const dom = await dumpDom(`${base}/page`, { width, height: 800, budgetMs: 6000 });
      server.removeAllListeners("request");
      server.on("request", orig);
      const m = /data-r="([^"]*)"/.exec(dom);
      if (!m) throw new Error("no probe result in dump");
      const r = JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
      expect(r.spread).toBeLessThanOrEqual(6);
      expect(r.ver).toBe(ver);
      if (ver) expect(r.txt).toMatch(txt as RegExp);
      if (ver) expect(r.sw).toBeLessThanOrEqual(r.w);
    }, 40000);
  }
});

const CENTERPROBE = `<script>setTimeout(function(){var h=document.querySelector("header"),hr=h.getBoundingClientRect(),t=document.getElementById("tabs").getBoundingClientRect(),v=document.getElementById("ver").getBoundingClientRect(),h1=document.querySelector("h1").getBoundingClientRect(),
l=document.querySelector(".hl").getBoundingClientRect(),r=document.querySelector(".hr").getBoundingClientRect();
document.body.setAttribute("data-r",JSON.stringify({off:Math.round(Math.abs((t.left+t.right)/2-(hr.left+hr.right)/2)),fits:l.width>=0&&r.width>=0,vgap:Math.round(v.left-h1.right),tabsGap:Math.round(t.left-l.right)}))},2000)</script>`;

describe.skipIf(!CHROME)("range buttons are centred in the header", () => {
  for (const width of [540, 1100]) {
    it(`${width} px: range group centre within 12 px of the header centre; version clear of the title`, async () => {
      pollBuild = "A";
      const orig = server.listeners("request")[0] as (...a: unknown[]) => void;
      server.removeAllListeners("request");
      server.on("request", (req, res) => {
        const w = res.end.bind(res);
        res.end = ((b: string) => w(typeof b === "string" ? b.replace("</body>", CENTERPROBE + "</body>") : b)) as never;
        orig(req, res);
      });
      const dom = await dumpDom(`${base}/page`, { width, height: 800, budgetMs: 6000 });
      server.removeAllListeners("request");
      server.on("request", orig);
      const m = /data-r="([^"]*)"/.exec(dom);
      if (!m) throw new Error("no probe result in dump");
      const r = JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
      expect(r.off).toBeLessThanOrEqual(12);
      expect(r.vgap).toBeGreaterThanOrEqual(4);
    }, 40000);
  }
});
