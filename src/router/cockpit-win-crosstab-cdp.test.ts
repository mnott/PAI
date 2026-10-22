/**
 * Two cockpit tabs in one Chrome profile share localStorage. Tab A moves a card: tab B shows the move within 1 s without a reload,
 * and when B is closed (pagehide flush) A's layout is still the moved one after a reload. Skipped without Chromium.
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

const FIRST = `Win.state().tree.ch[0].id`;
const SAVED_FIRST = `(function(){var v=localStorage.getItem("pai.cockpit.win.v2");return v?JSON.parse(v).tree.ch[0].id:null})()`;
const MOVE = `(function(){var g=document.querySelector("#win-root .cgrip");g.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}));window.dispatchEvent(new PointerEvent("pointerup"));var t=JSON.parse(JSON.stringify(Win.state().tree));t.ch.push(t.ch.shift());t.sz.push(t.sz.shift());Win.apply("",t);return Win.state().tree.ch[0].id})()`;

async function ready(b: Awaited<ReturnType<typeof launch>>, expr = "window") {
  for (let i = 0; i < 60; i++) { await sleep(250); if (await b.ev<boolean>(`typeof Win!=="undefined"&&!!document.querySelector('#win-root .card')&&!!(${expr}&&${expr}.Win)`)) break; }
  await sleep(1500);
}

describe.skipIf(!CHROME)("cockpit layout across two tabs", () => {
  it("a move in tab A shows in tab B within 1 s, and B closing does not write the old layout back", async () => {
    const b = await launch(1500, 1000);
    await b.send("Page.navigate", { url: `${base}/page` });
    await ready(b);
    // an explicit saved layout first, so both tabs start from the same stored tree
    const first0 = await b.ev<string>(FIRST);
    await b.ev(`Win.flush();(function(){var t=JSON.parse(JSON.stringify(Win.state().tree));Win.apply("",t)})();Win.flush()`);
    // a real click is the user gesture that lets the page open the second tab (same origin and profile: shared localStorage)
    await b.ev(`(function(){var a=document.createElement("button");a.id="openB";a.textContent="open";a.style.cssText="position:fixed;left:0;top:0;width:80px;height:40px;z-index:99999";a.onclick=function(){window.__B=window.open(location.href,"tabB")};document.body.appendChild(a)})()`);
    for (const type of ["mousePressed", "mouseReleased"]) await b.send("Input.dispatchMouseEvent", { type, x: 20, y: 20, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
    for (let i = 0; i < 40 && !(await b.ev<boolean>(`!!window.__B`)); i++) await sleep(100);
    expect(await b.ev<boolean>(`!!window.__B`), "second tab opened").toBe(true);
    await ready(b, "window.__B");
    expect(await b.ev<string>(`window.__B.Win.state().tree.ch[0].id`)).toBe(first0);
    const moved = await b.ev<string>(MOVE);
    expect(moved).not.toBe(first0);
    let shown = "";
    const t0 = Date.now();
    while (Date.now() - t0 < 1000 && shown !== moved) { await sleep(50); shown = await b.ev<string>(`window.__B.Win.state().tree.ch[0].id`); }
    expect(shown, "tab B adopted A's move").toBe(moved);
    // B leaves: its pagehide flush must not overwrite A's layout
    await b.ev(`window.__B.dispatchEvent(new Event("pagehide"));window.__B.close();1`);
    await sleep(600);
    expect(await b.ev<string>(SAVED_FIRST)).toBe(moved);
    await b.send("Page.navigate", { url: `${base}/page` });
    await ready(b);
    expect(await b.ev<string>(FIRST)).toBe(moved);
  }, 120_000);
  it("a save pending in tab B is dropped when tab A saved a newer layout", async () => {
    const b = await launch(1500, 1000);
    await b.send("Page.navigate", { url: `${base}/page` });
    await ready(b);
    await b.ev(`(function(){var a=document.createElement("button");a.style.cssText="position:fixed;left:0;top:0;width:80px;height:40px;z-index:99999";a.onclick=function(){window.__B=window.open(location.href,"tabB")};document.body.appendChild(a)})()`);
    for (const type of ["mousePressed", "mouseReleased"]) await b.send("Input.dispatchMouseEvent", { type, x: 20, y: 20, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
    await ready(b, "window.__B");
    // B changes its layout (save pending in the 150 ms debounce), then A saves a newer one before it fires
    await b.ev(`(function(){var B=window.__B,g=B.document.querySelector("#win-root .cgrip");g.dispatchEvent(new B.PointerEvent("pointerdown",{bubbles:true}));B.dispatchEvent(new B.PointerEvent("pointerup"));var t=JSON.parse(JSON.stringify(B.Win.state().tree));t.ch.unshift(t.ch.pop());t.sz.unshift(t.sz.pop());B.Win.apply("",t)})()`);
    await sleep(20);
    const moved = await b.ev<string>(MOVE);
    await b.ev(`Win.flush()`);
    await sleep(500);
    expect(await b.ev<string>(SAVED_FIRST), "B's pending save did not overwrite A's newer layout").toBe(moved);
    await b.ev(`window.__B.close();1`);
  }, 120_000);
});
