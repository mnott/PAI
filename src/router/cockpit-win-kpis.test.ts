/**
 * B1 `kpis`: the real page with  shows the totals as a group of six metric cards in main#win-root;
 * without the flag the old page is unchanged. Headless Chromium, skipped when none is installed.
 * PAI_WIN_SHOTS=<dir> writes kpis-<width>-<theme>.png.
 */

import { execFile, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cockpitHtml } from "./cockpit-page.js";

const CHROME = process.env.CHROME_BIN ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));

const data = (errors: number) => ({
  window: "1h", totals: { requests: 5000, input: 9e6, output: 4e5, cacheWrite: 1e6, cacheRead: 9e7, errors, hitRatio: 0.9 },
  byModel: [], series: [], weights: { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 }, cachePause: [], byProvider: [],
  bustParts: {}, bySession: [], workers: [], daily: { models: {}, days: [] }, sessionSplit: null, speed: [], promptByProvider: {}, promptSince: {},
});

/** Reads the card boxes, then pushes a second payload (errors 900 -> 0, counts change) and reads again. */
const PROBE = `<script>setTimeout(function(){
var root=document.getElementById("win-root");
function boxes(){return Array.prototype.map.call(document.querySelectorAll("#win-root .card"),function(c){var r=c.getBoundingClientRect();return c.getAttribute("data-card")+":"+[r.left,r.top,r.width,r.height].map(Math.round).join(",")}).join("|")}
function vals(){return Array.prototype.map.call(document.querySelectorAll('#win-root [data-card^="kpis."][data-type="metric"]'),function(c){var v=c.querySelector('[data-k="v"]');return c.getAttribute("data-card")+"="+v.textContent+(v.className.indexOf("bad")>=0?"!":v.className.indexOf("warn")>=0?"~":"")}).join("|")}
var o={flag:!!root&&!root.hidden,rootHidden:root?root.hidden:null,cards:document.querySelectorAll("#win-root [data-card^='kpis']").length,heads:Array.prototype.map.call(document.querySelectorAll("#win-root [data-card^='kpis']>.chead"),function(h){return Array.prototype.map.call(h.children,function(k){return k.className.split(" ")[0]}).join(",")}),
 title:(document.querySelector('#win-root [data-card="kpis"] .ctt')||{}).textContent,
 vals:vals(),boxes:boxes(),err:window.__err||null};
if(window.Win){window.Win.update("data",{totals:{requests:1,input:2,output:3,cacheRead:4,cacheWrite:5,errors:0}});o.vals2=vals();o.boxes2=boxes()}
document.body.setAttribute("data-r",JSON.stringify(o));
},1500)</script>`;

let server: Server;
let base = "";
let tmp = "";
const browsers = new Set<ChildProcess>();
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "cockpit-win-kpis-"));
  server = createServer((req, res) => {
    const url = req.url ?? "";
    res.setHeader("content-type", "application/json");
    if (url.startsWith("/cockpit/data")) return res.end(JSON.stringify(data(900)));
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
async function open(query: string, width: number, shot?: string) {
  const args = ["--headless=new", "--disable-gpu", "--use-mock-keychain", "--password-store=basic", "--no-first-run", "--hide-scrollbars", `--user-data-dir=${join(tmp, "p" + Math.random().toString(36).slice(2))}`, `--window-size=${width},900`, "--virtual-time-budget=6000"];
  const url = `${base}/page${query}`;
  const dom = await run([...args, "--dump-dom", url]);
  if (shot) await run([...args, `--screenshot=${shot}`, url]);
  const m = /data-r="([^"]*)"/.exec(dom);
  if (!m) throw new Error("no probe result in dump");
  return JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
}

describe.skipIf(!CHROME)("B1 kpis on the win runtime", () => {
  it("shows the totals as a group of six metric cards; values update without moving a box", async () => {
    const shots = process.env.PAI_WIN_SHOTS;
    const r = await open("", 1400, shots ? join(shots, "kpis-1400-light.png") : undefined);
    expect(r.err).toBeNull();
    expect(r.flag).toBe(true);
    expect(r.cards).toBeGreaterThanOrEqual(7);
    expect(r.title).toBe("Totals in this window");
    for (const h of r.heads) expect(h).toMatch(/^cgrip,ctitle,cstatus(,cbtn)*$/);
    expect(r.vals).toBe("kpis.requests=5.0k|kpis.input=9.00M|kpis.output=400.0k|kpis.cache-read=90.00M|kpis.cache-write=1.00M|kpis.errors=900!");
    expect(r.vals2).toBe("kpis.requests=1|kpis.input=2|kpis.output=3|kpis.cache-read=4|kpis.cache-write=5|kpis.errors=0");
    expect(r.boxes2).toBe(r.boxes);
    // one row: the six metrics share a top and sit inside the group
    const tops = new Set((r.boxes as string).split("|").filter((b: string) => b.startsWith("kpis.")).map((b: string) => b.split(":")[1]!.split(",")[1]));
    expect(tops.size).toBe(1);
  }, 120_000);

});
