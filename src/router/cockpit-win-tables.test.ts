/**
 * B11 `speed`, `pause`, `sessions`, `runs`: the real page with  shows four cards built from the page's own table builders;
 * the runs fold and the sessions "+N more" row are row-level disclosures, a value-only update moves no box. Headless Chromium, skipped when none is installed.
 * PAI_WIN_SHOTS=<dir> writes tables-<width>.png.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cockpitHtml } from "./cockpit-page.js";

const sp = (req: number) => ({ requests: req, ttftP50: 800, ttftP90: 2000, writeTps: 40, readTps: 900 });
const sess = (i: number) => ({ session: "sess" + i + "-abcdefgh", name: "name" + i, models: ["claude-opus", "gyro-m"], requests: 10 + i, input: 1000 * i, output: 500, cacheRead: 9000, cacheWrite: 100, errors: 0, busts: i % 2, hitRatio: 0.9, lastTs: Date.now() - i * 60_000, worker: null, verdict: null });
const wrk = (i: number, parent: string) => ({ ...sess(i), worker: "w" + i, workerParent: parent, workerStart: Date.now() - (i + 1) * 600_000, workerEnd: Date.now() - i * 600_000, workerProvider: "anthropic", verdict: i % 2 ? "ok" : "failed: x" });
const data = (k = 1) => ({
  window: "1h", totals: { requests: 5000 * k, input: 9e6, output: 4e5, cacheWrite: 1e6, cacheRead: 9e7, errors: 10, hitRatio: 0.9 },
  byModel: [], series: [], weights: { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 }, bustParts: {}, byProvider: [],
  cachePause: [{ model: "claude-opus", buckets: [{ label: "<1m", n: 10, hit: 9 }, { label: "5m+", n: 4, hit: 1 }] }, { model: "gyro-m", buckets: [{ label: "<1m", n: 0, hit: 0 }, { label: "5m+", n: 2, hit: 2 }] }],
  bySession: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(sess), workers: [wrk(1, "pa"), wrk(2, "pa"), wrk(3, "pb")].map((w) => ({ ...w, requests: 5 * k })),
  daily: { models: {}, days: [] }, sessionSplit: null, promptByProvider: {}, promptSince: {},
  speed: [{ provider: "anthropic", model: "claude-opus", local: false, h1: sp(30 * k), h24: sp(300) }, { provider: "strata", model: "gyro-m", local: true, h1: sp(5), h24: sp(50) }],
});

const PROBE = `<script>setTimeout(function(){try{
function q(id){return document.querySelector('#win-root [data-card="'+id+'"]')}
function box(id){var r=q(id).getBoundingClientRect();return[r.left,r.top,r.width,r.height].map(Math.round).join(",")}
function info(id){var c=q(id);return{rows:c.querySelectorAll("tbody tr").length,types:c.getAttribute("data-type"),bars:c.querySelectorAll(".sp-t").length,heads:c.querySelectorAll(".chead .ctitle").length,
 groups:c.querySelectorAll(".wr-group").length,wrows:c.querySelectorAll(".wr-row").length,folds:c.querySelectorAll("[data-wrfold]").length,more:c.querySelectorAll("[data-sessmore]").length,text:c.querySelector(".cbody").textContent.length}}
var ids=["speed","pause","sessions","runs"],o={err:window.__err||null,boxes:ids.map(box).join("|")};
ids.forEach(function(i){o[i]=info(i)});
q("runs").querySelector("[data-wrfold]").click();o.afterFold=info("runs");o.foldSaved=localStorage.getItem("pai.cockpit.wrfold");
q("sessions").querySelector("[data-sessmore]").click();o.afterMore=info("sessions");o.moreSaved=localStorage.getItem("pai.cockpit.sessmore");
window.Win.update("data",window.WINPAY);o.boxes2=ids.map(box).join("|");o.speed2=info("speed");
document.body.setAttribute("data-r",JSON.stringify(o));
}catch(e){document.body.setAttribute("data-r",JSON.stringify({err:String(e.stack)}))}},1500)</script>`;

let server: Server;
let base = "";
let tmp = "";
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "cockpit-win-tables-"));
  server = createServer((req, res) => {
    const url = req.url ?? "";
    res.setHeader("content-type", "application/json");
    if (url.startsWith("/cockpit/data")) return res.end(JSON.stringify(data()));
    if (url.startsWith("/cockpit/")) return res.end("{}");
    if (url.startsWith("/page")) {
      res.setHeader("content-type", "text/html");
      return res.end(cockpitHtml().replace("</head>", '<script>window.onerror=function(m,s,l,c){window.__err=String(m)+" @"+l+":"+c}</script></head>').replace("</body>", "<script>window.WINPAY=" + JSON.stringify(data(2)) + "</script>" + PROBE + "</body>"));
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
  if (!m) throw new Error("no probe result in dump: " + dom.slice(-600));
  return JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
}

describe.skipIf(!CHROME)("B11 speed, pause, sessions, runs on the win runtime", () => {
  it("renders the four cards from the page builders; folds are row-level; a value update moves no box", async () => {
    const shots = process.env.PAI_WIN_SHOTS;
    const r = await open("", 1400, shots ? join(shots, "tables-1400.png") : undefined);
    expect(r.err).toBeNull();
    expect(r.speed.bars).toBe(6); // 2 models x (ttft, write, read)
    expect(r.pause.rows).toBe(2);
    expect(r.sessions.rows).toBe(10 + 1); // top rows + the "+N more" row
    expect(r.sessions.more).toBe(1);
    expect(r.runs.groups).toBe(2);
    expect(r.runs.wrows).toBe(3);
    // the fold hides the first group's rows, saved under WR_FOLD_KEY
    expect(r.afterFold.wrows).toBeLessThan(3);
    expect(JSON.parse(r.foldSaved)).toBeTruthy();
    // "+N more" opens every session row
    expect(r.afterMore.rows).toBe(12 + 1);
    expect(r.moreSaved).toBe("1");
    // a value-only payload moves no box
    expect(r.boxes2).toBe(r.boxes);
  }, 120_000);
});

// ---- C1 restored guard: the sessions table fold ----
import { COCKPIT_HTML as PAGE } from "./cockpit-page.js";
import { WIN_TABLES_JS } from "./cockpit-page/win/cards-tables.js";
import { fnSrc, varSrc } from "./cockpit-page-src.js";
import { CHROME, dumpDom, killChromes, screenshot } from "./cdp-browser.js";

describe("C1 guards: sessions fold", () => {
  // w=6 sessions table: sessions past the top rows fold into one "+N more sessions (X tokens)" row that expands on click and stays expanded across a refresh; the models cell reads "first +N" with all models in its title.
  it("folds the rest into one expandable row, keeps it open across refreshes, and folds the models cell", () => {
    const store: Record<string, string> = {};
    const localStorage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } };
    const updates: string[] = [];
    const fns = ["esc", "fmt", "pct", "tot", "ago", "cls", "hitCls", "vcls", "table", "sessMore", "sessionsHtml"].map((n) => fnSrc(PAGE, n)).join("\n");
    const lib = new Function("localStorage", `var U=arguments[1],SESSION_ROWS=50,wrFolded=function(){return{}},WR_FOLD_KEY="k",WCHX={},Win={update:function(){U.push("data")}},data={},fitTables=function(){};\n${varSrc(PAGE, "SESS_MORE_KEY")}\n${varSrc(PAGE, "HIT_WARN")}\n${fns}\n${WIN_TABLES_JS}\nreturn{html:sessionsHtml,wire:wtWire};`);
    const api = lib(localStorage, updates) as { html: (d: unknown) => string; wire: (c: unknown) => void };
    const sess = (i: number) => ({ session: `s${String(i).padStart(7, "0")}x`, name: `n${i}`, models: i === 0 ? ["m-a", "m-b", "m-c"] : ["m-a"], requests: 1, input: 10, output: 5, cacheRead: 100, cacheWrite: 0, hitRatio: 0.9, busts: 0, errors: 0, lastTs: new Date().toISOString() });
    const d = { bySession: Array.from({ length: 12 }, (_, i) => sess(i)) };
    const rows = (h: string) => (h.match(/<tr>/g) ?? []).length - 1;

    const folded = api.html(d);
    expect(rows(folded)).toBe(11); // 10 sessions + the fold row
    expect(folded).toMatch(/\+2 more sessions \(\d+ tokens\)/);
    expect(folded).toContain('data-sessmore="1"');
    expect(folded).toMatch(/m-a <span class="dim">\+2<\/span>/); // first model + N
    expect(folded).toContain('title="m-a, m-b, m-c"');

    let onClick: ((e: unknown) => void) | undefined;
    api.wire({ body: { addEventListener: (_: string, f: (e: unknown) => void) => { onClick = f; }, contains: () => true } });
    const link = { hasAttribute: (a: string) => a === "data-sessmore", getAttribute: () => "1" };
    onClick!({ target: { closest: () => link }, preventDefault() {} });
    expect(store["pai.cockpit.sessmore"]).toBe("1");
    expect(updates).toEqual(["data"]); // the click re-feeds the data
    for (let refresh = 0; refresh < 2; refresh++) {
      const open = api.html(d);
      expect(rows(open)).toBe(13); // all 12 + "show fewer"
      expect(open).toContain("show fewer sessions");
    }
  });
});
