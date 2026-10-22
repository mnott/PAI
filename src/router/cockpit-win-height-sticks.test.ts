/**
 * User card height sticks on the real cockpit page (headless Chromium over CDP): a handle drag on a card in a row sets
 * one height for the whole row, a later drag on a sibling or a reload does not undo it, and a card is never rendered
 * much taller than its content unless it shares a row with a taller card or the user set the height. Skipped when no
 * Chromium is installed.
 */

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHROME, closeBrowser, launch, sleep } from "./cdp-browser.js";
import { cockpitHtml } from "./cockpit-page.js";
import { fixtureData, fixtureLimits, fixturePoolWithSlot, fixtureQueue, fixtureSystem } from "./cockpit-fixtures.js";

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
    if (url.startsWith("/cockpit/pool")) return json(fixturePoolWithSlot());
    if (url.startsWith("/cockpit/")) return json({});
    if (url.startsWith("/page")) { res.setHeader("content-type", "text/html"); return res.end(cockpitHtml()); }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await closeBrowser(); server?.close(); });

const sel = (id: string) => `#win-root [data-card="${id}"]`;

describe.skipIf(!CHROME)("user card height sticks (CDP)", () => {
  async function setup() {
    const b = await launch(1500, 6000);
    const mouse = (type: string, x: number, y: number) => b.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
    const load = async () => {
      await b.send("Page.navigate", { url: `${base}/page` });
      for (let i = 0; i < 60; i++) { await sleep(250); if (await b.ev<boolean>(`!!document.querySelector(${JSON.stringify(sel("pause") + " .chandle")})&&typeof Win!=="undefined"`)) break; }
      await sleep(1500);
    };
    const box = (id: string) => b.ev<number>(`Math.round(document.querySelector(${JSON.stringify(sel(id))}).getBoundingClientRect().height)`);
    /** Rendered height minus the height of the content the card holds (its body's children laid out at natural size). */
    const slack = (id: string) => b.ev<number>(`(function(){var c=document.querySelector(${JSON.stringify(sel(id))}),m=0,b=c.querySelector(".cbody")||c,i,k;for(i=0;i<b.children.length;i++){k=b.children[i].getBoundingClientRect();if(k.bottom-c.getBoundingClientRect().top>m)m=k.bottom-c.getBoundingClientRect().top}return Math.round(c.getBoundingClientRect().height-m)})()`);
    const rowOf = (id: string) => b.ev<string[]>(`(function(){var c=document.querySelector(${JSON.stringify(sel(id))}),t=Math.round(c.getBoundingClientRect().top);return Array.prototype.filter.call(document.querySelectorAll("#win-root [data-card]"),function(e){return Math.round(e.getBoundingClientRect().top)===t}).map(function(e){return e.getAttribute("data-card")})})()`);
    const handle = (id: string) => b.ev<[number, number]>(`(function(){var e=document.querySelector(${JSON.stringify(sel(id) + " .chandle")});e.scrollIntoView({block:"center"});var r=e.getBoundingClientRect();return[r.left+r.width/2,r.top+r.height/2]})()`);
    const drag = async (id: string, dy: number) => {
      const [x, y] = await handle(id);
      await mouse("mouseMoved", x, y); await mouse("mousePressed", x, y);
      for (let i = 1; i <= 8; i++) { await mouse("mouseMoved", x, y + (dy * i) / 8); await sleep(30); }
      await mouse("mouseReleased", x, y + dy); await sleep(600);
    };
    /** Re-save the layout with the cards `ids` side by side in one row (at the first one's band), then reload. */
    const arrange = async (ids: string[]) => {
      await load();
      await sleep(800);
      await b.ev(`(function(){var k="pai.cockpit.win.v2",o=JSON.parse(localStorage.getItem(k)),ids=${JSON.stringify(ids)};var t=o.tree,i,at=-1;
        for(i=t.ch.length-1;i>=0;i--){var n=t.ch[i];if(n.k==="c"&&ids.indexOf(n.id)>=0){if(at>=0){t.ch.splice(at+1,0);}}}
        var rowCh=[];for(i=0;i<t.ch.length;i++){var m=t.ch[i];if(m.k==="c"&&ids.indexOf(m.id)>=0){if(at<0)at=i;rowCh.push(m)}}
        var keep=[],ks=[];for(i=0;i<t.ch.length;i++){var q=t.ch[i];if(q.k==="c"&&ids.indexOf(q.id)>=0){if(i===at){keep.push({k:"s",d:"r",ch:rowCh,sz:rowCh.map(function(){return 1/rowCh.length})});ks.push(t.sz[i])}}else{keep.push(q);ks.push(t.sz[i])}}
        t.ch=keep;t.sz=ks;localStorage.setItem(k,JSON.stringify(o))})()`);
      await load();
    };
    return { b, load, box, slack, rowOf, drag, arrange };
  }

  it("reading: heights, slack and rows before and after", async () => {
    const { arrange, box, slack, rowOf, drag } = await setup();
    await arrange(["pause", "daily"]);
    const out: Record<string, unknown> = {};
    for (const id of ["pause", "daily"]) out[id + ":row"] = await rowOf(id);
    for (const id of ["pause", "daily"]) out[id + ":before"] = [await box(id), await slack(id)];
    await drag("pause", -150);
    for (const id of ["pause", "daily"]) out[id + ":afterPauseDrag"] = [await box(id), await slack(id)];
    await drag("daily", 120);
    for (const id of ["pause", "daily"]) out[id + ":afterDailyDrag"] = [await box(id), await slack(id)];
    console.log("READING " + JSON.stringify(out));
  }, 90000);

  it("a drag sets one height on the whole row; a later drag on a sibling does not undo it; reload keeps it", async () => {
    const { arrange, load, box, rowOf, drag } = await setup();
    await arrange(["pause", "daily"]);
    const row = await rowOf("pause");
    const sibs = row.filter((id) => id !== "pause");
    expect(sibs.length, "pause sits in a row").toBeGreaterThan(0);
    await drag("pause", 90);
    const h = await box("pause");
    for (const id of sibs) expect(await box(id), id).toBe(h);
    await drag(sibs[0], 60);
    const h2 = await box(sibs[0]);
    expect(h2).toBe(h + 60);
    for (const id of row) expect(await box(id), id).toBe(h2);
    await sleep(400);
    await load();
    for (const id of row) expect(await box(id), "after reload " + id).toBe(h2);
  }, 120000);

  it("a user height survives a width change and a sibling resize in the row", async () => {
    const { b, arrange, box, rowOf, drag } = await setup();
    await arrange(["pause", "daily"]);
    await drag("pause", -100);
    const h = await box("pause");
    await drag("daily", 80);
    const h2 = await box("daily");
    expect(h2).toBe(h + 80);
    expect(await box("pause")).toBe(h2);
    for (const w of [900, 1500, 1100]) {
      await b.send("Emulation.setDeviceMetricsOverride", { width: w, height: 6000, deviceScaleFactor: 1, mobile: false });
      await sleep(900);
      const row = await rowOf("pause");
      if (row.length > 1) { expect(await box("pause"), "width " + w).toBe(h2); expect(await box("daily"), "width " + w).toBe(h2); }
    }
  }, 120000);

  it("a card alone in its row is resized alone and keeps the height when another card is resized", async () => {
    const { load, box, rowOf, drag } = await setup();
    await load();
    const solo = (await Promise.all(["pause", "daily", "speed", "sessions", "runs"].map(async (id) => [id, await rowOf(id)] as const))).find(([, r]) => r.length === 1);
    if (!solo) return;
    const [id] = solo;
    const other = id === "runs" ? "speed" : "runs";
    await drag(id, 70);
    const h = await box(id);
    await drag(other, 50);
    expect(await box(id)).toBe(h);
  }, 120000);

  it("no card is taller than its content by more than 24 px unless its row shares a height", async () => {
    const { b, load, slack } = await setup();
    await load();
    const ids = await b.ev<string[]>(`Array.prototype.map.call(document.querySelectorAll("#win-root [data-card]:not([data-depth]):not([data-type=chart])"),function(e){return e.getAttribute("data-card")})`);
    const bad: string[] = [];
    for (const id of ids) {
      const row = await b.ev<number>(`(function(){var c=document.querySelector(${JSON.stringify(sel(id))}),t=Math.round(c.getBoundingClientRect().top);return Array.prototype.filter.call(document.querySelectorAll("#win-root [data-card]"),function(e){return Math.round(e.getBoundingClientRect().top)===t}).length})()`);
      const s = await slack(id);
      if (row === 1 && s > 24) bad.push(`${id}:${s}`);
    }
    expect(bad).toEqual([]);
  }, 120000);
});
