/**
 * C1 / spec 9.3 structure checks on the full /cockpit page, fixture data for the data, queue and memory feeds:
 * every .chead holds grip, title, status, 0..n actions, minimize in that order; no <select> and no <details> anywhere;
 * no text outside a .card (the header aside); every button in a card is a card control, a registered action (data-act),
 * a queue verb (data-q) or disabled with a title; no .tw scrolls sideways. Headless Chromium, skipped when none is installed.
 */

import { execFile, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cockpitHtml } from "./cockpit-page.js";

const CHROME = process.env.CHROME_BIN ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));

const data = () => ({
  window: "1h", totals: { requests: 5000, input: 9e6, output: 4e5, cacheWrite: 1e6, cacheRead: 9e7, errors: 0, hitRatio: 0.9 },
  byModel: [], series: [], weights: { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 }, cachePause: [], byProvider: [],
  bustParts: {}, bySession: [], workers: [], daily: { models: {}, days: [] }, sessionSplit: null, speed: [], promptByProvider: {}, promptSince: {},
});
const queue = () => ({
  providers: [
    { provider: "local", cap: 1, conversationSlots: 2, running: [{ id: "w-run", label: "running job", ageSec: 120, now: "editing", session: "PAI", model: "m1" }],
      waiting: [{ id: "w-a", label: "first waiting", waitedSec: 30, position: 1, session: "PAI", model: "m1" }, { id: "w-b", label: "second waiting", waitedSec: 20, position: 2, session: "PAI", model: "m1" }] },
    { provider: "glm", cap: 3, running: [{ id: "w-g", label: "glm job", ageSec: 90, now: "", session: "Whazaa", model: "glm-5" }], waiting: [] },
  ],
  panes: [{ label: "pane one", cwd: "/work/x", ageSec: 50, log: "/tmp/l" }], paneViolations: [], plans: [{ job: "plan-1", merged: 1, total: 3, phase: "build", phaseSec: 10, ageSec: 99, running: ["a"] }],
  builds: { slots: 2, testSlots: 1, running: [{ kind: "test", id: "t1", label: "vitest", session: "PAI", ageSec: 5 }], waiting: [] },
  sessionMax: {}, localModel: "local model gyro-m up", worktrees: "3 worktrees",
});

const PROBE = `<script>setTimeout(function(){
var cards=document.querySelectorAll("#win-root .card"),heads=[],bad=[],text=[];
Array.prototype.forEach.call(document.querySelectorAll("#win-root .chead"),function(h){heads.push(Array.prototype.map.call(h.children,function(k){return k.className.split(" ")[0]+(k.className.indexOf("cact")>=0?":act":k.className.indexOf("cmin")>=0?":min":"")}).join(","))});
Array.prototype.forEach.call(document.querySelectorAll("#win-root .card button"),function(b){
 var c=b.className.indexOf("cgrip")>=0||b.className.indexOf("cmin")>=0||b.hasAttribute("data-act")||b.hasAttribute("data-q")||!!b.closest(".wctl")||(b.disabled&&b.title);
 if(!c)bad.push((b.closest(".card").getAttribute("data-card"))+"|"+b.className+"|"+b.textContent.slice(0,20));
});
var w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,null);
for(var n;n=w.nextNode();){
 if(!n.nodeValue.trim())continue;
 var p=n.parentNode;
 if(p.closest("script,style,header,.card,.cwlive"))continue;
 text.push(p.tagName+":"+n.nodeValue.trim().slice(0,30));
}
var tws=Array.prototype.filter.call(document.querySelectorAll("#win-root .tw"),function(t){return t.scrollWidth>t.clientWidth}).length;
document.body.setAttribute("data-r",JSON.stringify({err:window.__err||null,n:cards.length,heads:heads,bad:bad,text:text,selects:document.querySelectorAll("select").length,details:document.querySelectorAll("details").length,tws:tws}));
},2500)</script>`;

let server: Server;
let base = "";
let tmp = "";
const posts: string[] = [];
const browsers = new Set<ChildProcess>();
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "cockpit-win-structure-"));
  server = createServer((req, res) => {
    const url = req.url ?? "";
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && url.startsWith("/cockpit/queue/")) {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => { posts.push(url + " " + b); res.end(JSON.stringify({ ok: true, id: "w-b", provider: "local", order: [] })); });
      return;
    }
    if (url.startsWith("/cockpit/data")) return res.end(JSON.stringify(data()));
    if (url.startsWith("/cockpit/queue")) return res.end(JSON.stringify(queue()));
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

describe.skipIf(!CHROME)("C1 structure checks on the full page (spec 9.3)", () => {
  it("chead order, no select/details, no text outside a card, every control registered or disabled with a title, no sideways table scroll", async () => {
    const r = await open("", 1400);
    expect(r.err).toBeNull();
    expect(r.n, "cards rendered").toBeGreaterThan(10);
    for (const h of r.heads as string[]) expect(h, h).toMatch(/^cgrip,ctitle,cstatus(,(cbtn:act|wctl))*,cbtn:min$|^cgrip,ctitle,cstatus(,(cbtn:act|wctl))*$/);
    expect(r.selects).toBe(0);
    expect(r.details).toBe(0);
    expect(r.text).toEqual([]);
    expect(r.bad).toEqual([]);
    expect(r.tws).toBe(0);
  }, 120_000);
});
