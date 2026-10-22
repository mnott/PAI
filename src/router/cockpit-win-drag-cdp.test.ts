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

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHROME, closeBrowser, launch, sleep } from "./cdp-browser.js";
import { cockpitHtml } from "./cockpit-page.js";
import { fixtureData, fixtureLimits, fixturePool, fixtureQueue, fixtureSystem } from "./cockpit-fixtures.js";

let server: Server;
let base = "";

beforeAll(async () => {
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
afterAll(async () => { await closeBrowser(); server?.close(); });

async function launchDrag(w: number, h: number) {
  const b = await launch(w, h);
  const mouse = (type: string, x: number, y: number) => b.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
  return { ...b, mouse };
}

type Rects = Record<string, [number, number, number, number]>;
interface Snap { tree: string; pool: string; r: Rects }
const SNAP = `(function(){var o={};document.querySelectorAll("#win-root .card").forEach(function(c){var r=c.getBoundingClientRect();o[c.dataset.card]=[Math.round((r.left+scrollX)*100)/100,Math.round((r.top+scrollY)*100)/100,Math.round(r.width*100)/100,Math.round(r.height*100)/100]});return{tree:JSON.stringify(Win.state().kids.kpis),pool:JSON.stringify(Win.state().kids.pool),r:o}})()`;
const rectDiffs = (a: Snap, b: Snap) => Object.keys({ ...a.r, ...b.r }).filter((k) => k.startsWith("kpis")).filter((k) => JSON.stringify(a.r[k]) !== JSON.stringify(b.r[k]));

describe.skipIf(!CHROME)("cockpit drag and drop with real pointer events (CDP)", () => {
  it("E1 right-of and E2 bottom-of work; E2b a drop with no room and E3 an outside target are refused", async () => {
    const b = await launchDrag(1500, 1000);
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
