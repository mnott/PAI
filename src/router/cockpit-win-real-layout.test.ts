/**
 * The operator's saved layout (fixture) on the real page at ~530 px, headless Chromium over CDP with real mouse events:
 *   - every card sits inside its parent and no siblings overlap (the speed card is listed in two groups of the saved tree)
 *   - the corner handle of "Compressed" narrows it step by step (6 -> 4 -> 3 units) when dragged left
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

type Box = { x: number; y: number; w: number; h: number };
type Row = Box & { id: string; p: string | null; pr: Box | null };
const inter = (a: Box, b: Box) => a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1;
const PROBE = `(function(){var o=[];document.querySelectorAll("#win-root .card").forEach(function(c){if(c.style.display==="none")return;var b=c.getBoundingClientRect(),p=c.parentElement&&c.parentElement.closest(".card"),pb=p&&p.getBoundingClientRect();
 o.push({id:c.dataset.card,p:p?p.dataset.card:null,x:Math.round(b.left),y:Math.round(b.top+scrollY),w:Math.round(b.width),h:Math.round(b.height),pr:pb?{x:Math.round(pb.left),y:Math.round(pb.top+scrollY),w:Math.round(pb.width),h:Math.round(pb.height)}:null})});return o})()`;

/** The fixture, optionally with the speed card listed a second time in the Tokens group (as the operator's page held it) and a stored width share for Compressed. */
function layout(o: { dup?: boolean; sp?: number } = {}): string {
  const l = JSON.parse(LAYOUT);
  if (o.dup) { l.kids["tokens-group"].ch.push({ k: "c", id: "speed" }); l.kids["tokens-group"].sz.push(427); }
  if (o.sp) l.st["system.compressed"].sp = o.sp;
  return JSON.stringify(l);
}

async function open(w: number, saved: string) {
  const b = await launch(w, 900);
  // the operator's layout is the device's own layout; set once so a reload keeps what the page saved
  await b.send("Page.addScriptToEvaluateOnNewDocument", { source: `if(!localStorage.getItem("pai.cockpit.win.v2"))localStorage.setItem("pai.cockpit.win.v2",${JSON.stringify(saved)})` });
  await b.send("Page.navigate", { url: `${base}/page` });
  for (let i = 0; i < 60; i++) { await sleep(250); if (await b.ev<boolean>(`typeof Win!=="undefined"&&!!document.querySelector('#win-root [data-card="system.compressed"] .chandle')`)) break; }
  await sleep(2000);
  const mouse = (type: string, x: number, y: number) => b.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
  return { ...b, mouse };
}

/** Drag the corner handle of Compressed left in 10 px steps with real mouse events; returns the stored width divisor after each step. */
async function dragLeft(b: Awaited<ReturnType<typeof open>>, px: number): Promise<number[]> {
  const sel = '#win-root [data-card="system.compressed"]';
  const [hx, hy] = await b.ev<[number, number]>(`(function(){var e=document.querySelector('${sel} .chandle');e.scrollIntoView({block:"center"});var r=e.getBoundingClientRect();return[r.left+r.width/2,r.top+r.height/2]})()`);
  await b.mouse("mouseMoved", hx, hy); await b.mouse("mousePressed", hx, hy);
  const seen: number[] = [];
  for (let i = 1; i <= px / 10; i++) {
    await b.mouse("mouseMoved", hx - i * 10, hy); await sleep(40);
    seen.push(await b.ev<number>(`Win.state().st["system.compressed"].sp||0`));
  }
  await b.mouse("mouseReleased", hx - px, hy);
  return seen;
}
const units = (sp: number) => Math.round(12 / sp);

describe.skipIf(!CHROME)("operator layout on the real page", () => {
  for (const dup of [false, true]) {
    it(`530 px${dup ? ", speed listed in two groups" : ""}: every card is drawn inside its parent and no siblings overlap`, async () => {
      const b = await open(530, layout({ dup }));
      const rows = await b.ev<Row[]>(PROBE);
      const bad: string[] = [];
      for (const r of rows) {
        if (r.pr && (r.x < r.pr.x - 1 || r.y < r.pr.y - 1 || r.x + r.w > r.pr.x + r.pr.w + 1 || r.y + r.h > r.pr.y + r.pr.h + 1)) bad.push(`${r.id} outside ${r.p}`);
        for (const s of rows) if (r.id < s.id && r.p === s.p && inter(r, s)) bad.push(`${r.id} x ${s.id}`);
      }
      expect(rows.filter((r) => r.id === "speed").length, "speed is drawn once").toBe(1);
      expect(bad).toEqual([]);
    }, 120_000);
  }

  it("530 px: dragging the handle of Compressed left steps 6 -> 4 units (the least width stops it there)", async () => {
    const b = await open(530, layout({ sp: 2 }));
    const seen = (await dragLeft(b, 300)).map(units);
    if (process.env.PAI_GRID) console.log(seen.join(" "));
    expect(seen[0]).toBe(6);
    expect(seen[seen.length - 1]).toBe(4);
  }, 120_000);

  it("900 px: dragging the handle of Compressed left steps down to 4 and then 3 units", async () => {
    const b = await open(900, layout({ sp: 2 }));
    const seen = (await dragLeft(b, 400)).map(units);
    if (process.env.PAI_GRID) console.log(seen.join(" "));
    expect([...new Set(seen)]).toEqual(expect.arrayContaining([4, 3]));
    expect(seen[seen.length - 1]).toBe(3);
    expect(seen, "never widens while dragging left").toEqual([...seen].sort((a, b) => b - a));
  }, 120_000);
});
