/**
 * B3 `memory`: the real page with  shows the memory group (kv + metric cards, a dynamic card per job) in
 * main#win-root, its embed/index/stop actions are header buttons of the group card (disabled with a reason, result in the
 * card status via runAction); without the flag the old page is unchanged. Headless Chromium, skipped when none is installed.
 * PAI_WIN_SHOTS=<dir> writes workers-<width>.png.
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
function vis(){return Array.prototype.filter.call(document.querySelectorAll("#win-root .card"),function(c){return c.style.display!=="none"}).map(function(c){return c.getAttribute("data-card")})}
function txt(id){var c=document.querySelector('#win-root [data-card="'+id+'"]');return c?c.textContent.replace(/\\s+/g," "):null}
function st(id){var c=document.querySelector('#win-root [data-card="'+id+'"] .cstatus');return c?c.getAttribute("data-kind")+"|"+c.textContent:null}
var o={err:window.__err||null,vis:vis(),local:txt("workers.local"),wt:txt("workers.wt"),plans:txt("workers.plans"),prov:txt("workers.prov:local"),sess:txt("workers.sess:Whazaa"),tests:txt("workers.tests"),
 
 drag:document.querySelectorAll('#win-root [data-card="workers.prov:local"] tr[draggable="true"]').length,
 btns:document.querySelectorAll('#win-root [data-card="workers.prov:local"] button[data-q]').length};
document.body.setAttribute("data-r1",JSON.stringify(o));
var up=document.querySelector('#win-root [data-card="workers.prov:local"] button[data-q="up"][data-id="w-b"]');
if(up)up.click();
var rows=document.querySelectorAll('#win-root [data-card="workers.prov:local"] tr[draggable="true"]');
if(rows.length===2){
 var mk=function(t){return new Event(t,{bubbles:true,cancelable:true})};
 rows[1].dispatchEvent(mk("dragstart"));rows[0].dispatchEvent(mk("dragover"));rows[0].dispatchEvent(mk("drop"));rows[1].dispatchEvent(mk("dragend"));
}
setTimeout(function(){document.body.setAttribute("data-r",JSON.stringify({r1:o,st:st("workers.prov:local")}))},1500);
},1500)</script>`;

let server: Server;
let base = "";
let tmp = "";
const posts: string[] = [];
const browsers = new Set<ChildProcess>();
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "cockpit-win-workers-"));
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

describe.skipIf(!CHROME)("B5 workers on the win runtime", () => {
  it("block cards per provider/session/plan/build, note cards, row buttons run queue verbs, a row drag posts queue/move", async () => {
    posts.length = 0;
    const shots = process.env.PAI_WIN_SHOTS;
    const r = await open("", 1400, shots ? join(shots, "workers-1400.png") : undefined);
    const o = r.r1;
    expect(o.err).toBeNull();
    expect(o.vis).toEqual(expect.arrayContaining(["workers", "workers.local", "workers.wt", "workers.plans", "workers.prov:local", "workers.sess:Whazaa", "workers.tests"]));
    expect(o.local).toContain("local model gyro-m up");
    expect(o.wt).toContain("3 worktrees");
    expect(o.plans).toContain("plan-1");
    expect(o.prov).toContain("second waiting");
    expect(o.sess).toContain("glm job");
    expect(o.tests).toContain("vitest");
    expect(o.drag).toBe(2);
    expect(o.btns).toBe(4);
    expect(posts).toContain('/cockpit/queue/up {"id":"w-b"}');
    expect(posts).toContain('/cockpit/queue/move {"id":"w-b","position":1}');
    expect(r.st).toMatch(/^ok\|/);
  }, 120_000);

});
