/**
 * Warm-up order: the cockpit's group order and card set do not depend on when or whether feeds answer.
 * Headless Chromium on the real page; the mock server delays or fails single feeds. Skipped without Chromium.
 */

import { execFile, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cockpitHtml } from "./cockpit-page.js";

const CHROME = process.env.CHROME_BIN ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));

const DEFAULT_ORDER = ["kpis", "pool", "system", "memory", "routing", "limits-local", "limits-cloud", "workers", "models", "cache"];
const GROUPS = ["system", "memory", "workers", "models", "cache"];

const data = () => ({
  window: "1h", totals: { requests: 5000, input: 9e6, output: 4e5, cacheWrite: 1e6, cacheRead: 9e7, errors: 0, hitRatio: 0.9 },
  byModel: [], series: [], weights: { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 }, cachePause: [], byProvider: [],
  bustParts: {}, bySession: [], workers: [], daily: { models: {}, days: [] }, sessionSplit: null, speed: [], promptByProvider: {}, promptSince: {},
});
const limits = () => ({ activeLocal: null, limits: [{ provider: "glm", kind: "cloud", windows: [{ name: "5h", percent: 30, resetAt: Date.now() + 3600_000 }] }] });

/** path prefix -> { delay ms, fail }; anything else answers {} at once. */
let plan: Record<string, { delay?: number; fail?: boolean }> = {};
let server: Server;
let base = "";
let tmp = "";
const browsers = new Set<ChildProcess>();
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "cockpit-win-warmup-"));
  server = createServer((req, res) => {
    const url = req.url ?? "";
    if (url.startsWith("/page")) {
      res.setHeader("content-type", "text/html");
      const probe = `<script>setTimeout(function(){var S=Win.state(),ids=function(n){return n.k==="c"?[n.id]:[].concat.apply([],n.ch.map(ids))};
var root=S.tree.ch?S.tree.ch.map(function(n){return n.k==="c"?n.id:"?"}):[S.tree.id];
var dom=Array.prototype.map.call(document.querySelectorAll("#win-root > .card"),function(c){return c.getAttribute("data-card")});
var cnt={};for(var g in S.kids)cnt[g]=ids(S.kids[g]).filter(function(i){var e=Win.el(i);return e&&e.style.display!=="none"&&e.getBoundingClientRect().height>0}).length;
var before=localStorage.getItem("pai.cockpit.win.v2");
var t=JSON.parse(JSON.stringify(S.tree));t.ch=t.ch.slice(0,3);t.sz=t.sz.slice(0,3);
Win.apply("",t);Win.flush();
var after=localStorage.getItem("pai.cockpit.win.v2");
document.body.setAttribute("data-r",JSON.stringify({err:window.__err||null,root:root,dom:dom,cnt:cnt,saved:before,guard:before===after}));},${"__AT__"})</script>`;
      const m = /[?&]at=(\d+)/.exec(url);
      const seed = /[?&]seed=([^&]*)/.exec(url);
      const pre = seed ? `<script>localStorage.setItem("pai.cockpit.win.v2",decodeURIComponent("${seed[1]}"))</script>` : "";
      return res.end(cockpitHtml().replace("</head>", '<script>window.onerror=function(m,s,l,c){window.__err=String(m)+" @"+l+":"+c}</script>' + pre + "</head>").replace("</body>", probe.replace("__AT__", m?.[1] ?? "1800") + "</body>"));
    }
    const key = Object.keys(plan).find((k) => url.startsWith(k));
    const p = key ? plan[key]! : {};
    const send = () => {
      res.setHeader("content-type", "application/json");
      if (p.fail) { res.statusCode = 500; return res.end("{}"); }
      if (url.startsWith("/cockpit/data")) return res.end(JSON.stringify(data()));
      if (url.startsWith("/cockpit/limits")) return res.end(JSON.stringify(limits()));
      res.end("{}");
    };
    if (p.delay) setTimeout(send, p.delay); else send();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => { for (const c of browsers) c.kill("SIGKILL"); server?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = execFile(CHROME!, args, { encoding: "utf8", timeout: 90_000, maxBuffer: 64 << 20 }, (err, stdout) => { browsers.delete(c); err ? reject(err) : resolve(stdout); });
    browsers.add(c);
  });
}
type Probe = { err: string | null; root: string[]; dom: string[]; cnt: Record<string, number>; saved: string | null; guard: boolean };
async function open(query = ""): Promise<Probe> {
  const args = ["--headless=new", "--disable-gpu", "--use-mock-keychain", "--password-store=basic", "--no-first-run", "--hide-scrollbars", `--user-data-dir=${join(tmp, "p" + Math.random().toString(36).slice(2))}`, "--window-size=1400,1400", "--virtual-time-budget=8000"];
  const dom = await run([...args, "--dump-dom", `${base}/page${query}`]);
  const m = /data-r="([^"]*)"/.exec(dom);
  if (!m) throw new Error("no probe result in dump");
  return JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")) as Probe;
}
const rootOf = (p: Probe) => p.root;
const savedRoot = (p: Probe): string[] | null => {
  if (!p.saved) return null;
  const t = (JSON.parse(p.saved) as { tree: { ch?: { id?: string }[] } }).tree;
  return (t.ch ?? []).map((n) => n.id ?? "?");
};

describe.skipIf(!CHROME)("cockpit warm-up", () => {
  const scenarios: [string, Record<string, { delay?: number; fail?: boolean }>][] = [
    ["all feeds at once", {}],
    ["feeds answering in reverse order", { "/cockpit/data": { delay: 2500 }, "/cockpit/system": { delay: 2200 }, "/cockpit/limits": { delay: 1900 }, "/cockpit/models": { delay: 1600 }, "/cockpit/pool": { delay: 1300 }, "/cockpit/queue": { delay: 1000 }, "/cockpit/memory": { delay: 700 } }],
    ["one feed delayed, one failing", { "/cockpit/queue": { delay: 15000 }, "/cockpit/models": { fail: true } }],
  ];
  for (const [name, p] of scenarios) {
    it(`${name}: default group order, every group has its cards, nothing scrambled is saved`, async () => {
      plan = p;
      const r = await open("?at=1200");
      if (process.env.WARM_DBG) console.log(name, JSON.stringify({ root: r.root, cnt: r.cnt, savedRoot: savedRoot(r) }));
      expect(r.err).toBeNull();
      expect(rootOf(r).slice(0, DEFAULT_ORDER.length)).toEqual(DEFAULT_ORDER);
      for (const g of GROUPS) expect(r.cnt[g], g).toBeGreaterThanOrEqual(1);
      const s = savedRoot(r);
      if (s) expect(s.slice(0, DEFAULT_ORDER.length)).toEqual(DEFAULT_ORDER);
      expect(r.guard, "an incomplete tree is not persisted").toBe(true);
    }, 120_000);
  }

  /** A layout as an earlier page saved it: the default root bands in a scrambled order. */
  async function scrambled(auto: boolean, extra?: (t: { ch: { id: string }[]; sz: number[] }) => void) {
    plan = {};
    const first = await open("?at=1200");
    const t = JSON.parse(first.saved!) as { auto?: number; tree: { ch: { id: string }[]; sz: number[] } };
    const idx = t.tree.ch.map((_, i) => i).reverse();
    t.tree.ch = idx.map((i) => t.tree.ch[i]!);
    t.tree.sz = idx.map((i) => t.tree.sz[i]!);
    if (auto) t.auto = 1; else delete t.auto;
    extra?.(t.tree);
    return open(`?at=1200&seed=${encodeURIComponent(JSON.stringify(t))}`);
  }
  it("repairs a scrambled auto layout that differs from the default only by group order", async () => {
    const r = await scrambled(true);
    expect(r.err).toBeNull();
    expect(r.root.slice(0, DEFAULT_ORDER.length)).toEqual(DEFAULT_ORDER);
  }, 120_000);
  it("leaves a scrambled layout alone once the user moved something (no auto flag)", async () => {
    const r = await scrambled(false);
    expect(r.root[0]).toBe("settings");
  }, 120_000);
});
