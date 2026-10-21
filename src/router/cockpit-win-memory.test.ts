/**
 * B3 `memory`: the real page with ?win=1 shows the memory group (kv + metric cards, a dynamic card per job) in
 * main#win-root, its embed/index/stop actions are header buttons of the group card (disabled with a reason, result in the
 * card status via runAction); without the flag the old page is unchanged. Headless Chromium, skipped when none is installed.
 * PAI_WIN_SHOTS=<dir> writes memory-<width>.png.
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
const NOW = Date.now();
let running = true;
let backlog = 122_303;
const memory = () => ({
  at: NOW, daemon: true, level: "amber", reason: "re-embed neutral-b-reembed running", title: "Memory", stallSecs: 300,
  counts: { files: 500, chunks: 2_000_000, embedded: 1_877_697, backlog, coverage: 0.9388, coverageLevel: "amber", exact: false },
  segments: { fresh: 111_111, old: 1_766_586, missing: backlog }, reembedding: true,
  binding: { mismatch: true, hint: "re-embed to neutral-b in progress", error: null, bound: { backend: "neutral-a", model: "model-a" }, configured: { backend: "neutral-b", model: "model-b", dims: 8 } },
  backend: { id: "neutral-b", model: "model-b", dims: 8, available: true, reason: "ready", loaded: [], loadedModel: "model-b:1", gpuShare: 0.75, alsoLoaded: [] },
  daemonInfo: { pid: 4321, uptimeSecs: 7300, version: "1.2.3", storage: "neutral-store" },
  jobs: [{ id: "run-embed", kind: "embed", name: "embed run", phase: "embed", done: 50, total: 100, pct: 50, rate: 2, etaSec: 25, doneAt: NOW + 25_000, lastProgressAt: NOW - 1000, stalled: false, series: [2, 2, 2], by: "cockpit" }],
  passes: [{ name: "index", state: "ok", lastEnd: NOW - 3_600_000, nextAt: NOW + 3_600_000, failure: null, detail: null }],
  lastIndex: null, lastEmbed: null, schedule: { maintenanceHour: 3, indexIntervalSecs: 86400, embedIntervalSecs: 86400 },
  run: running ? { kind: "embed", by: "cockpit", pid: 1, jobId: "", startedAt: new Date(NOW - 5000).toISOString(), elapsedSec: 5, done: 50, backlogStart: 100, rate: 2, etaSec: 25, tail: "", stoppable: true } : null,
  starting: null, lastRun: null,
});

/** Reads the cards at 1500 ms, clicks "index now" (when enabled), reads again at 3000 ms. */
const PROBE = `<script>setTimeout(function(){
function vis(){return Array.prototype.filter.call(document.querySelectorAll("#win-root .card"),function(c){return c.style.display!=="none"}).map(function(c){return c.getAttribute("data-card")})}
function txt(id){var c=document.querySelector('#win-root [data-card="'+id+'"]');return c?c.textContent.replace(/\\s+/g," "):null}
function btn(a){var b=document.querySelector('#win-root [data-card="memory"] [data-act="'+a+'"]');return b?{dis:b.disabled,title:b.title||""}:null}
function st(id){var c=document.querySelector('#win-root [data-card="'+id+'"] .cstatus');return c?c.getAttribute("data-kind")+"|"+c.textContent:null}
var o={err:window.__err||null,vis:vis(),kv:txt("memory.kv"),kvst:st("memory.kv"),index:txt("memory.index"),backend:txt("memory.backend"),job:txt("memory.job:run-embed"),passes:txt("memory.passes"),daemon:txt("memory.daemon"),
 embed:btn("embed"),index2:btn("index"),stop:btn("stop"),oldMem:getComputedStyle(document.querySelector('[data-section="memory"]')).display,oldRt:document.querySelectorAll('#win-root [data-rt="memory"]').length,
 heads:Array.prototype.map.call(document.querySelectorAll('#win-root [data-card="memory"] > .chead'),function(h){return Array.prototype.map.call(h.children,function(k){return k.className.split(" ")[0]}).join(",")})};
document.body.setAttribute("data-r1",JSON.stringify(o));
var b=document.querySelector('#win-root [data-card="memory"] [data-act="index"]');
if(b&&!b.disabled)b.click();
setTimeout(function(){document.body.setAttribute("data-r",JSON.stringify({r1:o,st:st("memory"),posts:window.__posts||0}))},1500);
},1500)</script>`;

let server: Server;
let base = "";
let tmp = "";
const browsers = new Set<ChildProcess>();
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "cockpit-win-memory-"));
  server = createServer((req, res) => {
    const url = req.url ?? "";
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && url.startsWith("/cockpit/action")) return res.end(JSON.stringify({ ok: true, message: "index pass started" }));
    if (url.startsWith("/cockpit/data")) return res.end(JSON.stringify(data()));
    if (url.startsWith("/cockpit/memory")) return res.end(JSON.stringify(memory()));
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

describe.skipIf(!CHROME)("B3 memory on the win runtime (?win=1)", () => {
  it("a run is active: cards, run pill in the kv status, embed/index disabled with the reason, stop enabled", async () => {
    running = true; backlog = 122_303;
    const shots = process.env.PAI_WIN_SHOTS;
    const o = (await open("?win=1", 1400, shots ? join(shots, "memory-1400.png") : undefined)).r1;
    expect(o.err).toBeNull();
    expect(o.vis).toEqual(expect.arrayContaining(["memory", "memory.kv", "memory.index", "memory.backend", "memory.job:run-embed", "memory.passes", "memory.daemon"]));
    expect(o.kv).toContain("attention");
    expect(o.kvst).toMatch(/^run\|embedding 50%/);
    expect(o.index).toContain("93.9");
    expect(o.backend).toContain("neutral-b");
    expect(o.job).toContain("50.0");
    expect(o.passes).toContain("1 scheduled");
    expect(o.daemon).toContain("pid 4321");
    expect(o.embed).toEqual({ dis: true, title: "a run is in progress" });
    expect(o.index2).toEqual({ dis: true, title: "a run is in progress" });
    expect(o.stop.dis).toBe(false);
    expect(o.oldMem).toBe("none");
    expect(o.oldRt).toBe(0);
    expect(o.heads[0]).toMatch(/^cgrip,ctitle,cstatus(,cbtn)+$/);
  }, 120_000);

  it("idle with backlog 0: embed refused with its reason, index now runs through runAction into the group status", async () => {
    running = false; backlog = 0;
    const r = await open("?win=1", 1400);
    expect(r.r1.embed).toEqual({ dis: true, title: "nothing to embed (backlog 0)" });
    expect(r.r1.index2.dis).toBe(false);
    expect(r.r1.stop).toEqual({ dis: true, title: "nothing to stop" });
    expect(r.r1.kvst).toBe("null|");
    expect(r.st).toBe("ok|index pass started");
  }, 120_000);

  it("without the flag the old memory section is unchanged", async () => {
    running = true; backlog = 122_303;
    const r = await open("", 1400);
    expect(r.r1.err).toBeNull();
    expect(r.r1.oldMem).not.toBe("none");
    expect(r.r1.vis).toEqual([]);
  }, 120_000);
});
