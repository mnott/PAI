/**
 * B10 `cache`: the real page with ?win=1 shows the cache group (a ring card per model, chips cards, the local prefix cache
 * list, the providers table) in main#win-root; a single model gives the one big-donut card; without the flag the old page is
 * unchanged. Headless Chromium, skipped when none is installed. PAI_WIN_SHOTS=<dir> writes cache-<width>.png.
 */

import { execFile, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cockpitHtml } from "./cockpit-page.js";

const CHROME = process.env.CHROME_BIN ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));

const model = (provider: string, m: string, requests: number, cacheRead: number, cacheWrite: number, input: number) =>
  ({ provider, model: m, requests, cacheRead, cacheWrite, input, output: 1000, errors: 0 });
let solo = false;
const data = () => ({
  window: "1h", totals: { requests: 5000, input: 9e6, output: 4e5, cacheWrite: 1e6, cacheRead: 9e7, errors: 0, hitRatio: 0.9 },
  byModel: solo
    ? [model("anthropic", "claude-opus", 4000, 9e7, 1e6, 9e6)]
    : [model("anthropic", "claude-opus", 4000, 9e7, 1e6, 9e6), model("glm", "glm-5", 900, 4e6, 1e5, 1e6), model("local", "gyro-m", 80, 0, 0, 5e5), model("tiny", "t-1", 2, 10, 10, 10)],
  series: [], weights: { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 }, cachePause: [], bustParts: { ttl: 2 }, bySession: [], workers: [],
  daily: { models: {}, days: [] }, speed: [], promptByProvider: { local: 600000 }, promptSince: {},
  byProvider: [{ provider: "anthropic", requests: 4000, errors: 0, retries: 0, avgMs: 900, ttftP50: 300, input: 9e6, output: 4e5, cacheRead: 9e7, cacheWrite: 1e6, hitRatio: 0.9 },
    { provider: "local", requests: 80, errors: 0, retries: 0, avgMs: 2000, ttftP50: 800, input: 5e5, output: 1e4, cacheRead: 0, cacheWrite: 0, hitRatio: 0 }],
  sessionSplit: { continuous: { hitRatio: 0.92, sessions: 3, requests: 4000 }, oneShot: { hitRatio: 0.4, sessions: 9, requests: 100 } }, pool: { tasks: 4, tokensCarried: 123456 },
});
const sys = () => ({ servers: [{ provider: "local", up: true, prefixCache: { hits: 70, misses: 10, hitRate: 0.875, tokensSaved: 400000, entries: 5, memoryMb: 300 }, prefixCacheAgeSec: 3 }] });

const PROBE = `<script>setTimeout(function(){
function vis(){return Array.prototype.filter.call(document.querySelectorAll("#win-root .card"),function(c){return c.style.display!=="none"}).map(function(c){return c.getAttribute("data-card")})}
function txt(id){var c=document.querySelector('#win-root [data-card="'+id+'"]');return c?c.textContent.replace(/\\s+/g," "):null}
function rc(id){var c=document.querySelector('#win-root [data-card="'+id+'"]');if(!c)return null;var r=c.getBoundingClientRect();return[r.left,r.top,r.right,r.bottom]}
var o={err:window.__err||null,vis:vis(),rects:["cache.ring:anthropic/claude-opus","cache.ring:glm/glm-5","cache.ring:local/gyro-m","cache.low","cache.note","cache.local","cache.providers"].map(rc),rings:document.querySelectorAll('#win-root [data-card^="cache.ring:"] svg').length,
 solo:txt("cache.solo"),soloSvg:(document.querySelector('#win-root [data-card="cache.solo"] svg')||{getAttribute:function(){return null}}).getAttribute("width"),
 glm:txt("cache.ring:glm/glm-5"),local:txt("cache.ring:local/gyro-m"),low:txt("cache.low"),note:txt("cache.note"),prefix:txt("cache.local"),prov:txt("cache.providers"),
 none:txt("cache.none"),oldCa:getComputedStyle(document.querySelector('[data-section="cache"]')).display};
document.body.setAttribute("data-r",JSON.stringify(o));
},2500)</script>`;

let server: Server;
let base = "";
let tmp = "";
const browsers = new Set<ChildProcess>();
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "cockpit-win-cache-"));
  server = createServer((req, res) => {
    const url = req.url ?? "";
    res.setHeader("content-type", "application/json");
    if (url.startsWith("/cockpit/data")) return res.end(JSON.stringify(data()));
    if (url.startsWith("/cockpit/system")) return res.end(JSON.stringify(sys()));
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
  const args = ["--headless=new", "--disable-gpu", "--use-mock-keychain", "--password-store=basic", "--no-first-run", "--hide-scrollbars", `--user-data-dir=${join(tmp, "p" + Math.random().toString(36).slice(2))}`, `--window-size=${width},1500`, "--virtual-time-budget=8000"];
  const url = `${base}/page${query}`;
  const dom = await run([...args, "--dump-dom", url]);
  if (shot) await run([...args, `--screenshot=${shot}`, url]);
  const m = /data-r="([^"]*)"/.exec(dom);
  if (!m) throw new Error("no probe result in dump");
  return JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
}

describe.skipIf(!CHROME)("B10 cache on the win runtime (?win=1)", () => {
  it("a ring card per model with enough requests, chips, local prefix cache list and providers table", async () => {
    solo = false;
    const shots = process.env.PAI_WIN_SHOTS;
    const o = await open("?win=1", 1400, shots ? join(shots, "cache-1400.png") : undefined);
    expect(o.err).toBeNull();
    expect(o.vis).toEqual(expect.arrayContaining(["cache", "cache-rings", "cache.ring:anthropic/claude-opus", "cache.ring:glm/glm-5", "cache.ring:local/gyro-m", "cache.low", "cache.note", "cache.local", "cache.providers"]));
    expect(o.vis).not.toContain("cache.none");
    expect(o.vis).not.toContain("cache.solo");
    expect(o.rings).toBe(3);
    expect(o.glm).toContain("glm-5");
    expect(o.local).toContain("server prefix cache");
    expect(o.low).toContain("+1 model");
    expect(o.note).toContain("overall");
    expect(o.note).toContain("one-shot");
    expect(o.note).toContain("pool");
    expect(o.prefix).toContain("70 hit / 10 miss");
    expect(o.prov).toContain("anthropic");
    expect(o.prov).toContain("Busts: ttl x2");
    expect(o.oldCa).toBe("none");
    const rs = o.rects as number[][];
    for (const r of rs) { expect(r).not.toBeNull(); expect(r[2]! - r[0]!).toBeGreaterThan(100); expect(r[3]! - r[1]!).toBeGreaterThan(40); }
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i]!, b = rs[j]!;
      expect(a[0]! < b[2]! - 1 && b[0]! < a[2]! - 1 && a[1]! < b[3]! - 1 && b[1]! < a[3]! - 1, `cards ${i} and ${j} overlap`).toBe(false);
    }
  }, 120_000);

  it("one model with cache fields gives the single big-donut card", async () => {
    solo = true;
    const o = await open("?win=1", 1400);
    expect(o.err).toBeNull();
    expect(o.vis).toContain("cache.solo");
    expect(o.vis).not.toContain("cache.none");
    expect(o.rings).toBe(0);
    expect(o.solo).toContain("overall hit ratio");
    expect(o.soloSvg).toBe("170");
  }, 120_000);

  it("without the flag the old cache section is unchanged", async () => {
    solo = false;
    const o = await open("", 1400);
    expect(o.err).toBeNull();
    expect(o.oldCa).not.toBe("none");
    expect(o.vis).toEqual([]);
  }, 120_000);
});
