/**
 * Card height handle on the real cockpit page (headless Chromium over CDP): the registry editor's handle drags its card
 * and textarea taller, the height survives a reload, double-click fits it back, arrows step 16 px, a locked layout has
 * no handle. Skipped when no Chromium is installed.
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

const CARD = '#win-root [data-card="settings.registry-edit"]';

describe.skipIf(!CHROME)("card height handle (CDP)", () => {
  it("registry-edit handle: drag +120, reload keeps it, double-click fits, arrows +16, locked has none", async () => {
    const b = await launch(1500, 6000);
    const mouse = (type: string, x: number, y: number) => b.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
    const load = async () => {
      await b.send("Page.navigate", { url: `${base}/page` });
      for (let i = 0; i < 60; i++) { await sleep(250); if (await b.ev<boolean>(`!!document.querySelector(${JSON.stringify(CARD + " .chandle")})&&typeof Win!=="undefined"`)) break; }
      await sleep(1500);
    };
    const hs = () => b.ev<[number, number]>(`(function(){var c=document.querySelector(${JSON.stringify(CARD)});return[Math.round(c.getBoundingClientRect().height),Math.round(c.querySelector("textarea").getBoundingClientRect().height)]})()`);
    const handle = () => b.ev<[number, number]>(`(function(){var e=document.querySelector(${JSON.stringify(CARD + " .chandle")});e.scrollIntoView({block:"center"});var r=e.getBoundingClientRect();return[r.left+r.width/2,r.top+r.height/2]})()`);
    const drag = async (dy: number) => {
      const [x, y] = await handle();
      await mouse("mouseMoved", x, y); await mouse("mousePressed", x, y);
      for (let i = 1; i <= 8; i++) { await mouse("mouseMoved", x, y + (dy * i) / 8); await sleep(30); }
      await mouse("mouseReleased", x, y + dy); await sleep(600);
    };
    const key = async (k: string, vk: number) => {
      const p = { key: k, code: k, windowsVirtualKeyCode: vk };
      await b.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...p });
      await b.send("Input.dispatchKeyEvent", { type: "keyUp", ...p });
      await sleep(300);
    };

    await load();
    expect(await b.ev<string>(`document.querySelector(${JSON.stringify(CARD + " .chandle")}).title`)).toContain("double-click");
    const [c0, t0] = await hs();

    await drag(120);
    const [c1, t1] = await hs();
    expect(c1 - c0).toBe(120);
    expect(t1 - t0).toBe(120);

    await sleep(400);
    await load();
    const [c2, t2] = await hs();
    expect([c2, t2]).toEqual([c1, t1]);

    const [x, y] = await handle();
    await mouse("mouseMoved", x, y);
    await mouse("mousePressed", x, y); await mouse("mouseReleased", x, y);
    await mouse("mousePressed", x, y); await mouse("mouseReleased", x, y);
    await b.ev(`document.querySelector(${JSON.stringify(CARD + " .chandle")}).dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))`);
    await sleep(600);
    expect(await hs()).toEqual([c0, t0]);

    await b.ev(`document.querySelector(${JSON.stringify(CARD + " .chandle")}).focus()`);
    await key("ArrowDown", 40);
    const [c3] = await hs();
    expect(c3 - c0).toBe(16);

    await b.ev(`document.getElementById("lock").click()`);
    await sleep(300);
    expect(await b.ev<string>(`getComputedStyle(document.querySelector(${JSON.stringify(CARD + " .chandle")})).display`)).toBe("none");
    await b.ev(`document.querySelector(${JSON.stringify(CARD + " .chandle")}).focus()`);
    await key("ArrowDown", 40);
    expect((await hs())[0]).toBe(c3);
    await b.ev(`(function(){var h=document.querySelector(${JSON.stringify(CARD + " .chandle")});h.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,clientY:5}));document.dispatchEvent(new PointerEvent("pointermove",{bubbles:true,clientY:105}));document.dispatchEvent(new PointerEvent("pointerup",{bubbles:true}))})()`);
    await sleep(300);
    expect((await hs())[0], "locked drag inert").toBe(c3);
  }, 90000);
});
