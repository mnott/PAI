/** Drag and drop in the real page: headless Chromium driven over the DevTools protocol with real mouse
 *  events (Input.dispatchMouseEvent) — sections and nested tiles reorder in place, an insertion
 *  indicator shows between items, nothing stays highlighted, the order survives a re-render and a reload. */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cockpitHtml } from "./cockpit-page.js";

const CHROME = process.env.CHROME_BIN ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));

const NOW = Date.now();
const job = (n: number) => ({ id: `job-${n}`, kind: "embed", name: `run ${n}`, phase: "embed", done: 10 * n, total: 100, pct: 10 * n, rate: 2, etaSec: 25, doneAt: NOW + 25_000, lastProgressAt: NOW - 1000, stalled: false, series: [1, 2, 3], by: "cockpit" });
const MEMORY = {
  at: NOW, daemon: true, level: "ok", reason: "ok", title: "Memory", stallSecs: 300,
  counts: { files: 5, chunks: 2000, embedded: 1900, backlog: 100, coverage: 0.95, coverageLevel: "ok", exact: false },
  segments: { fresh: 100, old: 1800, missing: 100 }, reembedding: false,
  binding: { mismatch: false, hint: "", error: null, bound: { backend: "a", model: "m" }, configured: { backend: "a", model: "m", dims: 8 } },
  backend: { id: "a", model: "m", dims: 8, available: true, reason: "ready", loaded: [], loadedModel: "m:1", gpuShare: 0.5 },
  daemonInfo: { pid: 1, uptimeSecs: 70, version: "1", storage: "s" },
  jobs: [job(1), job(2), job(3)], passes: [], lastIndex: null, lastEmbed: null,
  schedule: { maintenanceHour: 3, indexIntervalSecs: 86400, embedIntervalSecs: 86400 },
  run: null, starting: null, lastRun: null,
};

let server: Server;
let base = "";
let tmp = "";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let hits = 0;
let lastPt = { x: 0, y: 0 };
let chrome: ChildProcess | undefined;
let port = 0;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "cockpit-dnd-"));
  server = createServer((req, res) => {
    const url = req.url ?? "";
    if (url.startsWith("/page")) { res.setHeader("content-type", "text/html"); return res.end(cockpitHtml()); }
    res.setHeader("content-type", "application/json");
    if (url.startsWith("/cockpit/memory")) { hits++; return res.end(JSON.stringify({ ...MEMORY, daemonInfo: { ...MEMORY.daemonInfo, uptimeSecs: 70 + hits * 3600 } })); }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  if (!CHROME) return;
  chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--use-mock-keychain", "--password-store=basic", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${join(tmp, "p")}`, "--window-size=1400,1400", "about:blank"], { stdio: "ignore" });
  const f = join(tmp, "p", "DevToolsActivePort");
  for (let i = 0; i < 200 && !existsSync(f); i++) await new Promise((r) => setTimeout(r, 100));
  port = Number(readFileSync(f, "utf8").split("\n")[0]);
});
afterAll(async () => { chrome?.kill("SIGKILL"); server?.close(); await wait(500); if (tmp) rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

class Page {
  private id = 0;
  private pending = new Map<number, (v: any) => void>();
  private constructor(private ws: WebSocket) {
    ws.onmessage = (m) => { const d = JSON.parse(String(m.data)); const p = this.pending.get(d.id); if (p) { this.pending.delete(d.id); p(d); } };
  }
  static async open(): Promise<Page> {
    const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json() as { webSocketDebuggerUrl: string };
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r) => { ws.onopen = r; });
    const pg = new Page(ws);
    await pg.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    return pg;
  }
  send(method: string, params: object = {}): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve) => { this.pending.set(id, resolve); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async ev<T = any>(expr: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result?.result?.value;
  }
  async goto(url: string) { await this.send("Page.enable"); await this.send("Page.navigate", { url }); await new Promise((r) => setTimeout(r, 1800)); }
  async mouse(type: "mousePressed" | "mouseMoved" | "mouseReleased", x: number, y: number) {
    await this.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
  }
  async key(key: string, code: string, vk: number) {
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk });
  }
  close() { this.ws.close(); }
}


/** Centre points of an element's rect, or the point at a fraction of it. */
const rectOf = (sel: string) => `(function(){var e=document.querySelector(${JSON.stringify(sel)});e.scrollIntoView({block:"center"});var r=e.getBoundingClientRect();return{l:r.left,t:r.top,w:r.width,h:r.height}})()`;
const memTids = `Array.prototype.map.call(document.querySelectorAll('[data-tkey=mem]>[data-tid]'),function(t){return t.getAttribute('data-tid')})`;
const secNames = `Array.prototype.map.call(document.querySelectorAll('main section[data-section]'),function(s){return s.getAttribute('data-section')})`;
const leftovers = `document.querySelectorAll('.dropind,.dragging,.drop-target,.over,.target').length`;

describe.skipIf(!CHROME)("cockpit drag and drop in a real browser", () => {
  async function load(page: Page) {
    await page.goto(`${base}/page`);
    await page.ev(`localStorage.clear()`);
    await page.goto(`${base}/page`);
    await page.ev(`new Promise(function(r){var n=0,i=setInterval(function(){if(document.querySelectorAll('[data-tkey=mem]>[data-tid]').length>=5||++n>50){clearInterval(i);r(1)}},100)})`);
  }
  /** A real-mouse drag: press the grip, move in steps to (x,y), optionally stay; returns after the move. */
  async function dragTo(page: Page, grip: string, target: string | null, fx: number, fy: number, release = true) {
    const g = await page.ev<{ l: number; t: number; w: number; h: number }>(rectOf(grip));
    const gx = g.l + g.w / 2, gy = g.t + g.h / 2;
    // the target is measured after the grip scrolled into view; fy < 0 is a pixel offset from the top
    const tr = target ? await page.ev<{ l: number; t: number; w: number; h: number }>(`(function(){var r=document.querySelector(${JSON.stringify(target)}).getBoundingClientRect();return{l:r.left,t:r.top,w:r.width,h:r.height}})()`) : { l: 2, t: 2, w: 0, h: 0 };
    const x = tr.l + tr.w * fx, y = fy < 0 ? tr.t - fy : tr.t + tr.h * fy;
    lastPt = { x, y };
    await page.mouse("mouseMoved", gx, gy);
    await page.mouse("mousePressed", gx, gy);
    for (let i = 1; i <= 6; i++) { await page.mouse("mouseMoved", gx + ((x - gx) * i) / 6, gy + ((y - gy) * i) / 6); await wait(20); }
    if (release) { await page.mouse("mouseReleased", x, y); await wait(100); }
  }

  it("tiles: indicator between, in-place reorder, no highlight left, survives poll and reload; Escape cancels; sections move", async () => {
    const page = await Page.open();
    try {
      await load(page);
      const before: string[] = await page.ev(memTids);
      expect(before.length).toBeGreaterThanOrEqual(5);
      const [a, , c] = before as [string, string, string];
      const tile = (id: string) => `[data-tkey=mem]>[data-tid="${id}"]`;
      const grip = (id: string) => `${tile(id)}>[data-tgrip]`;

      // (a) drag the first tile to the right half of the third: indicator is a thin bar between, order changes in place
      await dragTo(page, grip(a), tile(c), 0.75, 0.5, false);
      // a poll re-render lands mid-drag (it replaces the tile nodes): the drag must carry on
      const h0 = hits;
      for (let i = 0; i < 40 && hits === h0; i++) await wait(250);
      await wait(500);
      await page.mouse("mouseMoved", lastPt.x + 1, lastPt.y);
      const ind = await page.ev<{ n: number; w: number; h: number; x: number; y: number } | null>(`(function(){var i=document.querySelectorAll('.dropind');if(!i.length)return null;var r=i[0].getBoundingClientRect();return{n:i.length,w:r.width,h:r.height,x:r.left,y:r.top}})()`);
      expect(ind, "an indicator shows during the drag").not.toBeNull();
      expect(ind!.n).toBe(1);
      expect(Math.min(ind!.w, ind!.h), "a thin bar, not a box on the target").toBeLessThanOrEqual(8);
      expect(await page.ev(`document.querySelector('[data-tkey=mem]>[data-tid="${a}"]').style.opacity+"|"+document.querySelector('[data-tkey=mem]>[data-tid="${a}"]').className`)).toMatch(/dragging|0\.\d/);
      const mid = await page.ev(`(function(){var r=document.querySelector('[data-tkey=mem]>[data-tid="${c}"]').getBoundingClientRect();return{r:r.right}})()`);
      expect(Math.abs(ind!.x - (mid as { r: number }).r), "bar sits at the gap after the third tile").toBeLessThan(20);
      await page.mouse("mouseReleased", lastPt.x, lastPt.y);
      await wait(100);
      const after: string[] = await page.ev(memTids);
      expect(after.slice(0, 3)).toEqual([before[1], before[2], a]);
      expect(await page.ev(leftovers), "no drag class, target highlight or indicator left").toBe(0);

      // (c) a poll re-render keeps the order, a reload keeps it
      const seen = hits;
      const txt0: string = await page.ev(`document.getElementById("sec-memory").textContent`);
      for (let i = 0; i < 40 && hits === seen; i++) await wait(250);
      await wait(400);
      expect(await page.ev(`document.getElementById("sec-memory").textContent`), "the card re-rendered from fresh data").not.toBe(txt0);
      expect(await page.ev(memTids)).toEqual(after);
      await page.goto(`${base}/page`);
      await page.ev(`new Promise(function(r){var n=0,i=setInterval(function(){if(document.querySelectorAll('[data-tkey=mem]>[data-tid]').length>=5||++n>50){clearInterval(i);r(1)}},100)})`);
      expect(await page.ev(memTids)).toEqual(after);

      // (d) Escape cancels: nothing moves, nothing left
      await dragTo(page, grip(after[0]!), tile(before[4]!), 0.75, 0.5, false);
      expect(await page.ev(`document.querySelectorAll('.dropind').length`)).toBe(1);
      await page.key("Escape", "Escape", 27);
      await page.mouse("mouseReleased", lastPt.x, lastPt.y);
      await wait(100);
      expect(await page.ev(memTids)).toEqual(after);
      expect(await page.ev(leftovers)).toBe(0);

      // releasing outside any gap cancels too
      await dragTo(page, grip(after[0]!), null, 0, 0, true);
      expect(await page.ev(memTids)).toEqual(after);
      expect(await page.ev(leftovers)).toBe(0);

      // (b) sections: move the second section above the first
      const secs: string[] = await page.ev(secNames);
      const s0 = secs[0]!, s1 = secs[1]!;
      await dragTo(page, `main section[data-section="${s1}"] .sgrip`, `main section[data-section="${s0}"]`, 0.5, -4, false);
      expect(await page.ev(`document.querySelectorAll('.dropind').length`)).toBe(1);
      await page.mouse("mouseReleased", lastPt.x, lastPt.y);
      await wait(150);
      const secs2: string[] = await page.ev(secNames);
      expect(secs2.indexOf(s1), "moved in place, no reload").toBeLessThan(secs2.indexOf(s0));
      expect(await page.ev(leftovers)).toBe(0);
      await page.goto(`${base}/page`);
      expect(await page.ev(secNames)).toEqual(secs2);
    } finally { page.close(); }
  }, 120_000);

  it("keyboard: the grip is focusable, Enter grabs, arrows move one place, Enter drops", async () => {
    const page = await Page.open();
    try {
      await load(page);
      const before: string[] = await page.ev(memTids);
      const g = `[data-tkey=mem]>[data-tid="${before[0]}"]>[data-tgrip]`;
      await page.ev(`document.querySelector(${JSON.stringify(g)}).focus()`);
      expect(await page.ev(`document.activeElement.hasAttribute("data-tgrip")`), "grip focusable").toBe(true);
      await page.key("ArrowRight", "ArrowRight", 39);
      expect(await page.ev(memTids), "arrows do nothing before a grab").toEqual(before);
      await page.key("Enter", "Enter", 13);
      expect(await page.ev(`document.activeElement.getAttribute("aria-pressed")`)).toBe("true");
      await page.key("ArrowRight", "ArrowRight", 39);
      await page.key("ArrowRight", "ArrowRight", 39);
      expect(await page.ev(memTids)).toEqual([before[1], before[2], before[0], ...before.slice(3)]);
      expect(await page.ev(`document.activeElement.hasAttribute("data-tgrip")`), "focus stays on the grip").toBe(true);
      await page.key("Enter", "Enter", 13);
      expect(await page.ev(`document.activeElement.getAttribute("aria-pressed")`)).toBe("false");
      await page.key("ArrowLeft", "ArrowLeft", 37);
      expect(await page.ev(memTids)).toEqual([before[1], before[2], before[0], ...before.slice(3)]);
    } finally { page.close(); }
  }, 60_000);
});
