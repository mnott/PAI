/**
 * Box-stability (spec 9.2): the real page is rendered with fixture A, every .card rect and scrollY are snapshotted, then
 * fixture B (3x queue rows, long error strings, a model added to a dynamic list, values going null, window 1h -> Week) is pushed
 * without structural change. A card is fitted once (first data) and only grows when its content would overflow: so no card may
 * shrink or move up, a card may only grow (the cards below shift by the growth), and the page keeps the viewport still (anchor).
 * Second pass: a new runtime (structural) adds one card. Also run with ?anchor=off (rects only; scrollY is not compensated then).
 * PAI_STABLE_TABLE=1 prints the movement table.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cockpitHtml } from "./cockpit-page.js";

let phase = "A";
const LONG = "upstream connect error or disconnect/reset before headers. reset reason: connection termination while talking to a very long provider host name ".repeat(3);

const data = () => {
  const b = phase !== "A";
  return {
    window: b ? "week" : "1h",
    totals: { requests: b ? 90000 : 5000, input: 9e6, output: 4e5, cacheWrite: 1e6, cacheRead: 9e7, errors: b ? 40 : 0, hitRatio: b ? null : 0.9 },
    byModel: [{ model: "m-one", requests: b ? 99999 : 10, input: 1e6, output: 1e5, cacheWrite: 1e5, cacheRead: 1e6, errors: b ? 3 : 0, hitRatio: b ? null : 0.5 }],
    series: [], weights: { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 }, cachePause: [], byProvider: [],
    bustParts: {}, bySession: [], workers: [], daily: { models: {}, days: [] }, sessionSplit: null, speed: [], promptByProvider: {}, promptSince: {},
    errors: b ? [{ at: 1, model: "m-one", message: LONG }] : [],
  };
};
const waiting = (n: number, long: boolean) => Array.from({ length: n }, (_, i) => ({ id: `w-${i}`, label: (long ? LONG : "waiting job ") + i, waitedSec: 30 + i, position: i + 1, session: "PAI", model: "m1" }));
const queue = () => ({
  providers: [
    { provider: "local", cap: 1, conversationSlots: 2, running: [{ id: "w-run", label: "running job", ageSec: 120, now: "editing", session: "PAI", model: "m1" }], waiting: waiting(phase === "A" ? 2 : 6, phase !== "A") },
    { provider: "glm", cap: 3, running: [{ id: "w-g", label: "glm job", ageSec: 90, now: "", session: "Whazaa", model: "glm-5" }], waiting: [] },
  ],
  panes: [{ label: "pane one", cwd: "/work/x", ageSec: 50, log: "/tmp/l" }], paneViolations: [], plans: [{ job: "plan-1", merged: 1, total: 3, phase: "build", phaseSec: 10, ageSec: 99, running: ["a"] }],
  builds: { slots: 2, testSlots: 1, running: [{ kind: "test", id: "t1", label: "vitest", session: "PAI", ageSec: 5 }], waiting: [] },
  sessionMax: {}, localModel: phase === "A" ? LONG : "local model gyro-m up", worktrees: phase === "A" ? "3 worktrees" : LONG,
});
const users = (n: number) => Array.from({ length: n }, (_, i) => `worker:consumer-with-a-long-name-${i}`);
const mlist = (p: string, n: number, u = 1) => Array.from({ length: n }, (_, i) => ({ model: `${p}-model-${i}.gguf`, kind: "coding", loaded: i === 0, memoryMb: 4096, usedBy: users(u) }));
const models = () => ({
  at: 1, tiers: [{ tier: "gyro-m", maxInstances: 2 }, { tier: "iq3s", maxInstances: 1 }], consumers: [], runtimeCommands: {},
  instances: [{ id: "gyro-m-1", model: "gyro-m", state: "ready", port: 8101, pid: 11, inflight: 0 }],
  runtimes: [
    { name: "strata", kind: "strata", port: 8101, status: "running", tier: "gyro-m", users: ["worker:local"], models: mlist("g", phase === "A" ? 1 : 5, phase === "A" ? 1 : 9) },
    { name: "strata2", kind: "strata", port: 8102, status: "stopped", tier: "iq3s", users: [], models: mlist("i", phase === "A" ? 4 : 1, phase === "A" ? 9 : 1) },
  ].concat(phase === "C" ? [{ name: "strata3", kind: "strata", port: 8103, status: "running", tier: "gyro-m", users: [], models: [{ model: "new.gguf", kind: "chat", loaded: true, memoryMb: 100, usedBy: [] }] }] : []),
});
const limits = () => ({
  activeLocal: null,
  limits: [{ provider: "glm", kind: "cloud", windows: [{ name: "5h", percent: phase === "A" ? 30 : null, resetAt: phase === "A" ? Date.now() + 3600_000 : null }] }],
  routing: { flow: "", choices: [], rows: [], endpoints: [{ id: "ep1", origin: "registered", host: "h1", healthy: true, enabled: true, tags: [], classes: [] }] },
});

/** Snapshots at 3 s (A), 8 s (B served from 3.5 s, polled every 5 s, Week tab at 5.5 s), 13 s (C served from 8.5 s): every visible card rect + scrollY. */
const PROBE = `<script>
function snap(){var o={};Array.prototype.forEach.call(document.querySelectorAll("#win-root .card"),function(c){
 if(c.style.display==="none")return;var r=c.getBoundingClientRect();o[c.getAttribute("data-card")]={top:Math.round((r.top+window.scrollY)*100)/100,h:Math.round(r.height*100)/100,len:c.textContent.length,sh:c.querySelector(".cbody")?c.querySelector(".cbody").scrollHeight:0,ch:c.querySelector(".cbody")?c.querySelector(".cbody").clientHeight:0};
});return{y:window.scrollY,cards:o}}
var R={};
function phaseTo(p){fetch("/test/phase?p="+p)}
function tab(w){var b=document.querySelector('#tabs button[data-w="'+w+'"]');if(b)b.click()}
setTimeout(function(){window.scrollTo(0,1400);window.dispatchEvent(new Event("scroll"));R.A=snap();R.a0=window.scrollY},3000);
setTimeout(function(){phaseTo("B")},3500);
function hh(id){return document.querySelector('#win-root [data-card="'+id+'"]').getBoundingClientRect().height}
function ty(id){return document.querySelector('#win-root [data-card="'+id+'"]').getBoundingClientRect().top+window.scrollY}
var SW={},GR={};
// grow=1: scroll a lower card to the viewport top, then overflow the upper card kpis.requests: the lower card must not move on screen
function cardEl(id){return document.querySelector('#win-root [data-card="'+id+'"]')}
setTimeout(function(){if(!/grow=1/.test(location.search))return;GR.id="memory";GR.up="kpis.requests";
 window.scrollTo(0,ty(GR.id)-5);window.dispatchEvent(new Event("scroll"))},3600);
setTimeout(function(){if(!GR.id)return;GR.upTop=ty(GR.up);GR.upH0=hh(GR.up);GR.y0=window.scrollY;GR.t0=cardEl(GR.id).getBoundingClientRect().top;
 GR.box=document.createElement("div");GR.box.style.height="300px";cardEl(GR.up).querySelector(".cbody").appendChild(GR.box)},3800);
setTimeout(function(){if(!GR.id)return;GR.t1=cardEl(GR.id).getBoundingClientRect().top;GR.y1=window.scrollY;GR.upH1=hh(GR.up);
 delete GR.box;R.GR=GR},4600);
setTimeout(function(){if(!/swing=1/.test(location.search))return;SW.id="kpis.requests";SW.h0=hh(SW.id);SW.t0=ty("kpis.requests");var y0=window.scrollY;
 SW.box=document.createElement("div");SW.box.style.height="200px";document.querySelector('#win-root [data-card="'+SW.id+'"] .cbody').appendChild(SW.box);SW.y0=y0},3200);
setTimeout(function(){if(!SW.id)return;SW.h1=hh(SW.id);SW.y1=window.scrollY;SW.box.remove()},3300);
setTimeout(function(){if(!SW.id)return;SW.h2=hh(SW.id);SW.t2=ty(SW.id);delete SW.box;R.SW=SW},3400);
setTimeout(function(){tab("week")},5500);
setTimeout(function(){R.B=snap()},8000);
setTimeout(function(){phaseTo("C")},8500);
setTimeout(function(){R.C=snap();document.body.setAttribute("data-r",JSON.stringify({err:window.__err||null,R:R}))},13000);
</script>`;

type Snap = { y: number; cards: Record<string, { top: number; h: number; len: number; sh: number; ch: number }> };
let server: Server;
let base = "";
let tmp = "";
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "cockpit-win-stable-"));
  server = createServer((req, res) => {
    const url = req.url ?? "";
    res.setHeader("content-type", "application/json");
    if (url.startsWith("/test/phase")) { phase = new URL(url, "http://x").searchParams.get("p") ?? "A"; return res.end("{}"); }
    if (url.startsWith("/cockpit/data")) return res.end(JSON.stringify(data()));
    if (url.startsWith("/cockpit/queue")) return res.end(JSON.stringify(queue()));
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

async function open(query: string) {
  phase = "A";
  const o = { width: 1300, height: 900, budgetMs: 15000 };
  const dom = await dumpDom(`${base}/page${query}`, o);
  const m = /data-r="([^"]*)"/.exec(dom);
  if (!m) throw new Error("no probe result in dump");
  return JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")) as { err: string | null; R: { A: Snap; B: Snap; C: Snap; a0: number; SW: Record<string, number | string> } };
}

/** Per card movement from one snapshot to the next. */
function moves(a: Snap, b: Snap) {
  return Object.keys(a.cards).filter((id) => b.cards[id]).map((id) => ({ id, h0: a.cards[id]!.h, h1: b.cards[id]!.h, t0: a.cards[id]!.top, t1: b.cards[id]!.top }));
}
function table(title: string, a: Snap, b: Snap) {
  if (!process.env.PAI_STABLE_TABLE) return;
  const gone = Object.keys(a.cards).filter((id) => !b.cards[id]).map((id) => `gone ${id}`);
  const edited = Object.keys(a.cards).filter((id) => b.cards[id] && b.cards[id]!.len !== a.cards[id]!.len).map((id) => `${id} text ${a.cards[id]!.len}->${b.cards[id]!.len} scroll ${b.cards[id]!.sh}/${b.cards[id]!.ch}`);
  console.log(`${title}: content changed in ${edited.length} cards\n${edited.join("\n")}\n${gone.join("\n")}`);
  const rows = moves(a, b).filter((m) => m.h0 !== m.h1 || m.t0 !== m.t1).map((m) => `${m.id}\th ${m.h0}->${m.h1}\ttop ${m.t0}->${m.t1}`);
  console.log(`${title}: scrollY ${a.y}->${b.y}, ${rows.length} moved\n${rows.join("\n")}`);
}

describe.skipIf(!CHROME)("box stability", () => {
  it("a card does not shrink when its content does, and grows (no inner scroll) when its content overflows", async () => {
    const r = await open("?swing=1");
    expect(r.err).toBeNull();
    const w = r.R.SW as Record<string, number>;
    expect(w.h1!).toBeGreaterThan(w.h0!); // overflow: the card grew
    expect(w.h2!).toBe(w.h0!); // content gone again: the card follows its content back
  }, 120_000);

  for (const q of ["", "?anchor=off"]) {
    it(`a card above the viewport grows by overflow: the card at the viewport top stays put on screen (${q})`, async () => {
      const r = await open("?grow=1" + q.replace("?", "&"));
      expect(r.err).toBeNull();
      const g = (r.R as any).GR as Record<string, number | string>;
      if (process.env.PAI_STABLE_TABLE) console.log("grow", q, JSON.stringify(g));
      expect(g.upTop as number, "grown card is above the viewport").toBeLessThan(g.y0 as number);
      expect(g.upH1 as number, "the upper card grew").toBeGreaterThan((g.upH0 as number) + 100);
      const moved = (g.t1 as number) - (g.t0 as number);
      // anchor on: the keeper scrolls the growth away; off: the card is pushed down by what the upper card grew
      if (q === "") expect(Math.abs(moved)).toBeLessThanOrEqual(1);
      else expect(moved).toBeGreaterThan(100);
    }, 120_000);

    it(`data-only change B: no card shrinks or moves up, only overflow grows (${q})`, async () => {
      const r = await open(q);
      expect(r.err).toBeNull();
      const { A, B } = r.R;
      if (process.env.PAI_STABLE_TABLE) console.log("auto", (r.R as any).auto);
      expect(Object.keys(A.cards).length).toBeGreaterThan(15);
      expect(A.y).toBeGreaterThan(500); // the page scrolled, so the keeper has something to keep
      table(`B ${q}`, A, B);
      const ms = moves(A, B);
      // cards that come or go are the dynamic ones: a model appearing in a runtime's list gets its own card
      const gone = Object.keys(A.cards).filter((id) => !B.cards[id]);
      const born = Object.keys(B.cards).filter((id) => !A.cards[id]);
      expect([...gone, ...born].filter((id) => !/^(cache\.|models\.rt:)/.test(id))).toEqual([]);
      // a card above the first grown / new / removed card is exactly where it was
      const grew = ms.filter((m) => Math.abs(m.h1 - m.h0) > 0.5); // a card follows its content up and down
      const firstChangeTop = Math.min(...grew.map((m) => m.t0), ...gone.map((id) => A.cards[id]!.top), ...born.map((id) => B.cards[id]!.top));
      expect(ms.filter((m) => m.t0 < firstChangeTop && (m.t1 !== m.t0 || m.h1 !== m.h0)).map((m) => m.id)).toEqual([]);
      if (q === "") {
        // the viewport stays still: the topmost card at or below the viewport top keeps its offset
        const vis = ms.filter((m) => m.t0 >= A.y).sort((x, y) => x.t0 - y.t0)[0]!;
        expect(Math.abs(vis.t1 - B.y - (vis.t0 - A.y))).toBeLessThanOrEqual(1);
      }
    }, 120_000);

    it(`structural change C (new runtime): existing cards keep their heights, the viewport stays (${q})`, async () => {
      const r = await open(q);
      expect(r.err).toBeNull();
      const { B, C } = r.R;
      table(`C ${q}`, B, C);
      const added = Object.keys(C.cards).filter((id) => !B.cards[id]);
      expect(added.length).toBeGreaterThanOrEqual(1);
      for (const id of added) expect(id).toMatch(/models/);
      const ms = moves(B, C);
      expect(ms.filter((m) => m.h1 < m.h0 - 0.5).map((m) => `${m.id} ${m.h0}->${m.h1}`)).toEqual([]);
      // a card added to a group changes only the group (it grows) and the cards below it: every other existing card keeps its height exactly
      const groups = (id: string) => added.some((a) => a.startsWith(id + ".") || a.startsWith(id + ":"));
      expect(ms.filter((m) => !groups(m.id) && Math.abs(m.h1 - m.h0) > 0.5).map((m) => `${m.id} ${m.h0}->${m.h1}`)).toEqual([]);
      if (q === "") {
        const vis = ms.filter((m) => m.t0 >= B.y).sort((x, y) => x.t0 - y.t0)[0]!;
        expect(Math.abs(vis.t1 - C.y - (vis.t0 - B.y))).toBeLessThanOrEqual(1);
      }
    }, 120_000);
  }
});

// ---- C1 restored guard: hold-last-good feeds ----
import { fnSrc, varSrc } from "./cockpit-page-src.js";
import { COCKPIT_HTML as PAGE } from "./cockpit-page.js";
import { CHROME, dumpDom, killChromes } from "./cdp-browser.js";

describe("C1 guards: hold-last-good", () => {
  // w=1 hold-last-good: a failed fetch keeps the last card values; past HOLD_SEC the card shows the error; a good payload clears it.
  it("a failed poll keeps the last good values, shows the error only after HOLD_SEC, and a good payload clears it", async () => {
    const hold = Number(/HOLD_SEC=(\d+)/.exec(varSrc(PAGE, "HOLD_SEC"))![1]);
    const src = ["feedHeld", "feedState", "feedTick", "feed"].map((n) => fnSrc(PAGE, n)).join("\n");
    let now = 1_000_000, reply: () => Promise<{ ok: boolean; status?: number; json: () => Promise<unknown> }>;
    const applied: unknown[] = [], errs: string[] = [];
    const api = new Function("Date", "fetch", `var lastOk=0,HOLD_SEC=${hold},FEEDS={};\n${src}\nreturn{feed:feed,feedTick:feedTick};`)({ now: () => now }, () => reply()) as { feed: Function; feedTick: () => void };
    const ok = (j: unknown) => () => Promise.resolve({ ok: true, json: () => Promise.resolve(j) });
    const poll = async () => { await api.feed("k", "/x", [], (j: unknown) => applied.push(j), (e: string) => errs.push(e)); };

    reply = ok({ v: 1 });
    await poll();
    expect(applied).toEqual([{ v: 1 }]);

    reply = () => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) });
    now += (hold - 1) * 1000;
    await poll(); api.feedTick();
    expect(applied).toEqual([{ v: 1 }]); // the card keeps its last values, no error yet
    expect(errs).toEqual([]);

    now += 2000; // past the hold
    api.feedTick();
    expect(errs).toEqual(["HTTP 503"]);
    api.feedTick();
    expect(errs.length).toBe(1); // shown once

    reply = ok({ v: 2 });
    await poll();
    expect(applied.at(-1)).toEqual({ v: 2 });
    reply = () => Promise.reject(new Error("net down"));
    await poll();
    now += (hold + 1) * 1000;
    api.feedTick();
    expect(errs).toEqual(["HTTP 503", "net down"]); // the good payload cleared the shown error: the next failure holds again, then shows
  });
});
