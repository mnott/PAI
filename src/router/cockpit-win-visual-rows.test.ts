/**
 * Resize follows the visual rows (headless Chromium over CDP): cards on one rendered line resize together, a card stacked under
 * another resizes alone, a stack's leftover height goes to its chart (not its table), a handle drag pushes the next section down
 * instead of overlapping it, and hovering a handle outlines exactly the cards that resize with it. Skipped when no Chromium is installed.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHROME, closeBrowser, launch, sleep } from "./cdp-browser.js";
import { cockpitHtml } from "./cockpit-page.js";
import { fixtureData, fixtureLimits, fixturePoolWithSlot, fixtureQueue, fixtureSystem } from "./cockpit-fixtures.js";
let server: Server; let base = "";
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
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await closeBrowser(); server?.close(); });
const ARR = `(function(){var k="pai.cockpit.win.v2",o=JSON.parse(localStorage.getItem(k)),t=o.tree,i;
 function col(a){return{k:"s",d:"c",ch:a.map(function(x){return{k:"c",id:x}}),sz:a.map(function(){return 1/a.length})}}
 var keep=[],ks=[];
 for(i=0;i<t.ch.length;i++){var n=t.ch[i];
  if(n.id==="daily"||n.id==="speed"||n.id==="pause")continue;
  if(n.id==="tokens-group"){delete o.kids["tokens-group"];keep.push({k:"s",d:"r",ch:[col(["tokens","pause"]),{k:"c",id:"daily"},{k:"c",id:"speed"}],sz:[1/3,1/3,1/3]});ks.push(400);continue}
  keep.push(n);ks.push(t.sz[i])}
 t.ch=keep;t.sz=ks;delete o.auto;localStorage.setItem(k,JSON.stringify(o))})()`;
const sel = (id: string) => `#win-root [data-card="${id}"]`;

describe.skipIf(!CHROME)("resize follows the visual rows (CDP)", () => {
  async function setup(w: number) {
    const b = await launch(w, 6000);
    const load = async () => {
      await b.send("Page.navigate", { url: `${base}/page` });
      for (let i = 0; i < 60; i++) { await sleep(250); if (await b.ev<boolean>(`typeof Win!=="undefined"&&!!document.querySelector("#win-root [data-card=pause] .chandle")`)) break; }
      await sleep(1500);
    };
    await load(); await b.ev(ARR); await load();
    const mouse = (type: string, x: number, y: number) => b.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
    const rect = (id: string) => b.ev<{ top: number; h: number }>(`(function(){var r=document.querySelector(${JSON.stringify(sel(id))}).getBoundingClientRect();return{top:Math.round(r.top+scrollY),h:Math.round(r.height)}})()`);
    const handle = (id: string) => b.ev<[number, number]>(`(function(){var e=document.querySelector(${JSON.stringify(sel(id) + " .chandle")});e.scrollIntoView({block:"center"});var r=e.getBoundingClientRect();return[r.left+r.width/2,r.top+r.height/2]})()`);
    const outlined = () => b.ev<string[]>(`Array.prototype.map.call(document.querySelectorAll("#win-root .card.rz"),function(e){return e.getAttribute("data-card")}).sort()`);
    return { b, rect, handle, mouse, outlined };
  }

  for (const w of [1100, 620]) {
    it(`${w}px: a card resizes with the cards on its rendered line only, and the outline marks them`, async () => {
      const { rect, handle, mouse, outlined } = await setup(w);
      const wide = w >= 1000;
      const [x, y] = await handle("daily");
      await mouse("mouseMoved", x, y);
      expect(await outlined()).toEqual(wide ? ["daily", "speed"] : ["daily"]);
      await mouse("mouseMoved", 5, 5);
      expect(await outlined()).toEqual([]);
      const before = { tokens: (await rect("tokens")).h, pause: (await rect("pause")).h, speed: (await rect("speed")).h };
      await mouse("mouseMoved", x, y); await mouse("mousePressed", x, y);
      for (let i = 1; i <= 6; i++) { await mouse("mouseMoved", x, y + 20 * i); await sleep(40); }
      expect(await outlined()).toEqual(wide ? ["daily", "speed"] : ["daily"]);
      await mouse("mouseReleased", x, y + 120); await sleep(500);
      const after = { tokens: (await rect("tokens")).h, pause: (await rect("pause")).h, speed: (await rect("speed")).h, daily: (await rect("daily")).h };
      if (!wide) expect(after.tokens).toBe(before.tokens);
      expect(after.pause).toBe(before.pause);
      if (wide) expect(after.speed).toBe(after.daily); else expect(after.speed).toBe(before.speed);
      const [px, py] = await handle("pause");
      await mouse("mouseMoved", px, py);
      expect(await outlined()).toEqual(["pause"]);
    }, 120000);

    it(`${w}px: a stacked card resizes alone; mid-drag nothing overlaps the next section`, async () => {
      const { rect, handle, mouse } = await setup(w);
      const before = { tokens: (await rect("tokens")).h, daily: (await rect("daily")).h, speed: (await rect("speed")).h };
      const [x, y] = await handle("pause");
      await mouse("mouseMoved", x, y); await mouse("mousePressed", x, y);
      for (let i = 1; i <= 6; i++) {
        await mouse("mouseMoved", x, y + 40 * i); await sleep(60);
        const p = await rect("pause"), s = await rect("sessions"), d = await rect("daily");
        expect(p.top + p.h).toBeLessThanOrEqual(s.top);
        expect(d.top + d.h).toBeLessThanOrEqual(s.top);
      }
      await mouse("mouseReleased", x, y + 240); await sleep(500);
      if (!wide(w)) expect((await rect("tokens")).h).toBe(before.tokens);
      expect((await rect("speed")).h).toBe(wide(w) ? (await rect("daily")).h : before.speed);
      expect((await rect("pause")).h).toBeGreaterThan(300);
    }, 120000);
  }

  it("1100px: the stack's leftover height goes to the chart, the table keeps its content height", async () => {
    const { b, rect } = await setup(1100);
    const content = await b.ev<number>(`(function(){var c=document.querySelector(${JSON.stringify(sel("pause"))}),b=c.querySelector(".cbody")||c,m=0,i,k,top=c.getBoundingClientRect().top;for(i=0;i<b.children.length;i++){k=b.children[i].getBoundingClientRect();if(k.bottom-top>m)m=k.bottom-top}return Math.round(m)})()`);
    const p = await rect("pause"), t = await rect("tokens"), d = await rect("daily");
    expect(p.h).toBeLessThanOrEqual(content + 24);
    expect(t.h + 8 + p.h).toBeGreaterThanOrEqual(d.h - 1);
  }, 120000);
});
function wide(w: number) { return w >= 1000; }
