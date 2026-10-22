/**
 * Card width share on the real cockpit page (headless Chromium over CDP): the header span button cycles a card through
 * auto, 1/4, 1/3, 1/2 and full inside its row, the share persists per device and survives a reload, and the button is
 * hidden while the layout is locked. Skipped when no Chromium is installed.
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
      await b.ev(`(function(){var k="pai.cockpit.win.v2",o=JSON.parse(localStorage.getItem(k)),ids=${JSON.stringify(ids)};var t=o.tree,i,at=-1;
        for(i=t.ch.length-1;i>=0;i--){var n=t.ch[i];if(n.k==="c"&&ids.indexOf(n.id)>=0){if(at>=0){t.ch.splice(at+1,0);}}}
        var rowCh=[];for(i=0;i<t.ch.length;i++){var m=t.ch[i];if(m.k==="c"&&ids.indexOf(m.id)>=0){if(at<0)at=i;rowCh.push(m)}}
        var keep=[],ks=[];for(i=0;i<t.ch.length;i++){var q=t.ch[i];if(q.k==="c"&&ids.indexOf(q.id)>=0){if(i===at){keep.push({k:"s",d:"r",ch:rowCh,sz:rowCh.map(function(){return 1/rowCh.length})});ks.push(t.sz[i])}}else{keep.push(q);ks.push(t.sz[i])}}
        t.ch=keep;t.sz=ks;localStorage.setItem(k,JSON.stringify(o))})()`);
      await load();
    };
    return { b, load, box, slack, rowOf, drag, arrange };
  }

  const rootW = (b: { ev<T>(s: string): Promise<T> }) => b.ev<number>(`document.querySelector("#win-root").getBoundingClientRect().width`);
  const wOf = (b: { ev<T>(s: string): Promise<T> }, id: string) => b.ev<number>(`document.querySelector(${JSON.stringify(sel(id))}).getBoundingClientRect().width`);
  const clickSpan = async (b: { ev<T>(s: string): Promise<T> }, id: string, n: number) => {
    for (let i = 0; i < n; i++) { await b.ev(`document.querySelector(${JSON.stringify(sel(id) + " .cspan")}).click()`); await sleep(500); }
  };

  it("1/2 in a row of three takes about half the row; full takes its own row; auto restores", async () => {
    const { b, arrange, rowOf } = await setup();
    await arrange(["pause", "daily", "speed"]);
    expect((await rowOf("pause")).length, "three in a row before").toBe(3);
    const w0 = await wOf(b, "pause");
    await clickSpan(b, "pause", 3);
    expect(await b.ev<string>(`document.querySelector(${JSON.stringify(sel("pause") + " .cspan")}).getAttribute("data-span")`)).toBe("1/2");
    const W = await rootW(b);
    const w1 = await wOf(b, "pause");
    console.log("READING " + JSON.stringify({ rootW: W, auto: w0, half: w1, row: await rowOf("pause") }));
    expect(Math.abs(w1 / W - 0.5)).toBeLessThan(0.03);
    await clickSpan(b, "pause", 1);
    expect(await rowOf("pause"), "full is alone in its row").toEqual(["pause"]);
    expect(Math.abs((await wOf(b, "pause")) / W - 1)).toBeLessThan(0.01);
    await clickSpan(b, "pause", 1);
    expect(Math.abs((await wOf(b, "pause")) - w0)).toBeLessThan(2);
    expect((await rowOf("pause")).length).toBe(3);
  }, 120000);

  it("the share survives a reload and is stored beside the card state", async () => {
    const { b, arrange, load } = await setup();
    await arrange(["pause", "daily", "speed"]);
    await clickSpan(b, "daily", 3);
    await sleep(900);
    expect(await b.ev<number>(`JSON.parse(localStorage.getItem("pai.cockpit.win.v2")).st.daily.sp`)).toBe(2);
    await load();
    const W = await rootW(b);
    expect(Math.abs((await wOf(b, "daily")) / W - 0.5)).toBeLessThan(0.03);
  }, 120000);

  it("a locked layout hides the span button", async () => {
    const { b, arrange } = await setup();
    await arrange(["pause", "daily", "speed"]);
    const disp = () => b.ev<string>(`getComputedStyle(document.querySelector(${JSON.stringify(sel("pause") + " .cspan")})).display`);
    expect(await disp()).not.toBe("none");
    await b.ev(`document.documentElement.classList.add("locked")`);
    expect(await disp()).toBe("none");
  }, 120000);

  it("the header buttons do not wrap at a narrow card", async () => {
    const { b, arrange } = await setup();
    await arrange(["pause", "daily", "speed"]);
    await clickSpan(b, "pause", 1);
    const ok = await b.ev<boolean>(`(function(){var h=document.querySelector(${JSON.stringify(sel("pause") + " .chead")}),t=h.getBoundingClientRect().top,b=h.querySelectorAll("button");for(var i=0;i<b.length;i++)if(b[i].offsetParent&&Math.abs(b[i].getBoundingClientRect().top-t)>14)return false;return true})()`);
    expect(ok).toBe(true);
  }, 120000);
});
