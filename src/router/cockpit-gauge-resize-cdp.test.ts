/**
 * Dragging the bottom-right handle of a provider gauge card (two dials) with real mouse events must not feed back into layout:
 * 200 drag steps keep the layout count per step, the heap and the node count bounded, and the page keeps answering.
 * GAUGE_SOAK_MS=60000 turns it into a timed soak that prints a reading every 2 s. Skipped when no Chromium is installed.
 */

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHROME, closeBrowser, launch, sleep } from "./cdp-browser.js";
import { cockpitHtml } from "./cockpit-page.js";
import { fixtureData } from "./cockpit-fixtures.js";

const win = (name: string, percent: number) => ({ name, percent, resetAt: Date.now() + 3_600_000 });
const limits = () => ({
  activeLocal: "", runningLocal: [],
  limits: [
    { provider: "glm", kind: "cloud", windows: [win("5h", 30), win("week", 60)] },
    { provider: "claude", kind: "cloud", windows: [win("5h", 41), win("week", 12)] },
  ],
  routing: { flow: "", endpoints: [], choices: [], rows: [] },
});

let server: Server;
let base = "";
let saves = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").replace(/\?.*/, "");
    const json = (o: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
    if (path === "/cockpit/limits") return json(limits());
    if (path === "/cockpit/data") return json(fixtureData());
    if (path.startsWith("/cockpit/layout") && req.method !== "GET") saves++;
    if (path.startsWith("/cockpit/")) return json({});
    if (path === "/page") { res.setHeader("content-type", "text/html"); return res.end(cockpitHtml()); }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(Number(process.env.GAUGE_PORT ?? 0), "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await closeBrowser(); server?.close(); });

const HOOK = `(function(){window.__ro=0;window.__mv=0;var R=window.ResizeObserver;window.ResizeObserver=function(cb){return new R(function(){window.__ro++;return cb.apply(this,arguments)})};
window.ResizeObserver.prototype=R.prototype;document.addEventListener("pointermove",function(e){window.__mv++},true);
var ls=Storage.prototype.setItem;window.__ls=0;Storage.prototype.setItem=function(){window.__ls++;return ls.apply(this,arguments)}})()`;

describe.skipIf(!CHROME)("gauge card handle drag (CDP)", () => {
  it("200 handle-drag steps keep layouts per step, heap and nodes bounded and the page responsive", async () => {
    const soak = Number(process.env.GAUGE_SOAK_MS ?? 0);
    const b = await launch(1500, 1000);
    await b.send("Page.addScriptToEvaluateOnNewDocument", { source: HOOK });
    await b.send("Performance.enable"); 
    await b.send("Page.navigate", { url: `${base}/page` });
    const sel = `[data-card="limits.cloud:${process.env.GAUGE_CARD ?? "glm"}"]`;
    for (let i = 0; i < 60; i++) { await sleep(250); if (await b.ev<boolean>(`!!document.querySelector('${sel} .gauge')`)) break; }
    await sleep(500);
    const metrics = async () => {
      await b.send("HeapProfiler.collectGarbage");
      const m = Object.fromEntries(((await b.send("Performance.getMetrics")).result.metrics as { name: string; value: number }[]).map((x) => [x.name, x.value]));
      return { heap: m.JSHeapUsedSize, nodes: m.Nodes, layouts: m.LayoutCount, layoutMs: Math.round(m.LayoutDuration * 1000), recalc: m.RecalcStyleCount };
    };
    const pos = await b.ev<{ x: number; y: number }>(`(function(){document.querySelector('${sel}').scrollIntoView({block:"center"});var r=document.querySelector('${sel} .chandle').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    const mouse = (type: string, x: number, y: number) => b.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
    await mouse("mouseMoved", pos.x, pos.y);
    await mouse("mousePressed", pos.x, pos.y);
    const base0 = await metrics();
    const dirs: [number, number][] = [[0, 5], [0, -5], [5, 0], [-5, 0]];
    let x = pos.x, y = pos.y, n = 0;
    const t0 = Date.now();
    let lastPrint = t0;
    const readings: Record<string, number>[] = [];
    const step = async () => {
      // a block of 25 steps per direction, bouncing so the card grows and shrinks
      const d = dirs[Math.floor(n / 40) % 4]!;
      x = Math.max(200, Math.min(1400, x + d[0])); y = Math.max(150, Math.min(900, y + d[1]));
      await mouse("mouseMoved", x, y);
      n++;
    };
    if (soak) {
      while (Date.now() - t0 < soak) {
        await step();
        if (Date.now() - lastPrint >= 2000) {
          lastPrint = Date.now();
          const t1 = Date.now();
          const alive = await Promise.race([b.ev<number>("1").then(() => true), sleep(1000).then(() => false)]);
          const m = await metrics();
          console.log(JSON.stringify({ h: await b.ev<number>(`document.querySelector('${sel}').getBoundingClientRect().height`), w: await b.ev<number>(`document.querySelector('${sel}').getBoundingClientRect().width`), t: Math.round((lastPrint - t0) / 1000), n, ...m, ro: await b.ev<number>("window.__ro"), mv: await b.ev<number>("window.__mv"), ls: await b.ev<number>("window.__ls"), alive, pingMs: Date.now() - t1 }));
        }
      }
    } else {
      for (let i = 0; i < 200; i++) await step();
    }
    const after = await metrics();
    await mouse("mouseReleased", x, y);
    readings.push(after);
    const ro = await b.ev<number>("window.__ro"), mv = await b.ev<number>("window.__mv"), ls = await b.ev<number>("window.__ls");
    console.log(JSON.stringify({ cardH: await b.ev<number>(`document.querySelector('${sel}').getBoundingClientRect().height`), cardW: await b.ev<number>(`document.querySelector('${sel}').getBoundingClientRect().width`), steps: n, base: base0, after, ro, mv, ls, saves, layoutsPerStep: (after.layouts - base0.layouts) / n }));
    const t1 = Date.now();
    expect(await b.ev<number>("1+1")).toBe(2);
    expect(Date.now() - t1).toBeLessThan(1000);
    expect(mv).toBeGreaterThanOrEqual(n);
    // dials scale with width (inline-size container, no height feedback) and heights follow --uh: never a size container
    expect(["normal", "inline-size"]).toContain(await b.ev<string>(`getComputedStyle(document.querySelector('${sel} .gauges')).containerType`));
    expect(await b.ev<boolean>(`document.querySelector('${sel}').hasAttribute("data-uh")`)).toBe(true);
    expect((after.layouts - base0.layouts) / n).toBeLessThan(6);
    expect(after.heap - base0.heap).toBeLessThan(30e6);
    expect(after.nodes - base0.nodes).toBeLessThan(200);
    expect(ls).toBeLessThanOrEqual(2); // saves on release only, never per move
  }, 240_000);
});
