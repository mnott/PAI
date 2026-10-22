/**
 * Layout lock on the real cockpit page (headless Chromium over CDP): locked = no drag, no keys, no minimize, no gutter drag,
 * no save; card header actions stay; the lock is per browser (localStorage) and survives a reload; other tabs follow.
 * Skipped when no Chromium is installed.
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

const TREE = `JSON.stringify(Win.state().tree)+JSON.stringify(Win.state().kids)`;

describe.skipIf(!CHROME)("cockpit layout lock (CDP)", () => {
  it("locked blocks every layout edit, unlocked drags, persists, follows other tabs", async () => {
    const b = await launch(1500, 1000);
    const mouse = (type: string, x: number, y: number) => b.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
    const key = async (k: string, vk: number) => {
      const p = { key: k, code: k === " " ? "Space" : k, windowsVirtualKeyCode: vk };
      await b.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...p });
      if (k === "Enter") await b.send("Input.dispatchKeyEvent", { type: "char", ...p, text: "\r" });
      await b.send("Input.dispatchKeyEvent", { type: "keyUp", ...p });
      await sleep(150);
    };
    const load = async () => {
      await b.send("Page.navigate", { url: `${base}/page` });
      for (let i = 0; i < 60; i++) { await sleep(250); if (await b.ev<boolean>(`!!document.querySelector('#win-root [data-card="kpis.errors"] .cgrip')&&typeof Win!=="undefined"&&!!document.getElementById("lock")`)) break; }
      await sleep(1200);
    };
    const center = (sel: string) => b.ev<[number, number]>(`(function(){var e=document.querySelector(${JSON.stringify(sel)});e.scrollIntoView({block:"center"});var r=e.getBoundingClientRect();return[r.left+r.width/2,r.top+r.height/2]})()`);
    const dragReq = async (fx = 0.8) => {
      const [gx, gy] = await center('#win-root [data-card="kpis.requests"] .cgrip');
      const t = await b.ev<[number, number]>(`(function(){var r=document.querySelector('#win-root [data-card="kpis.errors"]').getBoundingClientRect();return[r.left+r.width*${fx},r.top+r.height/2]})()`);
      await mouse("mouseMoved", gx, gy); await mouse("mousePressed", gx, gy);
      for (let i = 1; i <= 12; i++) { await mouse("mouseMoved", gx + ((t[0] - gx) * i) / 12, gy + ((t[1] - gy) * i) / 12); await sleep(30); }
      await mouse("mouseReleased", t[0], t[1]); await sleep(700);
    };
    const saved = () => b.ev<string | null>(`localStorage.getItem("pai.cockpit.win.v2")`);

    await load();
    expect(await b.ev<string>(`document.getElementById("lock").title`), "lock button titled").toBe("lock layout");
    expect(await b.ev<string>(`document.getElementById("lock").getAttribute("aria-pressed")`)).toBe("false");
    const acts = await b.ev<number>(`document.querySelectorAll(".chead .cbtn:not(.cmin)").length`);

    // unlocked: drag works
    const t0 = await b.ev<string>(TREE);
    await dragReq();
    const t1 = await b.ev<string>(TREE);
    expect(t1, "unlocked drag changes the tree").not.toBe(t0);

    // lock
    await b.ev(`document.getElementById("lock").click()`);
    await sleep(200);
    expect(await b.ev<string>(`localStorage.getItem("pai.cockpit.lock")`)).toBe("1");
    expect(await b.ev<string>(`document.getElementById("lock").title`)).toBe("unlock layout");
    expect(await b.ev<string>(`document.getElementById("lock").getAttribute("aria-pressed")`)).toBe("true");
    await b.ev(`window.scrollTo(0,0)`);
    await sleep(900);
    const s0 = await saved();
    const L0 = await b.ev<string>(TREE);
    expect(await b.ev<number>(`Array.from(document.querySelectorAll(".cgrip,.cmin,.wgutter")).filter(function(e){return e.offsetParent}).length`), "grips, minimize buttons, gutters hidden").toBe(0);
    expect(await b.ev<number>(`document.querySelectorAll(".chead .cbtn:not(.cmin)").length`), "card header actions still present").toBe(acts);
    expect(acts).toBeGreaterThan(0);
    await dragReq();
    expect(await b.ev<string>(TREE), "locked mouse drag changes nothing").toBe(L0);
    await b.ev(`document.querySelector('#win-root [data-card="kpis.input"] .cgrip').focus()`);
    await key("Enter", 13);
    await key("ArrowRight", 39);
    await key("Enter", 13);
    expect(await b.ev<string>(TREE), "locked Enter/arrows on the grip change nothing").toBe(L0);
    expect(await b.ev<string>(`document.querySelector('#win-root [data-card="kpis.input"] .cgrip').getAttribute("aria-pressed")`)).toBe("false");
    await b.ev(`Win.toggleMin("kpis.input")`);
    expect(await b.ev<string>(TREE + `+JSON.stringify(Win.state().st)`)).toBe(L0 + await b.ev<string>(`JSON.stringify(Win.state().st)`));
    expect(await b.ev<string>(TREE), "still unchanged").toBe(L0);
    expect(await saved(), "no layout save while locked").toBe(s0);

    // persists across reload
    await load();
    expect(await b.ev<boolean>(`document.documentElement.classList.contains("locked")`), "lock persists").toBe(true);
    expect(await b.ev<string>(`document.getElementById("lock").getAttribute("aria-pressed")`)).toBe("true");

    // a second tab (same-origin frame) unlocks: this page follows
    await b.ev(`new Promise(function(r){var f=document.createElement("iframe");f.src="/nothing";f.onload=function(){f.contentWindow.localStorage.setItem("pai.cockpit.lock","0");setTimeout(r,300)};document.body.appendChild(f)})`);
    expect(await b.ev<boolean>(`document.documentElement.classList.contains("locked")`), "other tab unlocks").toBe(false);
    expect(await b.ev<string>(`document.getElementById("lock").title`)).toBe("lock layout");

    // unlocked again: drag works
    const u0 = await b.ev<string>(TREE);
    await dragReq(0.1);
    expect(await b.ev<string>(TREE), "drag works after unlock").not.toBe(u0);
  }, 120_000);
});
