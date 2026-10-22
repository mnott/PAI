/**
 * Spec 4 touch on the real cockpit page, CDP touch events (Input.dispatchTouchEvent), viewports 390 and 822:
 *   T1 a touch on a grip released before PRESS_MS does not grab, the page pans    T2 a touch held past PRESS_MS grabs, shows the drop zone, lifting drops
 *   T3 a touch-move on a card body pans the page, never drags    T4 a gutter drags by touch    T5 the minimize button works by tap
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


describe.skipIf(!CHROME)("cockpit touch, spec 4 (CDP touch events)", () => {
  for (const W of [390, 822]) {
    it(`T1-T5 at ${W}px`, async () => {
      const b = await launch(W, 800);
      await b.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      await b.send("Page.navigate", { url: `${base}/page` });
      for (let i = 0; i < 60; i++) { await sleep(250); if (await b.ev<boolean>(`!!document.querySelector('#win-root [data-card="kpis.errors"] .cgrip')&&typeof Win!=="undefined"`)) break; }
      await sleep(1500);
      const tch = (type: string, x = 0, y = 0) => b.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }] });
      const tree = () => b.ev<string>(`(JSON.stringify(Win.state().tree)+JSON.stringify(Win.state().kids)).replace(/"sz":\\[[^\\]]*\\]/g,"")`);
      const info = () => b.ev<{ sy: number; drag: boolean; dd: boolean }>(`({sy:scrollY,dd:!!document.querySelector(".dropind"),drag:!!document.querySelector(".card.dragging")})`);
      const top = () => b.ev(`window.scrollTo(0,0)`);
      const rect = (sel: string) => b.ev<{ x: number; y: number; r: { x: number; y: number; width: number; height: number } }>(`(function(){var e=document.querySelector(${JSON.stringify(sel)});var r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,r:r.toJSON()}})()`);
      expect(await b.ev<boolean>(`document.documentElement.scrollHeight>innerHeight+200`), "page scrolls").toBe(true);

      // T1: short touch on a grip, then a vertical pan: no grab, the page scrolls, nothing stuck
      await top(); await sleep(200);
      let g = await rect('[data-card="kpis.requests"] .cgrip');
      await b.ev(`window.scrollTo(0,0)`); g = await rect('[data-card="kpis.requests"] .cgrip');
      const t0 = await tree(); const y0 = (await info()).sy;
      await tch("touchStart", g.x, g.y); await sleep(100);
      const mid = await info();
      for (let k = 1; k <= 8; k++) { await tch("touchMove", g.x, g.y - k * 20); await sleep(30); }
      await tch("touchEnd"); await sleep(500);
      const t1 = await info();
      expect(mid.drag || mid.dd, "T1 not grabbed").toBe(false);
      expect(t1.drag || t1.dd, "T1 nothing stuck").toBe(false);
      expect(await tree(), "T1 tree untouched").toBe(t0);
      expect(t1.sy, "T1 page panned from the grip").toBeGreaterThan(y0);
      await tch("touchStart", g.x, g.y); await sleep(100); await tch("touchEnd"); await sleep(300);
      expect((await info()).drag, "T1 a tap leaves nothing stuck").toBe(false);

      // T3: a touch-move on a card body pans the page
      await top(); await sleep(200);
      const body = await b.ev<{ x: number; y: number }>(`(function(){var cs=Array.from(document.querySelectorAll("#win-root .card .cbody")).filter(function(c){var r=c.getBoundingClientRect();return r.height>40&&r.y>20&&r.y<500});var r=cs[cs.length-1].getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+Math.min(r.height/2,30)}})()`);
      const b0 = await tree();
      await tch("touchStart", body.x, body.y); await sleep(600);
      for (let k = 1; k <= 8; k++) { await tch("touchMove", body.x, body.y - k * 25); await sleep(30); }
      const bm = await info();
      await tch("touchEnd"); await sleep(500);
      expect(bm.drag || bm.dd, "T3 never drags").toBe(false);
      expect((await info()).sy, "T3 page scrolled").toBeGreaterThan(0);
      expect(await tree(), "T3 tree untouched").toBe(b0);

      // T2: held past PRESS_MS, the grip grabs; moving shows the drop zone; lifting drops (a refusal shows the bad indicator and keeps the tree)
      await top(); await sleep(200);
      const src = await rect('[data-card="kpis.requests"] .cgrip');
      await b.ev(`window.scrollTo(0,0)`);
      const s2 = await rect('[data-card="kpis.requests"] .cgrip');
      const dst = await b.ev<{ x: number; y: number; width: number; height: number }>(`document.querySelector('[data-card="kpis.input"]').getBoundingClientRect().toJSON()`);
      void src;
      const d0 = await tree();
      await tch("touchStart", s2.x, s2.y); await sleep(650);
      const tx = dst.x + dst.width - 6, ty = dst.y + dst.height / 2;
      for (let k = 1; k <= 10; k++) { await tch("touchMove", s2.x + ((tx - s2.x) * k) / 10, s2.y + ((ty - s2.y) * k) / 10); await sleep(40); }
      const ind = await b.ev<{ zone: string; bad: boolean } | null>(`(function(){var d=document.querySelector(".dropind");return d?{zone:d.dataset.zone,bad:d.classList.contains("bad")}:null})()`);
      expect(ind, "T2 drop zone shown").not.toBeNull();
      expect((await info()).drag, "T2 card is dragging").toBe(true);
      expect((await info()).sy, "T2 the page does not pan under the drag").toBe(0);
      await tch("touchEnd"); await sleep(600);
      const after = await info();
      expect(after.drag || after.dd, "T2 nothing stuck after the drop").toBe(false);
      if (ind!.bad) expect(await tree(), "T2 refusal keeps the tree").toBe(d0);
      else expect(await tree(), "T2 drop changes the tree").not.toBe(d0);

      // T4: a gutter drags by touch
      await top(); await sleep(300);
      const gut = await b.ev<{ x: number; y: number; axis: string }>(`(function(){var gs=Array.from(document.querySelectorAll(".wgutter")).filter(function(x){var r=x.getBoundingClientRect();return r.width>0&&r.height>0&&r.y>0&&r.y<700});var x=gs[0],r=x.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,axis:x.dataset.axis}})()`);
      const sizes = () => b.ev<string>(`JSON.stringify(Array.from(document.querySelectorAll("#win-root .card")).map(function(c){var r=c.getBoundingClientRect();return[Math.round(r.width),Math.round(r.height)]}))`);
      const w0 = await sizes();
      await tch("touchStart", gut.x, gut.y); await sleep(50);
      for (let k = 1; k <= 8; k++) { await tch("touchMove", gut.axis === "x" ? gut.x + k * 5 : gut.x, gut.axis === "y" ? gut.y + k * 5 : gut.y); await sleep(30); }
      expect(await sizes(), "T4 resizes while dragging").not.toBe(w0);
      await tch("touchEnd"); await sleep(500);
      expect(await sizes(), "T4 resize kept after lifting").not.toBe(w0);
      expect((await info()).sy, "T4 page did not pan").toBe(0);

      // T5: tap on minimize toggles
      await top(); await sleep(300);
      const mn = await rect('[data-card="kpis.input"] .cmin');
      await b.ev(`window.scrollTo(0,0)`);
      const m = await rect('[data-card="kpis.input"] .cmin');
      void mn;
      const exp = () => b.ev<string>(`document.querySelector('[data-card="kpis.input"] .cmin').getAttribute("aria-expanded")`);
      expect(await exp()).toBe("true");
      await tch("touchStart", m.x, m.y); await sleep(60); await tch("touchEnd"); await sleep(500);
      expect(await exp(), "T5 tap minimizes").toBe("false");
      await tch("touchStart", m.x, m.y); await sleep(60); await tch("touchEnd"); await sleep(500);
      expect(await exp(), "T5 tap restores").toBe("true");
    }, 120_000);
  }
});
