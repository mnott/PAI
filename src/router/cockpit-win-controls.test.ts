/**
 * Guard: no native-white control on . Every button/input/textarea/select inside #win-root has an effective background
 * that follows the page theme (dark: luminance < 0.2, light: > 0.5), with readable text. Fixtures render the model cards (a
 * running instance row, small ollama models with nothing loaded), the registry editor and the backups card.
 * Headless Chromium, skipped when none is installed.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cockpitHtml } from "./cockpit-page.js";
import { CHROME, dumpDom, killChromes } from "./cdp-browser.js";

const data = () => ({
  window: "1h", totals: { requests: 5000, input: 9e6, output: 4e5, cacheWrite: 1e6, cacheRead: 9e7, errors: 0, hitRatio: 0.9 },
  byModel: [], series: [], weights: { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 }, cachePause: [], byProvider: [],
  bustParts: {}, bySession: [], workers: [], daily: { models: {}, days: [] }, sessionSplit: null, speed: [], promptByProvider: {}, promptSince: {},
});
const models = () => ({
  registryModels: [{
    name: "gyro-m", file: "/s/gyro.json", engine: "strata", port: 8035, tier: "gyro-m", state: "running",
    instances: [{ id: "gyro-m#1", pid: 11, port: 8035, inflight: 0 }], maxInstances: 4,
  }],
  runtimes: [{ name: "ollama", kind: "ollama", port: 11434, status: "running", users: ["pai-embedding"], models: [{ model: "arctic", kind: "embedding", loaded: false, usedBy: ["pai-embedding"] }] }],
  consumers: [], instances: [], tiers: [{ tier: "gyro-m", maxInstances: 4 }],
  runtimeCommands: { ollama: { start: "ollama serve", stop: "pkill ollama" } },
});
const limits = () => ({ activeLocal: null, limits: [], routing: { flow: "", endpoints: [], choices: [], rows: [] } });
const YAML = "workers:\n  gyro-m:\n    port: 8035\n";

const PROBE = `<script>setTimeout(function(){
function lum(c){var m=c.match(/[\\d.]+/g).map(Number);var a=m.length>3?m[3]:1;var v=m.slice(0,3).map(function(x){x/=255;return x<=0.03928?x/12.92:Math.pow((x+0.055)/1.055,2.4)});return{l:0.2126*v[0]+0.7152*v[1]+0.0722*v[2],a:a}}
function eff(e){for(;e;e=e.parentElement){var c=getComputedStyle(e).backgroundColor,x=lum(c);if(x.a>0)return x.l}return 1}
var o={err:window.__err||null,theme:document.documentElement.dataset.theme,n:0,rows:[]};
Array.prototype.forEach.call(document.querySelectorAll("#win-root button,#win-root input,#win-root textarea,#win-root select"),function(e){
 var card=e.closest("[data-card]");
 var hd=e.closest(".chead");
 if(hd&&hd.parentElement&&hd.parentElement.getAttribute("data-depth")==="0"){o.topBar=(o.topBar||0)+1;return}
 o.n++;o.rows.push({name:e.tagName.toLowerCase()+"."+(e.className||"")+"["+(e.textContent||e.getAttribute("aria-label")||"").slice(0,24)+"]@"+(card?card.getAttribute("data-card"):"?"),bg:Math.round(eff(e)*1000)/1000,fg:Math.round(lum(getComputedStyle(e).color).l*1000)/1000})});
var s=document.querySelector('#win-root [data-card="models.rt:ollama/arctic"] [data-act="stop"]');o.smallStop=s?{dis:s.disabled,title:s.title}:null;
o.cards=Array.prototype.map.call(document.querySelectorAll("#win-root [data-card]"),function(c){return c.getAttribute("data-card")});
o.scheme=getComputedStyle(document.getElementById("win-root")).colorScheme;
document.body.setAttribute("data-r",JSON.stringify(o))},2500)</script>`;

let server: Server;
let base = "";
let tmp = "";
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "cockpit-win-controls-"));
  server = createServer((req, res) => {
    const url = req.url ?? "";
    res.setHeader("content-type", "application/json");
    if (req.method === "POST") return res.end(JSON.stringify({ ok: true, errors: [], diff: [] }));
    if (url.startsWith("/cockpit/data")) return res.end(JSON.stringify(data()));
    if (url.startsWith("/cockpit/limits")) return res.end(JSON.stringify(limits()));
    if (url.startsWith("/cockpit/models")) return res.end(JSON.stringify(models()));
    if (url.startsWith("/cockpit/registry/backups")) return res.end(JSON.stringify({ backups: [{ name: "workers.yaml.20260101-000000.bak", size: 300, mtime: 1, summary: "+1 -0 lines" }] }));
    if (url.startsWith("/cockpit/registry")) return res.end(JSON.stringify({ yaml: YAML, mtime: 1, hash: "h" }));
    if (url.startsWith("/cockpit/")) return res.end("{}");
    if (url.startsWith("/page")) {
      const theme = /theme=(\w+)/.exec(url)![1]!;
      res.setHeader("content-type", "text/html");
      return res.end(cockpitHtml()
        .replace("<head>", `<head><script>localStorage.setItem("pai.cockpit.theme","${theme}");window.onerror=function(m,s,l,c){window.__err=String(m)+" @"+l+":"+c}</script>`)
        .replace("</body>", PROBE + "</body>"));
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => { killChromes(); server?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

async function open(theme: string) {
  const o = { width: 1300, height: 4600, budgetMs: 8000, scrollbars: false };
  const url = `${base}/page?theme=${theme}`;
  const dom = await dumpDom(url, o);
  const m = /data-r="([^"]*)"/.exec(dom);
  if (!m) throw new Error("no probe result in dump");
  return JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")) as {
    err: string | null; theme: string; n: number; rows: { name: string; bg: number; fg: number }[]; topBar?: number; smallStop: { dis: boolean; title: string } | null; cards: string[]; scheme: string;
  };
}

describe.skipIf(!CHROME)("win controls follow the theme", () => {
  it("dark: every button/input/textarea/select has a dark background", async () => {
    const r = await open("dark");
    expect(r.err).toBeNull();
    expect(r.theme).toBe("dark");
    expect(r.cards).toEqual(expect.arrayContaining(["models.model:gyro-m", "settings.registry-edit"]));
    expect(r.rows.some((x) => x.name.startsWith("textarea"))).toBe(true);
    expect(r.rows.some((x) => x.name.includes("wmd-stop"))).toBe(true);
    const bad = r.rows.filter((x) => !(x.bg < 0.2)).map((x) => `${x.name} bg=${x.bg}`);
    expect(bad, `white controls:\n${bad.join("\n")}`).toEqual([]);
    // the editor textarea is transparent by design (its highlight layer shows the text)
    expect(r.rows.filter((x) => !(x.fg > 0.2) && !x.name.startsWith("textarea.wrg-ta")).map((x) => `${x.name} fg=${x.fg}`)).toEqual([]);
    expect(r.scheme).toBe("dark");
  }, 120_000);

  it("light: the same controls have a light background and dark text", async () => {
    const r = await open("light");
    expect(r.theme).toBe("light");
    const bad = r.rows.filter((x) => !(x.bg > 0.5) || !(x.fg < 0.4)).map((x) => `${x.name} bg=${x.bg} fg=${x.fg}`);
    expect(bad, `dark-on-dark controls:\n${bad.join("\n")}`).toEqual([]);
    expect(r.scheme).toBe("light");
  }, 120_000);

  it("a small model with nothing loaded has its stop disabled with the reason", async () => {
    const r = await open("dark");
    expect(r.smallStop).toEqual({ dis: true, title: "nothing loaded" });
  }, 120_000);
});
