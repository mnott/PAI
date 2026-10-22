/**
 * Card width share on the real cockpit page (headless Chromium over CDP): a stored width share (auto, 1/4, 1/3, 1/2, full) sizes a card inside its row
 * and survives a reload, there is no header width button, and double-clicking the handle resets the width. Skipped when no Chromium is installed.
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

describe.skipIf(!CHROME)("card width share (CDP)", () => {
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
      // the cards live in groups: take them out of every tree (root and group kids), then lay them side by side in one row at the end of the root column
      await b.ev(`(function(){var k="pai.cockpit.win.v2",o=JSON.parse(localStorage.getItem(k)),ids=${JSON.stringify(ids)},row=[];
        function strip(n){if(n.k!=="s")return;var ch=[],sz=[],i;for(i=0;i<n.ch.length;i++){var q=n.ch[i];if(q.k==="c"&&ids.indexOf(q.id)>=0){row.push(q);continue}strip(q);ch.push(q);sz.push(n.sz[i])}n.ch=ch;n.sz=sz}
        strip(o.tree);for(var g in o.kids)strip(o.kids[g]);
        row.sort(function(x,y){return ids.indexOf(x.id)-ids.indexOf(y.id)});
        o.tree.ch.push({k:"s",d:"r",ch:row,sz:row.map(function(){return 1/row.length})});o.tree.sz.push(0.1);
        localStorage.setItem(k,JSON.stringify(o))})()`);
      await load();
    };
    return { b, load, box, slack, rowOf, drag, arrange };
  }

  const rootW = (b: { ev<T>(s: string): Promise<T> }) => b.ev<number>(`document.querySelector("#win-root").getBoundingClientRect().width`);
  const wOf = (b: { ev<T>(s: string): Promise<T> }, id: string) => b.ev<number>(`document.querySelector(${JSON.stringify(sel(id))}).getBoundingClientRect().width`);
  /** Store a width share (st.sp divisor) for a card and reload: the state the handle drag writes. */
  const setSp = async (b: { ev<T>(s: string): Promise<T> }, load: () => Promise<void>, id: string, sp: number) => {
    await b.ev(`(function(){var k="pai.cockpit.win.v2",o=JSON.parse(localStorage.getItem(k));o.st=o.st||{};(o.st[${JSON.stringify(id)}]=o.st[${JSON.stringify(id)}]||{}).sp=${sp};localStorage.setItem(k,JSON.stringify(o))})()`);
    await load();
  };

  it("a stored 1/2 in a row of three takes about half the row; full takes its own row; clearing it restores auto", async () => {
    const { b, arrange, rowOf, load } = await setup();
    await arrange(["pause", "daily", "speed"]);
    expect((await rowOf("pause")).length, "three in a row before").toBe(3);
    const w0 = await wOf(b, "pause");
    await setSp(b, load, "pause", 2);
    const W = await rootW(b);
    const w1 = await wOf(b, "pause");
    console.log("READING " + JSON.stringify({ rootW: W, auto: w0, half: w1, row: await rowOf("pause") }));
    expect(Math.abs(w1 / W - 0.5)).toBeLessThan(0.03);
    await setSp(b, load, "pause", 1);
    expect(await rowOf("pause"), "full is alone in its row").toEqual(["pause"]);
    expect(Math.abs((await wOf(b, "pause")) / W - 1)).toBeLessThan(0.01);
  }, 120000);

  it("the share survives a reload and is stored beside the card state", async () => {
    const { b, arrange, load } = await setup();
    await arrange(["pause", "daily", "speed"]);
    await setSp(b, load, "daily", 2);
    expect(await b.ev<number>(`JSON.parse(localStorage.getItem("pai.cockpit.win.v2")).st.daily.sp`)).toBe(2);
    const W = await rootW(b);
    expect(Math.abs((await wOf(b, "daily")) / W - 0.5)).toBeLessThan(0.03);
  }, 120000);

  it("no card header carries a width button; the handle has the resize tooltip", async () => {
    const { b, arrange } = await setup();
    await arrange(["pause", "daily", "speed"]);
    expect(await b.ev<number>(`document.querySelectorAll("#win-root .cspan,#win-root [data-act=span]").length`)).toBe(0);
    expect(await b.ev<string>(`document.querySelector(${JSON.stringify(sel("pause") + " .chandle")}).title`)).toBe("drag to resize \u00b7 double-click to reset");
  }, 120000);

  it("double-clicking the handle resets the stored width", async () => {
    const { b, arrange, load } = await setup();
    await arrange(["pause", "daily", "speed"]);
    await setSp(b, load, "pause", 2);
    await b.ev(`document.querySelector(${JSON.stringify(sel("pause") + " .chandle")}).dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))`);
    await sleep(900);
    expect(await b.ev<boolean>(`!(JSON.parse(localStorage.getItem("pai.cockpit.win.v2")).st.pause||{}).sp`)).toBe(true);
  }, 120000);
});
