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
  jobs: jobs ? [{ id: "run-embed", kind: "embed", name: "embed run", phase: "embed", done: 50, total: 100, pct: 50, rate: 2, etaSec: 25, doneAt: NOW + 25_000, lastProgressAt: NOW - 1000, stalled: false, series: [2, 2, 2], by: "cockpit" }] : [],
  passes: [{ name: "index", state: "ok", lastEnd: NOW - 3_600_000, nextAt: NOW + 3_600_000, failure: null, detail: null }],
  lastIndex: null, lastEmbed: null, schedule: { maintenanceHour: 3, indexIntervalSecs: 86400, embedIntervalSecs: 86400 },
  run: null, starting: null, lastRun: null,
});

/** Heights/tops of every card at 3 s (no job), the job appears from 3.5 s on the next poll, read again at 12 s. */
const PROBE = `<script>
function snap(){var o={};Array.prototype.forEach.call(document.querySelectorAll("#win-root .card"),function(c){
 if(c.style.display==="none")return;var r=c.getBoundingClientRect(),b=c.querySelector(".cbody");
 o[c.getAttribute("data-card")]={top:Math.round((r.top+window.scrollY)*100)/100,h:Math.round(r.height*100)/100,over:b?b.scrollHeight-b.clientHeight:0};
});return o}
var R={};
if(/frozen=1/.test(location.search))setTimeout(function(){var g=document.querySelector("#win-root .cgrip");if(g)g.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}));Win.relayout()},2500);
setTimeout(function(){R.A=snap();fetch("/test/jobs")},3000);
setTimeout(function(){R.B=snap();R.rm=Win.removeCards("memory",["memory.job:run-embed"])},8000);
setTimeout(function(){R.C=snap();document.body.setAttribute("data-r",JSON.stringify({err:window.__err||null,R:R}))},10000);
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
  const o = { width, height: 900, budgetMs: 12000 };
  const dom = await dumpDom(`${base}/page${q}`, o);
  const m = /data-r="([^"]*)"/.exec(dom);
  if (!m) throw new Error("no probe result in dump");
  return JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")) as { err: string | null; R: { A: Cards; B: Cards; C: Cards; rm: number } };
}

describe.skipIf(!CHROME)("structural add into a group", () => {
  for (const [width, q] of [[1400, ""], [700, ""], [1400, "?frozen=1"]] as const) {
    it(`a job card added to the memory group: siblings keep their heights, the group grows, cards below shift (${width}px ${q})`, async () => {
      const { err, R } = await open(width, q);
      expect(err).toBeNull();
      const sib = Object.keys(R.A).filter((id) => /^memory\./.test(id));
      expect(sib.length).toBeGreaterThanOrEqual(5);
      expect(R.B["memory.job:run-embed"]).toBeDefined();
      if (process.env.PAI_STABLE_TABLE) console.log(width, q, [...sib, "memory"].map((id) => `${id} h ${R.A[id]!.h}->${R.B[id]?.h}->${R.C[id]?.h} top ${R.A[id]!.top}->${R.B[id]?.top} over ${R.B[id]?.over}`).join("\n"));
      expect(sib.map((id) => `${id} ${R.B[id]!.h - R.A[id]!.h}`).filter((s) => !s.endsWith(" 0"))).toEqual([]);
      expect(sib.filter((id) => R.B[id]!.over > 0)).toEqual([]);
      expect(R.B["memory"]!.h).toBeGreaterThan(R.A["memory"]!.h);
      expect(R.B["memory"]!.top).toBe(R.A["memory"]!.top);
      const below = Object.keys(R.A).filter((id) => !/^memory/.test(id) && R.A[id]!.top > R.A["memory"]!.top);
      for (const id of below) expect(R.B[id]!.top - R.A[id]!.top).toBeCloseTo(R.B["memory"]!.h - R.A["memory"]!.h, 0);
      // removal: the job card is gone, the siblings are unchanged, the group is back at its height, the cards below too
      expect(R.rm).toBe(1);
      expect(R.C["memory.job:run-embed"]).toBeUndefined();
      expect(sib.map((id) => `${id} ${R.C[id]!.h - R.B[id]!.h}`).filter((s) => !s.endsWith(" 0"))).toEqual([]);
      expect(R.C["memory"]!.h).toBeLessThan(R.B["memory"]!.h);
      if (q) { // a laid-out (user) layout: back at the exact heights before the add
        expect(Math.abs(R.C["memory"]!.h - R.A["memory"]!.h)).toBeLessThanOrEqual(1);
        for (const id of below) expect(Math.abs(R.C[id]!.top - R.A[id]!.top)).toBeLessThanOrEqual(1);
      }
    }, 120_000);
  }
});
