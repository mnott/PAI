/**
 * A provider gauge card the user makes shorter gives up whitespace first: the dials stay top-aligned (no centring space above them)
 * and only shrink once the body is too short for the natural dial; then the "resets in" line drops. Real Chrome over CDP; prints dial size and top gap per body height.
 */

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHROME, closeBrowser, launch, sleep } from "./cdp-browser.js";
import { cockpitHtml } from "./cockpit-page.js";
import { fixtureData } from "./cockpit-fixtures.js";

const win = (name: string, percent: number) => ({ name, percent, resetAt: Date.now() + 3_600_000 });
let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").replace(/\?.*/, "");
    const json = (o: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
    if (path === "/cockpit/limits") return json({ activeLocal: "", runningLocal: [], limits: [{ provider: "glm", kind: "cloud", windows: [win("5h", 30), win("week", 60)] }], routing: { flow: "", endpoints: [], choices: [], rows: [] } });
    if (path === "/cockpit/data") return json(fixtureData());
    if (path.startsWith("/cockpit/")) return json({});
    if (path === "/page") { res.setHeader("content-type", "text/html"); return res.end(cockpitHtml()); }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await closeBrowser(); server?.close(); });

describe.skipIf(!CHROME)("gauge card whitespace before dial shrink (CDP)", () => {
  it("at body heights 180/150/120/100 the gap above the dials is <= 6 px and dials shrink only when the natural size no longer fits", async () => {
    const b = await launch(1500, 1000);
    await b.send("Page.navigate", { url: `${base}/page` });
    const sel = `[data-card="limits.cloud:glm"]`;
    for (let i = 0; i < 60; i++) { await sleep(250); if (await b.ev<boolean>(`!!document.querySelector('${sel} .gauge svg')`)) break; }
    await sleep(500);
    const rows: { h: number; dial: number; gap: number; resets: boolean }[] = [];
    for (const h of [180, 150, 120, 100]) {
      await b.ev(`(function(){var c=document.querySelector('${sel}'),bd=c.querySelector(".cbody");bd.style.height=${h}+"px";bd.style.setProperty("--uh",${h}+"px");c.setAttribute("data-uh","1");c.toggleAttribute("data-short",${h}<110)})()`);
      await sleep(200);
      rows.push(await b.ev(`(function(){var c=document.querySelector('${sel}'),bd=c.querySelector(".cbody").getBoundingClientRect(),s=c.querySelector(".gauge svg").getBoundingClientRect(),r=c.querySelector(".gauge .s");return{h:${h},dial:Math.round(s.height),gap:Math.round(s.top-bd.top),resets:!!r&&getComputedStyle(r).display!=="none"}})()`));
    }
    console.log("body-h | dial px | gap above | resets line\n" + rows.map((r) => `${r.h} | ${r.dial} | ${r.gap} | ${r.resets}`).join("\n"));
    for (const r of rows) expect(r.gap, `gap above dial at ${r.h}`).toBeLessThanOrEqual(6);
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.dial).toBeLessThanOrEqual(rows[i - 1]!.dial);
    expect(rows[0]!.dial).toBeGreaterThanOrEqual(rows[1]!.dial);
  }, 120_000);

  it("dragging the handle down in 10 px steps: empty space below the labels stays <= 6 px at every step", async () => {
    const b = await launch(1500, 1000);
    await b.send("Page.navigate", { url: `${base}/page` });
    const sel = `[data-card="limits.cloud:glm"]`;
    for (let i = 0; i < 60; i++) { await sleep(250); if (await b.ev<boolean>(`!!document.querySelector('${sel} .gauge svg')`)) break; }
    await sleep(500);
    const natural = await b.ev<number>(`document.querySelector('${sel} .cbody').getBoundingClientRect().height`);
    const rows: { h: number; dial: number; below: number }[] = [];
    for (let h = Math.floor(natural / 10) * 10; h >= 78; h -= 10) {
      await b.ev(`(function(){var c=document.querySelector('${sel}'),bd=c.querySelector(".cbody");bd.style.height=${h}+"px";bd.style.setProperty("--uh",${h}+"px");c.setAttribute("data-uh","1");c.toggleAttribute("data-short",${h}<92)})()`);
      await sleep(150);
      rows.push(await b.ev(`(function(){var c=document.querySelector('${sel}'),bd=c.querySelector(".cbody").getBoundingClientRect(),g=c.querySelector(".gauge"),s=g.querySelector("svg").getBoundingClientRect(),bot=s.bottom;Array.prototype.forEach.call(g.children,function(e){if(e.tagName!=="svg"&&getComputedStyle(e).display!=="none")bot=Math.max(bot,e.getBoundingClientRect().bottom)});return{h:${h},dial:Math.round(s.height),below:Math.round(bd.bottom-bot)}})()`));
    }
    console.log(`natural ${Math.round(natural)}\nbody-h | dial px | empty below labels\n` + rows.map((r) => `${r.h} | ${r.dial} | ${r.below}`).join("\n"));
    for (const r of rows) expect(r.below, `empty below labels at ${r.h}`).toBeLessThanOrEqual(6);
  }, 120_000);
});
