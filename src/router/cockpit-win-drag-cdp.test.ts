/**
 * Real-pointer drag and drop on the real cockpit page: headless Chromium driven over CDP (Input.dispatchMouseEvent),
 * so the page sees genuine pointer events, hit-testing and layout. The kpis totals group (one row of six metric cards)
 * and the pool group at 1500 px:
 *   E1  right of a sibling works (the cards sit side by side, the tree changes)
 *   E2  bottom of a roomy target works (the target cell keeps its width)
 *   E2b a drop that would leave a card without room is refused (kpis.errors under kpis.input): the indicator shows the refused state with
 *       the reason, releasing moves nothing, and no card changes its box (no stacked-layout jump)
 *   E3  a target outside the dragged card's container is refused: no indicator, nothing moves
 * Skipped when no Chromium is installed.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cockpitHtml } from "./cockpit-page.js";
import { fixtureData, fixtureLimits, fixturePool, fixtureQueue, fixtureSystem } from "./cockpit-fixtures.js";

const CHROME = process.env.CHROME_BIN ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));

let server: Server;
let base = "";
let tmp = "";
let proc: ChildProcess | undefined;
let ws: WebSocket | undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "cockpit-win-drag-cdp-"));
  server = createServer((req, res) => {
    const url = req.url ?? "";
    const json = (o: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
    if (url.startsWith("/cockpit/data")) return json(fixtureData());
    if (url.startsWith("/cockpit/system")) return json(fixtureSystem());
    if (url.startsWith("/cockpit/queue")) return json(fixtureQueue());
    if (url.startsWith("/cockpit/limits")) return json(fixtureLimits());
    if (url.startsWith("/cockpit/pool")) return json(fixturePool());
    if (url.startsWith("/cockpit/")) return json({});
    if (url.startsWith("/page")) { res.setHeader("content-type", "text/html"); return res.end(cockpitHtml()); }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => { try { ws?.close(); } catch { /* closed */ } proc?.kill("SIGKILL"); server?.close(); if (tmp) try { rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* the browser may still be flushing its profile */ } });

async function launch(w: number, h: number) {
  const dir = join(tmp, "profile");
  proc = spawn(CHROME!, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`, `--window-size=${w},${h}`, "--no-first-run", "--disable-gpu", "--use-mock-keychain", "--password-store=basic", "about:blank"], { stdio: "ignore" });
  let port = 0;
  for (let i = 0; i < 100 && !port; i++) {
    await sleep(200);
    try { port = Number(readFileSync(join(dir, "DevToolsActivePort"), "utf8").split("\n")[0]); } catch { /* not up yet */ }
  }
  if (!port) throw new Error("chrome did not start");
  let tabs: { type: string; webSocketDebuggerUrl: string }[] = [];
  for (let i = 0; i < 50 && !tabs.length; i++) { try { tabs = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as typeof tabs; } catch { await sleep(200); } }
  ws = new WebSocket(tabs.find((t) => t.type === "page")!.webSocketDebuggerUrl);
  await new Promise((r) => { ws!.onopen = r; });
  let id = 0;
  const pend = new Map<number, (d: { result: unknown }) => void>();
  ws.onmessage = (m) => { const d = JSON.parse(String(m.data)); if (d.id && pend.has(d.id)) { pend.get(d.id)!(d); pend.delete(d.id); } };
  const send = (method: string, params: object = {}) => new Promise<{ result: any }>((r) => { const i = ++id; pend.set(i, r as never); ws!.send(JSON.stringify({ id: i, method, params })); });
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  const ev = async <T>(expr: string): Promise<T> => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result.result.value as T;
  };
  const mouse = (type: string, x: number, y: number) => send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
  return { send, ev, mouse };
}

type Rects = Record<string, [number, number, number, number]>;
interface Snap { tree: string; pool: string; r: Rects }
const SNAP = `(function(){var o={};document.querySelectorAll("#win-root .card").forEach(function(c){var r=c.getBoundingClientRect();o[c.dataset.card]=[Math.round((r.left+scrollX)*100)/100,Math.round((r.top+scrollY)*100)/100,Math.round(r.width*100)/100,Math.round(r.height*100)/100]});return{tree:JSON.stringify(Win.state().kids.kpis),pool:JSON.stringify(Win.state().kids.pool),r:o}})()`;
const rectDiffs = (a: Snap, b: Snap) => Object.keys({ ...a.r, ...b.r }).filter((k) => k.startsWith("kpis")).filter((k) => JSON.stringify(a.r[k]) !== JSON.stringify(b.r[k]));

describe.skipIf(!CHROME)("cockpit drag and drop with real pointer events (CDP)", () => {
  it("E1 right-of and E2 bottom-of work; E2b a drop with no room and E3 an outside target are refused", async () => {
    const b = await launch(1500, 1000);
    await b.send("Page.navigate", { url: `${base}/page` });
    for (let i = 0; i < 60; i++) { await sleep(250); if (await b.ev<boolean>(`!!document.querySelector('#win-root [data-card="kpis.errors"] .cgrip')&&typeof Win!=="undefined"`)) break; }
    await sleep(1500);
    const snap = () => b.ev<Snap>(SNAP);
    const drag = async (id: string, tid: string, fx: number, fy: number) => {
      await b.ev(`document.querySelector('#win-root [data-card="${id}"]').scrollIntoView({block:"center"})`);
      await sleep(200);
      const [gx, gy] = await b.ev<[number, number]>(`(function(){var r=document.querySelector('#win-root [data-card="${id}"] .cgrip').getBoundingClientRect();return[r.left+r.width/2,r.top+r.height/2]})()`);
      const t = await b.ev<[number, number, number, number]>(`(function(){var r=document.querySelector('#win-root [data-card="${tid}"]').getBoundingClientRect();return[r.left,r.top,r.width,r.height]})()`);
      const tx = t[0] + t[2] * fx, ty = t[1] + t[3] * fy;
      await b.mouse("mouseMoved", gx, gy); await b.mouse("mousePressed", gx, gy);
      for (let i = 1; i <= 12; i++) { await b.mouse("mouseMoved", gx + ((tx - gx) * i) / 12, gy + ((ty - gy) * i) / 12); await sleep(30); }
      await sleep(200);
      const ind = await b.ev<{ cls: string; zone: string; title: string } | null>(`(function(){var i=document.querySelector(".dropind");return i?{cls:i.className,zone:i.getAttribute("data-zone"),title:i.getAttribute("title")||""}:null})()`);
      const during = await snap();
      await b.mouse("mouseReleased", tx, ty); await sleep(800);
      return { ind, during };
    };

    const s0 = await snap();
    expect(Object.keys(s0.r).filter((k) => k.startsWith("kpis.")).length).toBe(6);

    // E1: requests to the right edge of input
    const e1 = await drag("kpis.requests", "kpis.input", 0.95, 0.5);
    const s1 = await snap();
    expect(e1.ind?.cls, "E1 indicator is not the refused state").toBe("dropind");
    expect(e1.ind?.zone).toBe("right");
    expect(e1.during.tree, "nothing changes during the drag").toBe(s0.tree);
    expect(s1.tree).not.toBe(s0.tree);
    expect(s1.r["kpis.input"]![1]).toBe(s1.r["kpis.requests"]![1]); // same row
    expect(Math.abs(s1.r["kpis.input"]![0] + s1.r["kpis.input"]![2] - s1.r["kpis.requests"]![0]) < 20 || Math.abs(s1.r["kpis.requests"]![0] + s1.r["kpis.requests"]![2] - s1.r["kpis.input"]![0]) < 20).toBe(true); // side by side

    // E2: pool.hit under pool.slots (the pool group body is tall enough for two cards in a column)
    const e2 = await drag("pool.hit", "pool.slots", 0.5, 0.95);
    const s2 = await snap();
    expect(e2.ind?.cls, "E2 indicator is not the refused state: " + e2.ind?.title).toBe("dropind");
    expect(e2.ind?.zone).toBe("bottom");
    expect(s2.tree, "the kpis tree is not touched by a pool drop").toBe(s1.tree);
    expect(s2.pool).not.toBe(s1.pool);
    expect(s2.r["pool.hit"]![1], "pool.hit sits below pool.slots").toBeGreaterThan(s2.r["pool.slots"]![1]);
    expect(Math.abs(s2.r["pool.hit"]![0] - s2.r["pool.slots"]![0])).toBeLessThan(1);

    // E2b: errors under input leaves no room (the group body is one metric tall): refused, nothing moves, no height jump
    const e2b = await drag("kpis.errors", "kpis.input", 0.5, 0.95);
    const s2b = await snap();
    expect(e2b.ind?.cls, "E2b indicator shows the refused state").toContain("bad");
    expect(e2b.ind?.title, "the reason is on the indicator").toMatch(/^no room: \S+ would be \d+ px( tall)?, needs \d+$/);
    expect(s2b.tree, "E2b leaves the tree alone").toBe(s2.tree);
    expect(rectDiffs(s2, s2b), "E2b moves no card").toEqual([]);

    // E3: a target in another container is not a drop target
    const e3 = await drag("kpis.requests", "pool.host", 0.95, 0.5);
    const s3 = await snap();
    expect(e3.ind, "E3 shows no indicator").toBeNull();
    expect(s3.tree).toBe(s2b.tree);
    expect(rectDiffs(s2b, s3)).toEqual([]);
  }, 120_000);
});
