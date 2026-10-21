/**
 * B4 regressions: under ?win=1 every group of the win root is at least as tall as its cards need
 * (no collapsed or overlapping cards), and a feed's status text appears only on its own sections.
 * Headless Chromium on the real page with live-shaped feeds, skipped when none is installed.
 * PAI_WIN_SHOTS=<dir> writes fit-win.png and fit-noflag.png.
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
const pool = () => ({
  enabled: true, hostUp: true, port: 4711, maxSlots: 3, idleKillSecs: 600, hostSince: "2026-10-21 08:00", hostBuiltAt: null, hostStale: false,
  hostLastSeen: "2026-10-20 12:00", slots: [{ provider: "claude", model: "opus", cwd: "/a/b/c", state: "busy", ageSecs: 100, idleSecs: 5, tasks: 2, tokensCarried: 5000, hitRatio: 0.8, task: "t1", branch: null, firstRequest: "warm" }],
  spares: [{ provider: "claude", ready: 1, starting: 0 }], spareClaims: 2, spareMisses: [], totals: { tasksServed: 7, tokensCarried: 12000, hitRatio: 0.5, carriedTasks: 3 },
  last24h: { runs: 10, pooled: 6, notPooled: 4, reasons: [], topReason: null, unattributed: 4, poolOff: 0 }, offReason: null, message: "m",
});
/** Limits with a stale glm reading: the limits feed is healthy, the pool feed is not. */
const limits = () => ({ activeLocal: null, limits: [{ provider: "glm", kind: "cloud", windows: [{ name: "5h", percent: 30, resetAt: Date.now() + 3600_000 }], error: "usage reading 0 min old" }] });
let poolFails = false;

const PROBE = `<script>setTimeout(function(){
var cards={};Array.prototype.forEach.call(document.querySelectorAll("#win-root .card"),function(c){if(c.style.display==="none")return;var r=c.getBoundingClientRect();cards[c.getAttribute("data-card")]={x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)}});
var marks={};Array.prototype.forEach.call(document.querySelectorAll("[data-stale]"),function(m){var s=m.closest("section");var k=m.getAttribute("data-stale")+"@"+(s?s.getAttribute("data-section"):"?");marks[k]=m.textContent});
document.body.setAttribute("data-r",JSON.stringify({err:window.__err||null,cards:cards,marks:marks,feeds:Object.keys(window.FEEDS||{}).map(function(k){return k+":"+(FEEDS[k].err||"ok")})}));
},1800)</script>`;

let server: Server;
let base = "";
let tmp = "";
const browsers = new Set<ChildProcess>();
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "cockpit-win-fit-"));
  server = createServer((req, res) => {
    const url = req.url ?? "";
    res.setHeader("content-type", "application/json");
    if (url.startsWith("/cockpit/data")) return res.end(JSON.stringify(data()));
    if (url.startsWith("/cockpit/pool")) { if (poolFails) { res.statusCode = 500; return res.end("{}"); } return res.end(JSON.stringify(pool())); }
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
afterAll(() => { for (const c of browsers) c.kill("SIGKILL"); server?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = execFile(CHROME!, args, { encoding: "utf8", timeout: 60_000, maxBuffer: 64 << 20 }, (err, stdout) => { browsers.delete(c); err ? reject(err) : resolve(stdout); });
    browsers.add(c);
  });
}
type Rect = { x: number; y: number; w: number; h: number };
async function open(query: string, width: number, shot?: string) {
  const args = ["--headless=new", "--disable-gpu", "--use-mock-keychain", "--password-store=basic", "--no-first-run", "--hide-scrollbars", `--user-data-dir=${join(tmp, "p" + Math.random().toString(36).slice(2))}`, `--window-size=${width},1400`, "--virtual-time-budget=6000"];
  const url = `${base}/page${query}`;
  const dom = await run([...args, "--dump-dom", url]);
  if (shot) await run([...args, `--screenshot=${shot}`, url]);
  const m = /data-r="([^"]*)"/.exec(dom);
  if (!m) throw new Error("no probe result in dump");
  return JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")) as { err: string | null; cards: Record<string, Rect>; marks: Record<string, string>; feeds: string[] };
}
const MIN_H = 60;

describe.skipIf(!CHROME)("win root bands fit their cards (?win=1)", () => {
  for (const width of [1400, 900]) {
    it(`${width} px: every kv/metric card is readable, cards of a group do not overlap`, async () => {
      poolFails = false;
      const shots = process.env.PAI_WIN_SHOTS;
      const r = await open("?win=1", width, shots && width === 1400 ? join(shots, "fit-win.png") : undefined);
      expect(r.err).toBeNull();
      if (process.env.FIT_DBG) console.log(JSON.stringify(r.cards));
      const ids = Object.keys(r.cards).filter((k) => /^(kpis|pool)\./.test(k) && k !== "pool.off");
      expect(ids.length).toBeGreaterThanOrEqual(13);
      for (const id of ids) expect(r.cards[id]!.h, id).toBeGreaterThanOrEqual(id === "pool.slots" ? 80 : MIN_H);
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
        const a = r.cards[ids[i]!]!, b = r.cards[ids[j]!]!;
        const overlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 1;
        expect(overlap, `${ids[i]} / ${ids[j]}`).toBe(false);
      }
      // the pool group ends below its last card, the next section starts below the group
      const poolBottom = Math.max(...ids.filter((k) => k.startsWith("pool.")).map((k) => r.cards[k]!.y + r.cards[k]!.h));
      expect(r.cards.pool!.y + r.cards.pool!.h).toBeGreaterThanOrEqual(poolBottom);
    }, 120_000);
  }
});

describe.skipIf(!CHROME)("a feed's status text is on its own sections only", () => {
  it("a failing pool feed marks the pool section, not limits, routing or models", async () => {
    poolFails = true;
    const shots = process.env.PAI_WIN_SHOTS;
    const r = await open("", 1400, shots ? join(shots, "fit-noflag.png") : undefined);
    expect(r.err).toBeNull();
    const sections = Object.keys(r.marks).map((k) => k.split("@")[1]);
    expect(r.marks["pool@pool"]).toBeDefined();
    for (const s of ["cloud", "routing", "models"]) expect(sections, s).not.toContain(s);
  }, 120_000);

  it("healthy feeds show no status text at all", async () => {
    poolFails = false;
    const r = await open("", 1400);
    expect(r.marks).toEqual({});
    expect(r.feeds.filter((f) => !f.endsWith(":ok"))).toEqual([]);
  }, 120_000);
});
