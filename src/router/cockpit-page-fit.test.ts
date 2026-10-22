/**
 * The cockpit tables never scroll sideways: the real page, served with live-shaped data,
 * is loaded in headless Chromium at several widths and every .tw table wrapper must
 * satisfy scrollWidth <= clientWidth. Skipped when no Chromium is installed.
 * PAI_FIT_SHOTS=<dir> additionally writes a screenshot per width.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cockpitHtml } from "./cockpit-page.js";
import { fixtureData, fixtureLimits, fixturePool, fixtureQueue, fixtureSystem } from "./cockpit-fixtures.js";
import { CHROME, dumpDom, killChromes, screenshot } from "./cdp-browser.js";

let server: Server;
let base = "";
let tmp = "";
const INJECT = `<script>setTimeout(function(){var out=[];document.querySelectorAll(".tw").forEach(function(w){var s=w.closest("[data-card]"),t=w.querySelector("table");out.push({sec:s?s.getAttribute("data-card").split(/[.:]/)[0]:"?",scrollWidth:w.scrollWidth,clientWidth:w.clientWidth,tableW:t?t.scrollWidth:0,rows:w.querySelectorAll("tbody tr").length,rowH:Array.prototype.map.call(w.querySelectorAll("tbody tr"),function(r){return r.getBoundingClientRect().height}),lh:parseFloat(getComputedStyle(w).lineHeight)||parseFloat(getComputedStyle(w).fontSize)*1.2,stacked:w.classList.contains("stacked"),firstW:(w.querySelector("tbody td")||{getBoundingClientRect:function(){return{width:0}}}).getBoundingClientRect().width,subs:Array.prototype.map.call(w.querySelectorAll("tbody tr"),function(r){var c=r.querySelector("td"),d=c&&c.querySelector(".dim"),cr=c&&c.getBoundingClientRect(),dr=d&&d.getBoundingClientRect();return{lines:c&&c.querySelectorAll(".dim").length,inside:!!dr&&dr.width>0&&dr.top>=cr.top-0.5&&dr.bottom<=cr.bottom+0.5&&dr.left>=cr.left-0.5&&dr.right<=cr.right+0.5}}),thead:!!w.querySelector("thead")&&getComputedStyle(w.querySelector("thead")).display!=="none"})});var bef=[];document.querySelectorAll(".tw.stacked td").forEach(function(d){var cs=getComputedStyle(d,"::before"),sc=d.closest("[data-card]");bef.push({sec:sc?sc.getAttribute("data-card").split(/[.:]/)[0]:"?",label:d.getAttribute("data-l"),h:parseFloat(cs.height),fs:parseFloat(cs.fontSize)})});var ths=[];document.querySelectorAll(".tw th").forEach(function(h){var r=document.createRange();r.selectNodeContents(h);var tops={};Array.prototype.forEach.call(r.getClientRects(),function(q){if(q.width>0)tops[Math.round(q.top)]=1});var sc=h.closest("[data-card]");ths.push({sec:sc?sc.getAttribute("data-card").split(/[.:]/)[0]:"?",label:h.textContent,lines:Object.keys(tops).length,height:Math.round(h.getBoundingClientRect().height)})});var m=document.querySelector("main");parent.postMessage(JSON.stringify({main:m.clientWidth,doc:document.documentElement.scrollWidth,vw:innerWidth,tables:out,ths:ths,befores:bef}),"*")},2500)</script>`;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "cockpit-fit-"));
  server = createServer((req, res) => {
    const url = req.url ?? "";
    const json = (o: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
    if (url.startsWith("/cockpit/data")) return json(fixtureData());
    if (url.startsWith("/cockpit/system")) return json(fixtureSystem());
    if (url.startsWith("/cockpit/queue")) return json(fixtureQueue());
    if (url.startsWith("/cockpit/limits")) return json(fixtureLimits());
    if (url.startsWith("/cockpit/pool")) return json(fixturePool());
    if (url.startsWith("/frame")) {
      // the page runs in an iframe: its viewport is the iframe's width, whatever the minimum headless window is
      const w = /w=(\d+)/.exec(url)?.[1] ?? "822";
      const main = /main=(\d+)/.exec(url)?.[1];
      const probe = /probe=(\w+)/.exec(url)?.[1];
      res.setHeader("content-type", "text/html");
      return res.end(`<body style="margin:0"><iframe src="/page${main ? `?main=${main}` : ""}${probe ? `?probe=${probe}` : ""}" style="width:${w}px;height:3200px;border:0"></iframe><script>onmessage=function(e){document.body.setAttribute("data-fit",e.data)}</script></body>`);
    }
    if (url.startsWith("/page")) {
      const main = /main=(\d+)/.exec(url)?.[1];
      const probe = /probe=(\w+)/.exec(url)?.[1];
      const html = cockpitHtml().replace("</body>", (main ? `<style>main{width:${main}px;max-width:${main}px;box-sizing:border-box}</style>` : "") + (INJECT) + "</body>");
      res.setHeader("content-type", "text/html");
      return res.end(html);
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => { killChromes(); server?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

/** Every browser started here, so afterAll can kill what a failed test left behind. */
interface ShootResult {
  main: number; doc: number; vw: number;
  tables: { sec: string; scrollWidth: number; clientWidth: number; tableW: number; rows: number; rowH: number[]; lh: number; stacked: boolean; firstW: number; subs: { lines: number; inside: boolean }[]; thead: boolean }[];
  befores: { sec: string; label: string; h: number; fs: number }[];
  ths: { sec: string; label: string; lines: number; height: number }[];
}
async function shoot(width: number, main: number | null, shot?: string, probe?: string): Promise<ShootResult> {
  const o = { width: 1000, height: 3300, budgetMs: 6000 };
  const url = `${base}/frame?w=${width}${main ? `&main=${main}` : ""}${probe ? `&probe=${probe}` : ""}`;
  const dom = await dumpDom(url, o);
  if (shot) await screenshot(url, shot, o);
  const m = /data-fit="([^"]*)"/.exec(dom);
  if (!m) throw new Error("no fit result in dump");
  return JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
}

describe.skipIf(!CHROME)("cockpit tables fit their card (no horizontal scroll), real layout in Chromium", () => {
  const shots = process.env.PAI_FIT_SHOTS;
  for (const [label, width, main] of [["822 px viewport", 822, null], ["385 px main width inside a wide viewport (half-width card)", 900, 385], ["375 px phone", 375, null]] as const) {
    it(`${label}: every table wrapper has scrollWidth <= clientWidth`, async () => {
      const r = await shoot(width, main, shots ? join(shots, `cockpit-${width}${main ? "-main" + main : ""}.png`) : undefined);
      const secs = new Set(r.tables.map((t) => t.sec));
      // sessions, pause, providers (cache) and the workers queue table all rendered
      // (System renders metric tiles now, not a table)
      for (const s of ["sessions", "pause", "cache", "workers"]) expect(secs.has(s), `${s} table present (${[...secs].join(",")})`).toBe(true);
      for (const t of r.tables) {
        expect(t.scrollWidth, `${t.sec}: wrapper ${t.clientWidth}px, content ${t.scrollWidth}px`).toBeLessThanOrEqual(t.clientWidth);
        expect(t.tableW, `${t.sec}: table ${t.tableW}px in wrapper ${t.clientWidth}px`).toBeLessThanOrEqual(t.clientWidth);
      }
      // no header wraps: the text inside every th sits on one line (range rects share one top)
      expect(r.ths.length, "headers measured").toBeGreaterThan(0);
      for (const h of r.ths) expect(h.lines, `${h.sec} th "${h.label}": ${h.lines} lines (height ${h.height}px)`).toBeLessThanOrEqual(1);
      expect(r.doc, "page itself must not scroll sideways").toBeLessThanOrEqual(r.vw);
      // a stacked label (td::before) never wraps: one line box, whatever the card width
      for (const b of r.befores.filter((x) => x.h != null)) expect(b.h, `${b.sec} label "${b.label}": ${b.h}px high at ${b.fs}px font`).toBeLessThanOrEqual(b.fs * 1.6);
      if (width === 375) expect(r.tables.find((t) => t.sec === "sessions")!.stacked, "sessions does not fit at 375 px: stacked").toBe(true);
    }, 120_000);
  }
});
