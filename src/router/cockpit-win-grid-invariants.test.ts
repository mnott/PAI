/**
 * The window system is a CSS grid: the invariants hold on the operator's saved layout (fixture) and on the default layout at 360/530/900/1400 px,
 * real headless Chrome over CDP:
 *   - no two cards overlap, every card is inside its group, no group is taller than its content (+16 px), the cards of a grid row are equally tall
 *   - a minimized group is a header; the dock sits below the last row; minimize + restore of a card changes no other group's height
 *   - no card carries an inline top/left
 *   - the corner handle narrows a card 6 -> 4 -> 3 units where the group is wide enough; Cloud limits' two cards sit side by side from 600 px
 * Set PAI_GRID=1 to print the table.
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
type Row = Box & { id: string; p: string | null; anc: string[]; min: boolean; chip: boolean; group: boolean; inl: boolean; kidsBottom: number; dockTop: number };
const PROBE = `(function(){var o=[];document.querySelectorAll("#win-root .card").forEach(function(c){if(c.style.display==="none")return;var b=c.getBoundingClientRect(),anc=[],q=c.parentElement;if(!b.width&&!b.height)return;
 while(q){if(q.classList&&q.classList.contains("card"))anc.push(q.dataset.card);q=q.parentElement}
 var g=c.querySelector(":scope>.cbody.cgroup"),kb=0,dt=0;
 if(g){var gr=g.getBoundingClientRect();kb=0;for(var i=0;i<g.children.length;i++){var k=g.children[i];if(k.classList.contains("cdock")){var kr=k.getBoundingClientRect();if(kr.height)dt=kr.top+scrollY;continue}var r=k.getBoundingClientRect();if(!r.width&&!r.height)continue;kb=Math.max(kb,r.bottom+scrollY)}if(!kb)kb=gr.top+scrollY}
 o.push({id:c.dataset.card,p:anc[0]||null,anc:anc,min:c.classList.contains("min"),chip:c.classList.contains("chip"),group:!!g,inl:!!(c.style.top||c.style.left||c.style.width),kidsBottom:kb,dockTop:dt,x:b.left,y:b.top+scrollY,w:b.width,h:b.height})});return o})()`;

async function open(w: number, saved: string | null) {
  const b = await launch(w, 900);
  if (saved) await b.send("Page.addScriptToEvaluateOnNewDocument", { source: `if(!localStorage.getItem("pai.cockpit.win.v2"))localStorage.setItem("pai.cockpit.win.v2",${JSON.stringify(saved)})` });
  await b.send("Page.navigate", { url: `${base}/page` });
  for (let i = 0; i < 60; i++) { await sleep(250); if (await b.ev<boolean>(`typeof Win!=="undefined"&&!!document.querySelector('#win-root .card .chandle')`)) break; }
  await sleep(1500);
  const mouse = (type: string, x: number, y: number) => b.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
  return { ...b, mouse };
}
type Page = Awaited<ReturnType<typeof open>>;

const inter = (a: Box, b: Box) => a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1;

/** Every violated invariant of one probe, as text. */
function violations(rows: Row[]): string[] {
  const bad: string[] = [];
  const by = new Map(rows.map((r) => [r.id, r]));
  for (const r of rows) {
    if (r.inl) bad.push(`${r.id}: inline top/left/width`);
    const pr = r.p ? by.get(r.p) : null;
    if (pr && (r.x < pr.x - 1 || r.y < pr.y - 1 || r.x + r.w > pr.x + pr.w + 1 || r.y + r.h > pr.y + pr.h + 1)) bad.push(`${r.id}: outside ${r.p}`);
    for (const s of rows) if (r.id < s.id && !r.anc.includes(s.id) && !s.anc.includes(r.id) && inter(r, s)) bad.push(`${r.id} x ${s.id}: overlap`);
    // a root group is as tall as its header, padding, kids and dock
    if (r.group && !r.p && !r.min && r.kidsBottom) {
      const content = Math.max(r.kidsBottom, r.dockTop ? r.dockTop + 24 : 0) - r.y + 6;
      if (r.h > content + 16) bad.push(`${r.id}: ${Math.round(r.h)} px tall for ${Math.round(content)} px of content`);
    }
    if (r.min && !r.chip && r.group && r.h > 32) bad.push(`${r.id}: minimized group is ${Math.round(r.h)} px`);
  }
  // cards sharing a grid row (same parent, same top) are equally tall (a minimized card is a header, not stretched)
  const rowsBy = new Map<string, Row[]>();
  for (const r of rows) if (!r.chip) { const k = `${r.p}|${Math.round(r.y)}`; rowsBy.set(k, [...(rowsBy.get(k) ?? []), r]); }
  for (const [k, list] of rowsBy) {
    const hs = list.filter((r) => !r.min).map((r) => Math.round(r.h));
    if (hs.length > 1 && Math.max(...hs) - Math.min(...hs) > 1) bad.push(`row ${k}: heights ${hs.join("/")}`);
  }
  // the dock sits below the last row of its group
  for (const r of rows) if (r.dockTop && r.dockTop < r.kidsBottom - 1) bad.push(`${r.id}: dock above its last row`);
  return bad;
}

const WIDTHS = [360, 530, 900, 1400];
const CASES: [string, string | null][] = [["operator layout", LAYOUT], ["default layout", null]];

describe.skipIf(!CHROME)("CSS grid invariants", () => {
  for (const [name, saved] of CASES) {
    for (const w of WIDTHS) {
      it(`${name} at ${w} px: no overlap, every card in its group, content-high groups, equal row heights, no inline position`, async () => {
        const b = await open(w, saved);
        const rows = await b.ev<Row[]>(PROBE);
        if (process.env.PAI_GRID) console.log(`${name} ${w}px: ${rows.length} cards, ${violations(rows).length} violations\n` + violations(rows).slice(0, 12).join("\n"));
        expect(rows.length).toBeGreaterThan(20);
        expect(violations(rows)).toEqual([]);
      }, 120_000);
    }
  }

  it("operator layout, 900 px: minimizing a root group leaves its header, a card's minimize/restore changes no other group's height, the dock is below the last row", async () => {
    const b = await open(900, LAYOUT);
    const heights = async () => Object.fromEntries((await b.ev<Row[]>(PROBE)).filter((r) => r.group && !r.p).map((r) => [r.id, Math.round(r.h)]));
    const before = await heights();
    // a card inside a group: minimize, then restore
    const card = await b.ev<string>(`(function(){var a=document.querySelectorAll('#win-root .card .cbody.cgroup>.card:not(.min)');for(var i=0;i<a.length;i++)if(!a[i].querySelector(".cbody.cgroup")&&a[i].getBoundingClientRect().width>0)return a[i].dataset.card;return ""})()`);
    const owner = await b.ev<string>(`Win.el(${JSON.stringify(card)}).parentElement.closest(".card").dataset.card`);
    await b.ev(`Win.toggleMin(${JSON.stringify(card)})`);
    await sleep(200);
    const mid = await b.ev<Row[]>(PROBE);
    expect(violations(mid)).toEqual([]);
    expect(mid.find((r) => r.id === card)?.chip, "the card is a dock chip").toBe(true);
    const during = await heights();
    for (const g of Object.keys(before)) if (g !== owner && !mid.find((r) => r.id === g)?.anc.length) expect(during[g], `${g} while ${card} is minimized`).toBe(before[g]);
    await b.ev(`Win.toggleMin(${JSON.stringify(card)})`);
    await sleep(200);
    expect(await heights()).toEqual(before);
    // a root group: minimize leaves the header
    const root = Object.keys(before)[0];
    await b.ev(`Win.toggleMin(${JSON.stringify(root)})`);
    await sleep(200);
    const after = await b.ev<Row[]>(PROBE);
    expect(after.find((r) => r.id === root)!.h).toBeLessThanOrEqual(32);
    expect(violations(after)).toEqual([]);
  }, 120_000);

  it("operator layout: speed is drawn once, inside Performance details, even when the saved Tokens group lists it too", async () => {
    const l = JSON.parse(LAYOUT);
    l.kids["tokens-group"].ch.push({ k: "c", id: "speed" });
    l.kids["tokens-group"].sz.push(427);
    const b = await open(900, JSON.stringify(l));
    const rows = (await b.ev<Row[]>(PROBE)).filter((r) => r.id === "speed");
    expect(rows.length).toBe(1);
    expect(rows[0].p).toBe("perf-group");
  }, 120_000);

  it("operator layout, 600 px: the two Cloud limits cards sit side by side", async () => {
    const b = await open(600, LAYOUT);
    const rows = await b.ev<Row[]>(PROBE);
    const kids = rows.filter((r) => r.p === "limits-cloud" && !r.group && !r.min);
    expect(kids.length).toBeGreaterThanOrEqual(2);
    const first = kids[0];
    expect(kids.filter((r) => Math.abs(r.y - first.y) < 2).length, "cards on the first line").toBeGreaterThanOrEqual(2);
  }, 120_000);

  for (const [w, steps] of [[900, [4, 3]], [530, [4]]] as [number, number[]][]) {
    it(`operator layout, ${w} px: the handle of Compressed narrows it step by step (${steps.join(" -> ")} units)`, async () => {
      const b = await open(w, LAYOUT);
      const sel = '#win-root [data-card="system.compressed"]';
      await b.ev(`Win.state().st["system.compressed"]=Object.assign(Win.state().st["system.compressed"]||{},{w:6});delete Win.state().st["system.compressed"].h;Win.relayout()`);
      const [hx, hy] = await b.ev<[number, number]>(`(function(){var e=document.querySelector('${sel} .chandle');e.scrollIntoView({block:"center"});var r=e.getBoundingClientRect();return[r.left+r.width/2,r.top+r.height/2]})()`);
      await b.mouse("mouseMoved", hx, hy); await b.mouse("mousePressed", hx, hy);
      const seen: number[] = [];
      for (let i = 1; i <= 40; i++) { await b.mouse("mouseMoved", hx - i * 10, hy); await sleep(30); seen.push(await b.ev<number>(`Win.state().st["system.compressed"].w||0`)); }
      await b.mouse("mouseReleased", hx - 400, hy);
      if (process.env.PAI_GRID) console.log(seen.join(" "));
      expect(seen[0]).toBe(6);
      for (const s of steps) expect(seen, `reaches ${s}`).toContain(s);
      expect(seen[seen.length - 1]).toBe(steps[steps.length - 1]);
      expect(seen, "never widens while dragging left").toEqual([...seen].sort((a, c) => c - a));
      expect(await b.ev<boolean>(`Win.state().st["system.compressed"].h===undefined`), "a sideways drag stores no height").toBe(true);
      expect(violations(await b.ev<Row[]>(PROBE))).toEqual([]);
    }, 120_000);
  }
});
