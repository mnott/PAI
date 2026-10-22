/**
 * The registry editor's Validate and Save in a real page against slow pollers: a click's POST must not queue behind the
 * polls (the browser allows 6 connections per host; slow feeds used to hold them all), and a save must trigger a bounded
 * number of requests (the write, the registry text, the backups, the two refreshes). Skipped when no Chromium is installed.
 */

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHROME, closeBrowser, launch, sleep } from "./cdp-browser.js";
import { cockpitHtml } from "./cockpit-page.js";
import { fixtureData, fixtureLimits, fixturePool, fixtureQueue, fixtureSystem } from "./cockpit-fixtures.js";

const YAML = "local_tiers: {}\nproviders: {}\n";
const SLOW_MS = 2500;
let server: Server;
let base = "";
const seen: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "";
    const path = url.replace(/\?.*/, "");
    seen.push(`${req.method} ${path}`);
    const json = (o: unknown, delay = 0) => setTimeout(() => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); }, delay);
    if (path === "/cockpit/registry/validate") return json({ ok: true, diff: ["+x"] });
    if (path === "/cockpit/registry/save") return json({ ok: true, backup: "b1" });
    if (path === "/cockpit/registry/backups") return json({ backups: [] });
    if (path === "/cockpit/registry") return json({ yaml: YAML, hash: "h", mtime: 1 });
    if (path === "/cockpit/models" || path === "/cockpit/memory") return json({}, SLOW_MS);
    if (path === "/cockpit/data") return json(fixtureData(), SLOW_MS);
    if (path === "/cockpit/system") return json(fixtureSystem(), SLOW_MS);
    if (path === "/cockpit/queue") return json(fixtureQueue(), SLOW_MS);
    if (path === "/cockpit/limits") return json(fixtureLimits(), SLOW_MS);
    if (path === "/cockpit/pool") return json(fixturePool(), SLOW_MS);
    if (path.startsWith("/cockpit/")) return json({}, SLOW_MS);
    if (path === "/page") { res.setHeader("content-type", "text/html"); return res.end(cockpitHtml()); }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await closeBrowser(); server?.close(); });

describe.skipIf(!CHROME)("registry validate and save against slow polls (CDP)", () => {
  it("the POSTs are not queued behind the polls and a save issues a bounded set of requests", async () => {
    const b = await launch(1500, 1000);
    await b.send("Page.navigate", { url: `${base}/page` });
    for (let i = 0; i < 60; i++) { await sleep(250); if (await b.ev<boolean>(`!!document.querySelector('textarea.wrg-ta')&&!document.querySelector('textarea.wrg-ta').readOnly`)) break; }
    await sleep(500);
    await b.ev(`(function(){var ta=document.querySelector('textarea.wrg-ta');ta.value=ta.value+"# probe\\n";ta.dispatchEvent(new Event("input"))})()`);
    // the click's own request: time from click until its response is in the page
    const click = (label: string, path: string) => b.ev<number>(`new Promise(function(r){var of=window.fetch,t0=performance.now();window.fetch=function(u){var p=of.apply(this,arguments);if(String(u).indexOf(${JSON.stringify(path)})===0)p.then(function(){window.fetch=of;r(performance.now()-t0)});return p};[].slice.call(document.querySelectorAll('[data-card] button')).filter(function(x){return x.textContent.trim()===${JSON.stringify(label)}})[0].click()})`);
    const tValidate = await click("Validate", "/cockpit/registry/validate");
    expect(tValidate).toBeLessThan(300);
    await sleep(200);
    seen.length = 0;
    const tSave = await click("Save", "/cockpit/registry/save");
    expect(tSave).toBeLessThan(300);
    await sleep(900); // the follow-ups: registry, backups, models, limits
    const mine = seen.filter((s) => /registry|models|limits/.test(s));
    expect(mine.filter((s) => s === "POST /cockpit/registry/save")).toHaveLength(1);
    expect(mine.length).toBeLessThanOrEqual(5);
  }, 60_000);
});
