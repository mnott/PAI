/**
 * Structural add into a group (Win.addCards): a memory job card appears at runtime (a run starts). The existing cards of the group keep
 * their size and position, the group grows by the new card's need, the cards below shift. Headless Chromium, skipped when none is installed.
 * PAI_STABLE_TABLE=1 prints the heights before/after.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cockpitHtml } from "./cockpit-page.js";
import { CHROME, dumpDom, killChromes } from "./cdp-browser.js";

let jobs = false;
const data = () => ({
  window: "1h", totals: { requests: 5000, input: 9e6, output: 4e5, cacheWrite: 1e6, cacheRead: 9e7, errors: 0, hitRatio: 0.9 },
  byModel: [], series: [], weights: { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 }, cachePause: [], byProvider: [],
  bustParts: {}, bySession: [], workers: [], daily: { models: {}, days: [] }, sessionSplit: null, speed: [], promptByProvider: {}, promptSince: {},
});
const NOW = Date.now();
const memory = () => ({
  at: NOW, daemon: true, level: "amber", reason: "re-embed running", title: "Memory", stallSecs: 300,
  counts: { files: 500, chunks: 2_000_000, embedded: 1_877_697, backlog: 122_303, coverage: 0.9388, coverageLevel: "amber", exact: false },
  segments: { fresh: 111_111, old: 1_766_586, missing: 122_303 }, reembedding: false,
  binding: { mismatch: false, hint: "", error: null, bound: { backend: "neutral-b", model: "model-b" }, configured: { backend: "neutral-b", model: "model-b", dims: 8 } },
  backend: { id: "neutral-b", model: "model-b", dims: 8, available: true, reason: "ready", loaded: [], loadedModel: "model-b:1", gpuShare: 0.75, alsoLoaded: [] },
  daemonInfo: { pid: 4321, uptimeSecs: 7300, version: "1.2.3", storage: "neutral-store" },
  jobs: [{ id: "old-a", kind: "embed", name: "old a", phase: "embed", done: 1, total: 2, pct: 50, rate: 1, etaSec: 5, doneAt: NOW + 5000, lastProgressAt: NOW, stalled: false, series: [1], by: "x" }, { id: "old-b", kind: "embed", name: "old b", phase: "embed", done: 1, total: 2, pct: 50, rate: 1, etaSec: 5, doneAt: NOW + 5000, lastProgressAt: NOW, stalled: false, series: [1], by: "x" }, ...(jobs ? [{ id: "run-embed", kind: "embed", name: "embed run", phase: "embed", done: 50, total: 100, pct: 50, rate: 2, etaSec: 25, doneAt: NOW + 25_000, lastProgressAt: NOW - 1000, stalled: false, series: [2, 2, 2], by: "cockpit" }] : [])],
  passes: [{ name: "index", state: "ok", lastEnd: NOW - 3_600_000, nextAt: NOW + 3_600_000, failure: null, detail: null }],
  lastIndex: null, lastEmbed: null, schedule: { maintenanceHour: 3, indexIntervalSecs: 86400, embedIntervalSecs: 86400 },
  run: null, starting: null, lastRun: null,
});

/** Initial jobs from the start (the live case); at 3 s a nested group "memory.sub" with two cards is added, at 6 s a third card goes
 *  into memory.sub, at 9 s a job card appears in memory. Heights are read before and after each step. */
const PROBE = `<script>
function snap(){var o={};Array.prototype.forEach.call(document.querySelectorAll("#win-root .card"),function(c){
 if(c.style.display==="none")return;var r=c.getBoundingClientRect(),b=c.querySelector(".cbody");
 o[c.getAttribute("data-card")]={top:Math.round((r.top+window.scrollY)*100)/100,h:Math.round(r.height*100)/100,over:b?b.scrollHeight-b.clientHeight:0};
});return o}
function sp(id){return{id:id,type:"metricm",title:id,feeds:[],view:function(){return{v:"1",u:"",s:"x",x:"<div>a</div><div>b</div>",cls:{},status:["",""]}}}}
var R={};
setTimeout(function(){R.A=snap();Win.addCards("memory",[{id:"memory.sub",type:"group",title:"sub",feeds:[]}],[["memory.sub"]])},3000);
setTimeout(function(){Win.addCards("memory.sub",[sp("sub.a"),sp("sub.b")],[["sub.a"],["sub.b"]])},4000);
setTimeout(function(){R.B=snap();Win.addCards("memory.sub",[sp("sub.c")],[["sub.c"]])},6000);
setTimeout(function(){R.C=snap();fetch("/test/jobs")},9000);
setTimeout(function(){R.D=snap();Win.addCards("memory",[{id:"memory.empty",type:"chart",title:"empty",feeds:[]}],[["memory.empty"]])},12000);
setTimeout(function(){R.E=snap();Win.addCards("memory.sub",[{id:"sub.empty",type:"chart",title:"empty",feeds:[]}],[["sub.empty"]])},13000);
setTimeout(function(){R.F=snap();document.body.setAttribute("data-r",JSON.stringify({err:window.__err||null,R:R}))},14000);
</script>`;

type Cards = Record<string, { top: number; h: number; over: number }>;
let server: Server;
let base = "";
let tmp = "";
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "cockpit-win-sadd-"));
  server = createServer((req, res) => {
    const url = req.url ?? "";
    res.setHeader("content-type", "application/json");
    if (url.startsWith("/test/jobs")) { jobs = true; return res.end("{}"); }
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
afterAll(() => { killChromes(); server?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

async function open(width: number, q = "") {
  jobs = false;
  const o = { width, height: 900, budgetMs: 16000 };
  const dom = await dumpDom(`${base}/page${q}`, o);
  const m = /data-r="([^"]*)"/.exec(dom);
  if (!m) throw new Error("no probe result in dump");
  return JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")) as { err: string | null; R: { A: Cards; B: Cards; C: Cards; rm: number } };
}

/** Every card present in both snapshots, except the ones named, must keep its height; returns "id delta" for the ones that moved. */
const moved = (a: Cards, b: Cards, skip: RegExp) => Object.keys(a).filter((id) => b[id] && !skip.test(id)).map((id) => `${id} ${b[id]!.h - a[id]!.h}`).filter((s) => !s.endsWith(" 0"));

describe.skipIf(!CHROME)("structural add, auto layout and nested groups", () => {
  for (const width of [1400, 700]) {
    it(`no existing card changes height when a card joins a nested group or a job joins the memory group (${width}px)`, async () => {
      const { err, R } = await open(width);
      expect(err).toBeNull();
      const D = R as unknown as { A: Cards; B: Cards; C: Cards; D: Cards; E: Cards; F: Cards };
      if (process.env.PAI_STABLE_TABLE) {
        const ids = [...new Set([...Object.keys(D.B), ...Object.keys(D.F)])].filter((id) => /^memory/.test(id));
        console.log(width, ids.map((id) => `${id} h ${D.A[id]?.h}->${D.B[id]?.h}->${D.C[id]?.h}->${D.D[id]?.h}->${D.E[id]?.h}->${D.F[id]?.h} over ${D.F[id]?.over}`).join("\n"));
      }
      expect(D.C["sub.c"]).toBeDefined();
      expect(D.D["memory.job:run-embed"]).toBeDefined();
      expect(moved(D.B, D.C, /^sub\.c$|^memory\.sub$|^memory$/)).toEqual([]); // nested add: only the ancestors grow
      expect(D.C["memory.sub"]!.h).toBeGreaterThan(D.B["memory.sub"]!.h);
      expect(D.C["memory"]!.h).toBeGreaterThan(D.B["memory"]!.h);
      expect(moved(D.C, D.D, /^memory\.job:run-embed$|^memory$/)).toEqual([]); // job add: siblings keep their heights
      expect(D.E["memory.empty"]).toBeDefined();
      expect(moved(D.D, D.E, /^memory\.empty$|^memory$/)).toEqual([]); // a chart (no content reading)
      expect(D.F["sub.empty"]).toBeDefined();
      expect(moved(D.E, D.F, /^sub\.empty$|^memory\.sub$|^memory$/)).toEqual([]); // the same inside a nested group
      expect(Object.keys(D.D).filter((id) => D.D[id]!.over > 0 && !D.C[id]?.over)).toEqual([]);
    }, 120_000);
  }
});
