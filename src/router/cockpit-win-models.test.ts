/**
 * B8 `models`: the real page with  shows the routing section as a flow card plus one card per tier
 * (styled Select, chips with x, route.set through runAction, result in the card status); no native select in the cards. Headless Chromium, skipped when none is installed.
 * PAI_WIN_SHOTS=<dir> writes models-<width>-<theme>.png.
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
const limits = () => ({
  activeLocal: null, limits: [],
  routing: { flow: "", choices: [], rows: [], endpoints: [
    { id: "ep1", origin: "registered", host: "h1", healthy: true, enabled: true, tags: [], classes: [] },
    { id: "ep2", origin: "managed", host: "h2", healthy: false, enabled: true, tags: [], classes: [] },
  ] },
});
const models = () => ({
  at: 1, tiers: [{ tier: "gyro-m", maxInstances: 2 }, { tier: "iq3s", maxInstances: 1 }], consumers: [], runtimeCommands: {},
  instances: [{ id: "gyro-m-1", model: "gyro-m", state: "ready", port: 8101, pid: 11, inflight: 0 }],
  runtimes: [
    { name: "strata", kind: "strata", port: 8101, status: "running", tier: "gyro-m", users: ["worker:local"], models: [{ model: "gyro-m.gguf", kind: "coding", loaded: true, memoryMb: 4096, usedBy: ["worker:local"] }] },
    { name: "strata2", kind: "strata", port: 8102, status: "stopped", tier: "iq3s", users: [], models: [{ model: "iq3s.gguf", kind: "chat", loaded: false, usedBy: [] }] },
  ],
});
const posts: { [k: string]: unknown }[] = [];

const PROBE = `<script>setTimeout(function(){
function card(id){return document.querySelector('#win-root [data-card="'+id+'"]')}
function txt(id){var c=card(id);return c?c.textContent.replace(/\\s+/g," "):null}
function st(id){var c=card(id);var s=c&&c.querySelector(".cstatus");return s?s.textContent:null}
var ids=Array.prototype.map.call(document.querySelectorAll('#win-root [data-card^="models.rt:"]'),function(c){return c.getAttribute("data-card")});
var o={err:window.__err||null,ids:ids,ep:txt("models.endpoints"),run:txt("models.rt:strata/gyro-m.gguf"),stop:txt("models.rt:strata2/iq3s.gguf"),
 
 minall:!!document.querySelector('#win-root [data-act="minall"]'),
 offDis:!!(card("models")&&card("models").querySelector('[data-act="off"]')),
 offLabel:card("models")?card("models").querySelector('[data-act="off"]').textContent:null,offTitle:card("models")?card("models").querySelector('[data-act="off"]').title:null,
 vis:Array.prototype.filter.call(document.querySelectorAll("#win-root .card"),function(c){return c.style.display!=="none"}).map(function(c){return c.getAttribute("data-card")})};
if(!ids.length){document.body.setAttribute("data-r",JSON.stringify(o));return}
var sa=card("models.rt:strata2/iq3s.gguf").querySelector('[data-act="start"]');o.startDisabled=sa.disabled;
card("models.rt:strata/gyro-m.gguf").querySelector('[data-act="more"]').click();
var sb=card("models.rt:strata/gyro-m.gguf").querySelector(".wmd-stop");o.stopAct=sb.getAttribute("data-act");o.stopTitle=sb.title;sb.click();o.stopArmed=sb.textContent;sb.click();
var en=card("models.endpoints").querySelector(".wmd-en");if(en)en.click();
setTimeout(function(){o.after=st("models.rt:strata/gyro-m.gguf");document.body.setAttribute("data-r",JSON.stringify(o))},800);
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
      req.on("end", () => { posts.push(JSON.parse(b)); res.end(JSON.stringify({ ok: true, message: "done" })); });
      return;
    }
    if (url.startsWith("/cockpit/data")) return res.end(JSON.stringify(data()));
    if (url.startsWith("/cockpit/models")) return res.end(JSON.stringify(models()));
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

describe.skipIf(!CHROME)("B8 models on the win runtime", () => {
  it("every runtime is a card, stopped ones too; endpoints list; old section hidden; no minimize-all", async () => {
    const shots = process.env.PAI_WIN_SHOTS;
    const r = await open("", 1400, shots ? join(shots, "models-1400-light.png") : undefined);
    expect(r.err).toBeNull();
    expect(r.ids).toEqual(["models.rt:strata/gyro-m.gguf", "models.rt:strata2/iq3s.gguf"]);
    expect(r.run).toContain("running");
    expect(r.stop).toContain("stopped");
    expect(r.ep).toContain("ep1");
    expect(r.ep).toContain("disable routing");
    expect(r.minall).toBe(false);
    expect(r.offDis).toBe(true);
    // F5: the header action says what it does; F4: the endpoints card lists the router endpoints from the limits feed
    expect(r.offLabel).toBe("stop all local");
    expect(r.offTitle).toBe("stop every local model server (asks to confirm)");
    expect(r.ep).toContain("healthy");
    expect(r.startDisabled).toBe(false);
  }, 120_000);

  it("+ posts local.scale with count 2; the endpoint toggle posts endpoint.enable", async () => {
    posts.length = 0;
    const r = await open("", 1400);
    expect(posts.find((p) => p.action === "local.scale")).toEqual({ action: "local.scale", target: "gyro-m", count: 2 });
    expect(posts.find((p) => p.action === "endpoint.enable")).toEqual({ action: "endpoint.enable", target: "ep1", value: "off" });
    expect(r.after).toBe("done");
  }, 120_000);

  it("the instance stop is a registered action: data-act local.stop, a title with the id, the first click arms, the second posts local.stop for the instance", async () => {
    posts.length = 0;
    const r = await open("", 1400);
    expect(r.stopAct).toBe("local.stop");
    expect(r.stopTitle).toBe("stop instance gyro-m-1 (asks to confirm when requests are in flight)");
    expect(r.stopArmed).toBe("stop - click again");
    expect(posts.find((p) => p.action === "local.stop")).toEqual({ action: "local.stop", target: "gyro-m-1" });
  }, 120_000);

});
