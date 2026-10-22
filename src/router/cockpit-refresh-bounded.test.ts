/**
 * Refresh stays bounded: on the real cockpit page (headless Chromium over CDP, operator layout) N poll rounds of every feed and range
 * switches neither grow the DOM node count nor set off a stream of ResizeObserver callbacks (a chart redraw that resizes its own card
 * and fires the observer again would). Skipped when no Chromium is installed.
 */

import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHROME, closeBrowser, launch, sleep } from "./cdp-browser.js";
import { cockpitHtml } from "./cockpit-page.js";
import { fixtureData, fixtureLimits, fixturePoolWithSlot, fixtureQueue, fixtureSystem } from "./cockpit-fixtures.js";

const LAYOUT = readFileSync(new URL("./cockpit-fixtures-operator-layout.json", import.meta.url), "utf8");
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

const INSTR = `window.__ro=0;(function(){var RO=window.ResizeObserver;window.ResizeObserver=function(cb){return new RO(function(a,o){window.__ro++;return cb(a,o)})};window.ResizeObserver.prototype=RO.prototype})();
if(!localStorage.getItem("pai.cockpit.win.v2"))localStorage.setItem("pai.cockpit.win.v2",${JSON.stringify(LAYOUT)})`;
const NODES = `document.getElementsByTagName("*").length`;

describe.skipIf(!CHROME)("cockpit refresh is bounded", () => {
  for (const w of [550, 1650]) {
    it(`${w} px: 27 range switches (each reloads the feeds that follow the window) leave the node count and the observer callbacks bounded`, async () => {
      const b = await launch(w, 900);
      await b.send("Page.addScriptToEvaluateOnNewDocument", { source: INSTR });
      await b.send("Page.navigate", { url: `${base}/page` });
      for (let i = 0; i < 60; i++) { await sleep(250); if (await b.ev<boolean>(`typeof Win!=="undefined"&&!!document.querySelector('#win-root .card .chandle')`)) break; }
      const tab = async (r: string) => { await b.ev(`document.querySelector('#tabs button[data-w="${r}"]').click()`); await sleep(250); };
      for (const r of ["24h", "7d", "1h"]) await tab(r);
      await sleep(1000);
      const n0 = await b.ev<number>(NODES), ro0 = await b.ev<number>(`window.__ro`);
      for (let i = 0; i < 9; i++) for (const r of ["24h", "7d", "1h"]) await tab(r);
      await sleep(1500);
      const n1 = await b.ev<number>(NODES), ro1 = await b.ev<number>(`window.__ro`);
      expect(n1, `nodes ${n0} -> ${n1}`).toBeLessThanOrEqual(n0 + 20);
      expect(ro1 - ro0, `observer callbacks ${ro0} -> ${ro1}`).toBeLessThanOrEqual(25);
    }, 120_000);
  }
});
