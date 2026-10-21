/**
 * B4 `pool`: the real page with ?win=1 shows the totals as a group of six metric cards in main#win-root;
 * without the flag the old page is unchanged. Headless Chromium, skipped when none is installed.
 * PAI_WIN_SHOTS=<dir> writes pool-<width>-<theme>.png.
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
let poolOn = true;
const pool = () => ({
  enabled: poolOn, hostUp: poolOn, port: 4711, maxSlots: 3, idleKillSecs: 600, hostSince: "2026-10-21 08:00", hostBuiltAt: null, hostStale: false,
  hostLastSeen: "2026-10-20 12:00", slots: poolOn ? [{ provider: "claude", model: "opus", cwd: "/a/b/c", state: "busy", ageSecs: 100, idleSecs: 5, tasks: 2, tokensCarried: 5000, hitRatio: 0.8, task: "t1", branch: null, firstRequest: "warm" }] : [],
  spares: [{ provider: "claude", ready: 1, starting: 0 }], spareClaims: 2, spareMisses: [], totals: { tasksServed: 7, tokensCarried: 12000, hitRatio: 0.5, carriedTasks: 3 },
  last24h: { runs: 10, pooled: 6, notPooled: 4, reasons: [], topReason: null, unattributed: 4, poolOff: 0 }, offReason: poolOn ? null : "config disabled", message: "m",
});

/** Reads which cards are shown and their texts. */
const PROBE = `<script>setTimeout(function(){
function vis(){return Array.prototype.filter.call(document.querySelectorAll("#win-root .card"),function(c){return c.style.display!=="none"}).map(function(c){return c.getAttribute("data-card")})}
function txt(id){var c=document.querySelector('#win-root [data-card="'+id+'"]');return c?c.textContent.replace(/\\s+/g," "):null}
var o={err:window.__err||null,vis:vis(),host:txt("pool.host"),tasks:txt("pool.tasks"),slots:txt("pool.slots"),off:txt("pool.off"),oldPool:getComputedStyle(document.querySelector('[data-section="pool"]')).display,
 heads:Array.prototype.map.call(document.querySelectorAll("#win-root .chead"),function(h){return Array.prototype.map.call(h.children,function(k){return k.className.split(" ")[0]}).join(",")})};
document.body.setAttribute("data-r",JSON.stringify(o));
},1500)</script>`;

let server: Server;
let base = "";
let tmp = "";
const browsers = new Set<ChildProcess>();
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "cockpit-win-pool-"));
  server = createServer((req, res) => {
    const url = req.url ?? "";
    res.setHeader("content-type", "application/json");
    if (url.startsWith("/cockpit/data")) return res.end(JSON.stringify(data()));
    if (url.startsWith("/cockpit/pool")) return res.end(JSON.stringify(pool()));
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

describe.skipIf(!CHROME)("B4 pool on the win runtime (?win=1)", () => {
  it("on: six kv cards over the slots table, no note; the old section is hidden", async () => {
    poolOn = true;
    const shots = process.env.PAI_WIN_SHOTS;
    const r = await open("?win=1", 1400, shots ? join(shots, "pool-1400-light.png") : undefined);
    expect(r.err).toBeNull();
    expect(r.vis).toEqual(expect.arrayContaining(["pool", "pool.pool", "pool.host", "pool.tasks", "pool.hit", "pool.spares", "pool.not-pooled", "pool.slots"]));
    expect(r.vis).not.toContain("pool.off");
    expect(r.host).toContain("up");
    expect(r.tasks).toContain("7");
    expect(r.slots).toContain("opus");
    expect(r.oldPool).toBe("none");
    for (const h of r.heads) expect(h).toMatch(/^cgrip,ctitle,cstatus(,cbtn)*$/);
  }, 120_000);

  it("off with the host down: one note card, no kv cards", async () => {
    poolOn = false;
    const r = await open("?win=1", 1400);
    expect(r.err).toBeNull();
    expect(r.vis).toContain("pool.off");
    expect(r.vis).not.toContain("pool.host");
    expect(r.vis).not.toContain("pool.slots");
    expect(r.off).toContain("Pool off");
    expect(r.off).toContain("config disabled");
  }, 120_000);

  it("without the flag the old pool section is unchanged", async () => {
    poolOn = true;
    const r = await open("", 1400);
    expect(r.err).toBeNull();
    expect(r.oldPool).not.toBe("none");
    expect(r.vis).toEqual([]);
  }, 120_000);
});
