/**
 * The cockpit tables never scroll sideways: the real page, served with live-shaped data,
 * is loaded in headless Chromium at several widths and every .tw table wrapper must
 * satisfy scrollWidth <= clientWidth. Skipped when no Chromium is installed.
 * PAI_FIT_SHOTS=<dir> additionally writes a screenshot per width.
 */

import { execFile, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cockpitHtml } from "./cockpit-page.js";
import { checkRows, tileFixtureHtml, type TileLayout, type TileMeasure, type TileRow } from "./cockpit-tile-rows-fit.js";

const CHROME = process.env.CHROME_BIN ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));

const MODELS = ["claude-opus-5-5", "claude-haiku-5-5", "claude-sonnet-5-5", "glm-5.3-flash", "qwen3.8-flash-next-gyro-m"];
const bucket = (n: number, hit: number) => ({ label: "x", n, hit });
const stat = (r: number, t: number | null) => ({ requests: r, ttftP50: t, ttftP90: t == null ? null : t * 2.4, readTps: t == null ? null : 1234.5, writeTps: t == null ? null : 41.2 });

function fixtureData() {
  const long = "worktree-20261021-015130-55831-phone-fit-check-for-the-cockpit-sessions-table";
  const sessions = Array.from({ length: 24 }, (_, i) => ({
    session: `2026102${i % 3}-0${i}1530-5583${i}`,
    name: i < 6 ? (i === 0 ? long : `PAI session ${i}`) : "",
    models: i < 3 ? [MODELS[0], MODELS[1], MODELS[3]] : [MODELS[3]],
    requests: 900 - i * 35, input: 2_000_000 - i * 70_000, cacheWrite: 300_000, cacheRead: 40_000_000 - i * 1_500_000, output: 120_000,
    hitRatio: 0.93, busts: i % 4, errors: i % 5, lastTs: new Date(Date.now() - i * 600_000).toISOString(),
    worker: i === 2 ? "20261021-063345-95575" : undefined, verdict: i === 2 ? "report flagged" : undefined,
  }));
  const workers = ["run.ts split step 1: provider test moved out of the router file", "cockpit tables: sessions, runs, speed and providers read at any width", "fix(cockpit): workers section empty markup counts as empty", "docs: cockpit chart resize keys and screenshots without empty columns", "", "x"].map((name, i) => ({
    worker: `20261021-0${i}3345-9557${i}`, name, workerProvider: i % 2 ? "anthropic" : "glm", requests: 40 + i, input: 800_000, cacheWrite: 0, cacheRead: 5_000_000, output: 20_000,
    verdict: ["ok", "ok", "failed: exit 1", "report flagged", "escalated to session", "handed to session"][i],
  }));
  return {
    window: "1h", totals: { requests: 5000, input: 9e6, output: 4e5, cacheWrite: 1e6, cacheRead: 9e7, errors: 12, hitRatio: 0.9 },
    byModel: MODELS.map((m, i) => ({ provider: i < 3 ? "anthropic" : "glm", model: m, requests: 1000 + i, input: 1e6, cacheWrite: 1e5, cacheRead: 1e7, output: 1e5 })),
    series: [], weights: { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 },
    cachePause: MODELS.slice(0, 3).map((m) => ({ model: "anthropic/" + m + "-with-a-long-suffix-20261021", buckets: ["<5m", "5-30m", "30m-1h", "1-3h", ">3h"].map((l, j) => ({ ...bucket(40 + j, 30), label: l })) })),
    byProvider: [{ provider: "anthropic", requests: 3000, errors: 4, retries: 6, avgMs: 4100, ttftP50: 900, input: 1e6, output: 1e5, cacheWrite: 1e5, cacheRead: 1e7, hitRatio: 0.94 }, { provider: "glm", requests: 1900, errors: 8, retries: 0, avgMs: 2100, ttftP50: 700, input: 1e6, output: 1e5, cacheWrite: 0, cacheRead: 0, hitRatio: 0 }, { provider: "gyro-m", requests: 100, errors: 0, retries: 0, avgMs: 8100, ttftP50: 2500, input: 1e6, output: 1e5, cacheWrite: 0, cacheRead: 0, hitRatio: 0 }],
    bustParts: { tools: 3, system: 1 }, bySession: sessions, workers, daily: { models: {}, days: [] }, sessionSplit: null,
    speed: MODELS.map((m, i) => ({ provider: i < 3 ? "anthropic" : "glm", model: m, h1: stat(30 + i, 900 + i), h24: stat(400 + i, i === 2 ? null : 1100) })),
    promptByProvider: {}, promptSince: {},
  };
}
const fixtureSystem = () => ({ current: {}, series: { series: [] }, servers: [{ provider: "gyro-m", up: true, rssMb: 36148, tokensPerSec: 58.5, prefixCache: { hitRate: 0.91, hits: 910, misses: 90, tokensSaved: 1e6, entries: 4, memoryMb: 2048 } }, { provider: "ollama-local-with-a-long-name", up: true, rssMb: 5100, tokensPerSec: 31.2, prefixCache: null }] });
const fixtureQueue = () => ({ providers: [{ provider: "glm", cap: 2, running: [{ id: "w-20261021-063345", label: "run.ts split step 1: provider test moved out of the router file", ageSec: 120, now: "editing script-tables.ts", session: "PAI", model: "glm-5.3" }], waiting: [{ id: "w-2", label: "fix cockpit tables at any width", waitedSec: 30, position: 1, session: "PAI", model: "glm-5.3" }] }], panes: [], paneViolations: [], plans: [], build: { running: [], waiting: [] } });
/** Three cloud providers: at 822 px the old auto-fill grid put the third tile alone on a half-width row. */
const fixtureLimits = () => ({
  activeLocal: null,
  limits: ["anthropic", "glm", "gyro-m"].map((provider) => ({ provider, kind: "cloud", windows: [{ name: "5h", percent: 30, resetAt: Date.now() + 3600_000 }] })),
});

let server: Server;
let base = "";
let tmp = "";
const INJECT = `<script>setTimeout(function(){var out=[];document.querySelectorAll(".tw").forEach(function(w){var s=w.closest("section"),t=w.querySelector("table");out.push({sec:s?s.getAttribute("data-section"):"?",scrollWidth:w.scrollWidth,clientWidth:w.clientWidth,tableW:t?t.scrollWidth:0,rows:w.querySelectorAll("tbody tr").length,rowH:Array.prototype.map.call(w.querySelectorAll("tbody tr"),function(r){return r.getBoundingClientRect().height}),lh:parseFloat(getComputedStyle(w).lineHeight)||parseFloat(getComputedStyle(w).fontSize)*1.2,stacked:w.classList.contains("stacked"),firstW:(w.querySelector("tbody td")||{getBoundingClientRect:function(){return{width:0}}}).getBoundingClientRect().width,subs:Array.prototype.map.call(w.querySelectorAll("tbody tr"),function(r){var c=r.querySelector("td"),d=c&&c.querySelector(".dim"),cr=c&&c.getBoundingClientRect(),dr=d&&d.getBoundingClientRect();return{lines:c&&c.querySelectorAll(".dim").length,inside:!!dr&&dr.width>0&&dr.top>=cr.top-0.5&&dr.bottom<=cr.bottom+0.5&&dr.left>=cr.left-0.5&&dr.right<=cr.right+0.5}}),thead:!!w.querySelector("thead")&&getComputedStyle(w.querySelector("thead")).display!=="none"})});var bef=[];document.querySelectorAll(".tw.stacked td").forEach(function(d){var cs=getComputedStyle(d,"::before"),sc=d.closest("section");bef.push({sec:sc?sc.getAttribute("data-section"):"?",label:d.getAttribute("data-l"),h:parseFloat(cs.height),fs:parseFloat(cs.fontSize)})});var ths=[];document.querySelectorAll(".tw th").forEach(function(h){var r=document.createRange();r.selectNodeContents(h);var tops={};Array.prototype.forEach.call(r.getClientRects(),function(q){if(q.width>0)tops[Math.round(q.top)]=1});var sc=h.closest("section");ths.push({sec:sc?sc.getAttribute("data-section"):"?",label:h.textContent,lines:Object.keys(tops).length,height:Math.round(h.getBoundingClientRect().height)})});var m=document.querySelector("main");parent.postMessage(JSON.stringify({main:m.clientWidth,doc:document.documentElement.scrollWidth,vw:innerWidth,tables:out,ths:ths,befores:bef}),"*")},2500)</script>`;
/** .pgrid rows: tiles grouped by y; every row must span the container width (the flex fix). */
const PGRID_INJECT = `<script>setTimeout(function(){var out=[];document.querySelectorAll(".pgrid").forEach(function(g){var gr=g.getBoundingClientRect(),rows={};g.querySelectorAll(":scope > *").forEach(function(t){var r=t.getBoundingClientRect();var y=Math.round(r.top);(rows[y]=rows[y]||[]).push({x:r.left-gr.left,w:r.width})});out.push({id:g.id,gridW:gr.width,rows:Object.keys(rows).sort(function(a,b){return a-b}).map(function(y){return{y:+y,rects:rows[y]}})})});parent.postMessage(JSON.stringify({pgrids:out}),"*")},2500)</script>`;
/** The workers card: the gap between its last child's bottom and the card's content bottom (padding). */
const WORKERS_INJECT = `<script>setTimeout(function(){var s=document.querySelector('section[data-section="workers"]'),kids=s.children,last=kids[kids.length-1],cs=getComputedStyle(s);parent.postMessage(JSON.stringify({workers:{gap:s.getBoundingClientRect().bottom-last.getBoundingClientRect().bottom-parseFloat(cs.paddingBottom)}}),"*")},2500)</script>`;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "cockpit-fit-"));
  server = createServer((req, res) => {
    const url = req.url ?? "";
    const json = (o: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
    if (url.startsWith("/cockpit/data")) return json(fixtureData());
    if (url.startsWith("/cockpit/system")) return json(fixtureSystem());
    if (url.startsWith("/cockpit/queue")) return json(fixtureQueue());
    if (url.startsWith("/cockpit/limits")) return json(fixtureLimits());
    if (url.startsWith("/frame")) {
      // the page runs in an iframe: its viewport is the iframe's width, whatever the minimum headless window is
      const w = /w=(\d+)/.exec(url)?.[1] ?? "822";
      const main = /main=(\d+)/.exec(url)?.[1];
      const probe = /probe=(\w+)/.exec(url)?.[1];
      res.setHeader("content-type", "text/html");
      return res.end(`<body style="margin:0"><iframe src="/page${main ? `?main=${main}` : ""}${probe ? `?probe=${probe}` : ""}" style="width:${w}px;height:3200px;border:0"></iframe><script>onmessage=function(e){document.body.setAttribute("data-fit",e.data)}</script></body>`);
    }
    if (url.startsWith("/page")) {
      const main = /main=(\d+)/.exec(url)?.[1];
      const probe = /probe=(\w+)/.exec(url)?.[1];
      const html = cockpitHtml().replace("</body>", (main ? `<style>main{width:${main}px;max-width:${main}px;box-sizing:border-box}</style>` : "") + (probe === "tiles" ? PGRID_INJECT : probe === "workers" ? WORKERS_INJECT : INJECT) + "</body>");
      res.setHeader("content-type", "text/html");
      return res.end(html);
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => { for (const c of browsers) c.kill("SIGKILL"); server?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

/** Every browser started here, so afterAll can kill what a failed test left behind. */
const browsers = new Set<ChildProcess>();
function run(bin: string, args: string[], opts: { encoding?: "utf8"; timeout: number; maxBuffer?: number }): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const c = execFile(bin, args, { ...opts, encoding: "utf8" }, (err, stdout) => { browsers.delete(c); err ? reject(err) : resolve({ stdout }); });
    browsers.add(c);
  });
}
interface ShootResult {
  main: number; doc: number; vw: number;
  tables: { sec: string; scrollWidth: number; clientWidth: number; tableW: number; rows: number; rowH: number[]; lh: number; stacked: boolean; firstW: number; subs: { lines: number; inside: boolean }[]; thead: boolean }[];
  befores: { sec: string; label: string; h: number; fs: number }[];
  pgrids?: { id: string; gridW: number; rows: TileRow[] }[];
  workers?: { gap: number };
  ths: { sec: string; label: string; lines: number; height: number }[];
}
async function shoot(width: number, main: number | null, shot?: string, probe?: string): Promise<ShootResult> {
  const args = ["--headless=new", "--disable-gpu", "--use-mock-keychain", "--password-store=basic", "--no-first-run", "--hide-scrollbars", `--user-data-dir=${join(tmp, "p" + width + "-" + (main ?? 0))}`, "--window-size=1000,3300", "--virtual-time-budget=6000"];
  const url = `${base}/frame?w=${width}${main ? `&main=${main}` : ""}${probe ? `&probe=${probe}` : ""}`;
  const { stdout: dom } = await run(CHROME!, [...args, "--dump-dom", url], { encoding: "utf8", timeout: 60_000, maxBuffer: 64 << 20 });
  if (shot) await run(CHROME!, [...args, `--screenshot=${shot}`, url], { timeout: 60_000 });
  const m = /data-fit="([^"]*)"/.exec(dom);
  if (!m) throw new Error("no fit result in dump");
  return JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
}

/** Chrome with a host page embedding `html` in an iframe; returns the iframe's postMessage payload. */
async function measure(html: string, tag: string): Promise<TileMeasure> {
  const host = join(tmp, `host-${tag}.html`);
  writeFileSync(host, `<!doctype html><html><body style="margin:0">${html}<script>onmessage=function(e){document.body.setAttribute("data-tiles",e.data)}</script></body></html>`);
  const args = ["--headless=new", "--disable-gpu", "--use-mock-keychain", "--password-store=basic", "--no-first-run", "--hide-scrollbars", `--user-data-dir=${join(tmp, "tp-" + tag)}`, "--window-size=1400,900", "--virtual-time-budget=4000"];
  const { stdout: dom } = await run(CHROME!, [...args, "--dump-dom", `file://${host}`], { encoding: "utf8", timeout: 60_000, maxBuffer: 64 << 20 });
  const m = /data-tiles="([^"]*)"/.exec(dom);
  if (!m) throw new Error(`no tile result for ${tag}`);
  return JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
}

describe.skipIf(!CHROME)("cockpit tables fit their card (no horizontal scroll), real layout in Chromium", () => {
  const shots = process.env.PAI_FIT_SHOTS;
  for (const [label, width, main] of [["822 px viewport", 822, null], ["385 px main width inside a wide viewport (half-width card)", 900, 385], ["375 px phone", 375, null]] as const) {
    it(`${label}: every table wrapper has scrollWidth <= clientWidth`, async () => {
      const r = await shoot(width, main, shots ? join(shots, `cockpit-${width}${main ? "-main" + main : ""}.png`) : undefined);
      const secs = new Set(r.tables.map((t) => t.sec));
      // sessions, runs, speed, pause, providers (cache) and the workers queue table all rendered
      // (System renders metric tiles now, not a table)
      for (const s of ["sessions", "runs", "speed", "pause", "cache", "workers"]) expect(secs.has(s), `${s} table present (${[...secs].join(",")})`).toBe(true);
      for (const t of r.tables) {
        expect(t.scrollWidth, `${t.sec}: wrapper ${t.clientWidth}px, content ${t.scrollWidth}px`).toBeLessThanOrEqual(t.clientWidth);
        expect(t.tableW, `${t.sec}: table ${t.tableW}px in wrapper ${t.clientWidth}px`).toBeLessThanOrEqual(t.clientWidth);
      }
      // no header wraps: the text inside every th sits on one line (range rects share one top)
      expect(r.ths.length, "headers measured").toBeGreaterThan(0);
      for (const h of r.ths) expect(h.lines, `${h.sec} th "${h.label}": ${h.lines} lines (height ${h.height}px)`).toBeLessThanOrEqual(1);
      expect(r.doc, "page itself must not scroll sideways").toBeLessThanOrEqual(r.vw);
      // a stacked label (td::before) never wraps: one line box, whatever the card width
      for (const b of r.befores) expect(b.h, `${b.sec} label "${b.label}": ${b.h}px high at ${b.fs}px font`).toBeLessThanOrEqual(b.fs * 1.6);
      if (width === 822) {
        const runs = r.tables.find((t) => t.sec === "runs")!;
        expect(runs.clientWidth, "Worker runs sits in a half-width card").toBeLessThan(450);
        expect(runs.stacked, "Worker runs fits as a table at 822 px: not stacked").toBe(false);
        expect(runs.thead, "Worker runs keeps its thead").toBe(true);
        expect(runs.rowH.length, "Worker runs rows measured").toBeGreaterThan(0);
        expect(runs.firstW, `Worker runs label column ${runs.firstW}px of table ${runs.tableW}px`).toBeGreaterThanOrEqual(runs.tableW * 0.55);
        runs.subs.forEach((s, i) => expect(s.inside, `Worker runs row ${i}: dim provider line visible inside the cell`).toBe(true));
        for (const h of runs.rowH) expect(h, `Worker runs row ${h}px high at line height ${runs.lh}px`).toBeLessThanOrEqual(runs.lh * 2.6);
      }
      if (width === 375) expect(r.tables.find((t) => t.sec === "sessions")!.stacked, "sessions does not fit at 375 px: stacked").toBe(true);
    }, 120_000);
  }
});

/** The real page at 822 px with fixture data: the provider .pgrid rows must fill the
 *  container (three cloud providers: the old auto-fill grid left the third tile alone,
 *  half width, empty space beside it), and the workers card must end after its content
 *  (the held min-height of setHtml left ~100 px of empty space below the last table). */
describe.skipIf(!CHROME)("provider tiles fill their row and the workers card ends after its content, real page at 822 px", () => {
  it("3 cloud providers at 822 px: every .pgrid row's tiles span the container width", async () => {
    const r = await shoot(822, null, undefined, "tiles");
    expect(r.pgrids, "pgrid probe ran").toBeDefined();
    const cloud = r.pgrids!.find((p) => p.id === "cloud")!;
    expect(cloud.rows.length, "cloud tiles rendered").toBeGreaterThan(0);
    expect(checkRows({ gridW: cloud.gridW, rows: cloud.rows }, "cloud/822")).toEqual([]);
    // the live shape: 3 tiles, two on row 1, one on row 2 — the row the old grid left partial
    expect(cloud.rows.length).toBe(2);
    expect(cloud.rows[1].rects.length).toBe(1);
    // the local grid renders too (the local fixture has no up server: the placeholder row)
    expect(r.pgrids!.some((p) => p.id === "local")).toBe(true);
  }, 120_000);

  it("the workers card's bottom padding area is under 24 px below its last child", async () => {
    const r = await shoot(822, null, undefined, "workers");
    expect(r.workers, "workers probe ran").toBeDefined();
    expect(r.workers!.gap, `gap below the last child: ${r.workers!.gap.toFixed(1)}px`).toBeLessThan(24);
  }, 120_000);
});

/** The real page CSS, rendered in Chromium: a .rt-tiles grid must never leave a partial
 *  last row — every row's tiles together span the full grid width, at wide and 2-column
 *  container widths, for tile counts with last-row remainder 1, 2 and 3. */
describe.skipIf(!CHROME)(".rt-tiles last row fills the grid, real CSS in Chromium", () => {
  // a temp config only — never the live files; PAI_CONFIG_FILE points at it
  const L: TileLayout = { wideBreakpointPx: 700, oneColBreakpointPx: 339, wideCols: 4, narrowCols: 2 };
  let dir = "";
  let html = "";
  const prevConfigFile = process.env.PAI_CONFIG_FILE;
  const prevHome = process.env.PAI_HOME;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "pai-tile-fit-"));
    writeFileSync(join(dir, "config.yaml"), `router:\n  cockpit:\n    layout:\n      tilesWideBreakpointPx: ${L.wideBreakpointPx}\n      tilesWideCols: ${L.wideCols}\n      tilesNarrowCols: ${L.narrowCols}\n      tilesOneColBreakpointPx: ${L.oneColBreakpointPx}\n`);
    process.env.PAI_CONFIG_FILE = join(dir, "config.json");
    delete process.env.PAI_HOME;
    html = cockpitHtml().match(/<style>[\s\S]*?<\/style>/g)!.join("");
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prevConfigFile === undefined) delete process.env.PAI_CONFIG_FILE;
    else process.env.PAI_CONFIG_FILE = prevConfigFile;
    if (prevHome === undefined) delete process.env.PAI_HOME;
    else process.env.PAI_HOME = prevHome;
  });

  const widths: [string, number][] = [
    ["wide", L.wideBreakpointPx + 200],
    ["2-col", L.wideBreakpointPx - 20],
  ];
  for (const [mode, containerPx] of widths) {
    for (const n of [11, 5, 6, 7]) {
      it(`${mode} container (${containerPx}px), ${n} tiles: every row spans the full grid width`, async () => {
        const m = await measure(html + tileFixtureHtml(n, containerPx), `${mode}-${n}`);
        expect(m.rows.length, `${mode}/${n}: rows found`).toBeGreaterThan(0);
        expect(checkRows(m, `${mode}/${n}`)).toEqual([]);
      }, 120_000);
    }
  }
});
