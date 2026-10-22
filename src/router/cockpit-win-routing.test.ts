/**
 * B6 `routing`: the real page with  shows the routing section as a flow card plus one card per tier
 * (styled Select, chips with x, route.set through runAction, result in the card status); no native select in the cards. Headless Chromium, skipped when none is installed.
 * PAI_WIN_SHOTS=<dir> writes routing-<width>-<theme>.png.
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
const chip = (entry: string, state = "available") => ({ entry, label: entry, state, why: state });
const limits = () => ({
  activeLocal: null, limits: [],
  routing: {
    flow: "implement -> local · review -> glm", endpoints: [],
    choices: [{ entry: "local", label: "local" }, { entry: "glm", label: "glm" }, { entry: "tag:fast", label: "tag: fast" }],
    rows: [
      { id: "implement", label: "implement", description: "writes code", note: "", classes: ["code"], chips: [chip("local"), chip("glm", "idle")], sessions: [{ session: "PAI", note: "", chips: [chip("glm")] }] },
      { id: "review", label: "review", description: "reads code", note: "", classes: [], chips: [chip("glm")], sessions: [] },
    ],
  },
});
const posts: { [k: string]: unknown }[] = [];

/** Reads the cards, then drives the review tier's x (refused), the implement tier's Select (route.set). */
const PROBE = `<script>setTimeout(function(){
function card(id){return document.querySelector('#win-root [data-card="'+id+'"]')}
function txt(id){var c=card(id);return c?c.textContent.replace(/\\s+/g," "):null}
function st(id){var c=card(id);var s=c&&c.querySelector(".cstatus");return s?s.textContent:null}
var o={err:window.__err||null,flow:txt("routing.flow"),impl:txt("routing.implement"),rev:txt("routing.review"),
 natives:document.querySelectorAll('#win-root [data-card^="routing"] select').length,
 selBtns:document.querySelectorAll('#win-root [data-card^="routing"] button.wsel-btn').length,
 
 vis:Array.prototype.filter.call(document.querySelectorAll("#win-root .card"),function(c){return c.style.display!=="none"}).map(function(c){return c.getAttribute("data-card")}),
 popBg:null};
if(!card("routing.review")){document.body.setAttribute("data-r",JSON.stringify(o));return}
var rm=card("routing.review").querySelector(".rtrm");if(rm)rm.click();
o.refused=st("routing.review");
var rmi=card("routing.implement").querySelector(".rtrm");o.rmAct=rmi.getAttribute("data-act");o.rmTitle=rmi.title;rmi.click();
setTimeout(function(){o.rmAfter=st("routing.implement");
var b=card("routing.implement").querySelector("button.wsel-btn");
b.click();
var pop=document.querySelector(".wpop");o.popBg=pop?getComputedStyle(pop).backgroundColor:null;
var opts=pop?pop.querySelectorAll(".wopt"):[];o.opts=Array.prototype.map.call(opts,function(x){return x.textContent});
if(opts[2])opts[2].dispatchEvent(new MouseEvent("click",{bubbles:true}));
setTimeout(function(){o.after=st("routing.implement");document.body.setAttribute("data-r",JSON.stringify(o))},800);
},400);
},1500)</script>`;

let server: Server;
let base = "";
let tmp = "";
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "cockpit-win-routing-"));
  server = createServer((req, res) => {
    const url = req.url ?? "";
    res.setHeader("content-type", "application/json");
    if (url.startsWith("/cockpit/action") && req.method === "POST") {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => { posts.push(JSON.parse(b)); res.end(JSON.stringify({ ok: true, message: "route set" })); });
      return;
    }
    if (url.startsWith("/cockpit/data")) return res.end(JSON.stringify(data()));
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

describe.skipIf(!CHROME)("B6 routing on the win runtime", () => {
  it("a flow card and one card per tier; styled Select, no native select; the old section is hidden", async () => {
    const shots = process.env.PAI_WIN_SHOTS;
    const r = await open("", 1400, shots ? join(shots, "routing-1400-light.png") : undefined);
    expect(r.err).toBeNull();
    expect(r.vis).toEqual(expect.arrayContaining(["routing", "routing.flow", "routing.implement", "routing.review"]));
    expect(r.flow).toContain("implement -> local");
    expect(r.impl).toContain("implement");
    expect(r.impl).toContain("glm");
    expect(r.impl).toContain("PAI:");
    expect(r.natives).toBe(0);
    expect(r.selBtns).toBe(2);
    expect(r.opts).toEqual(["local", "glm", "tag: fast"]);
    expect(r.popBg).not.toBe("rgba(0, 0, 0, 0)");
  }, 120_000);

  it("x on the last entry is refused in the status; a Select pick posts route.set with the pick first", async () => {
    posts.length = 0;
    const r = await open("", 1400);
    expect(r.refused).toBe("a tier needs at least one entry");
    expect(posts.filter((p) => p.target === "review")).toEqual([]);
    const p = posts.find((x) => x.action === "route.set" && x.target === "implement" && (x.models as string[]).length > 1);
    expect(p).toEqual({ action: "route.set", target: "implement", models: ["tag:fast", "local", "glm"] });
    expect(r.after).toBe("route set");
  }, 120_000);

  it("the x on a chip is a registered action: data-act route.set, a title, and a click posts the tier minus that entry and shows the status", async () => {
    posts.length = 0;
    const r = await open("", 1400);
    expect(r.rmAct).toBe("route.set");
    expect(r.rmTitle).toBe("remove local from this tier");
    expect(posts.find((x) => x.action === "route.set" && x.target === "implement" && (x.models as string[]).length === 1)).toEqual({ action: "route.set", target: "implement", models: ["glm"] });
    expect(r.rmAfter).toBe("route set");
  }, 120_000);

});
