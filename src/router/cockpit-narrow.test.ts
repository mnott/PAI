/**
 * Narrow (stacked) mode keeps sensible card heights: the real page in headless Chromium at 390 px.
 * A card is no taller than its content + 24 px, except chart types (they draw at the body size):
 * those are at most 0.6 * width + header. At 822 px the heights are the wide-mode heights (pinned).
 * PAI_NARROW_TABLE=<file> writes the height table. Skipped when no Chromium is installed.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cockpitHtml } from "./cockpit-page.js";
import { fixtureData, fixtureLimits, fixturePool, fixturePoolWithSlot, fixtureQueue, fixtureSystem } from "./cockpit-fixtures.js";
import { CHROME, dumpDom, killChromes } from "./cdp-browser.js";

const HEAD = 28;

const INJECT = `<script>setTimeout(function(){var out=[];document.querySelectorAll("[data-card]").forEach(function(c){var b=c.querySelector(".cbody"),h=c.getBoundingClientRect();if(!h.height)return;var kids=b?Array.prototype.slice.call(b.children):[],low=0,top=b?b.getBoundingClientRect().top:0;kids.forEach(function(k){var r=k.getBoundingClientRect();if(r.height>0)low=Math.max(low,r.bottom-top)});out.push({id:c.getAttribute("data-card"),type:c.getAttribute("data-type"),x:Math.round(h.left),y:Math.round(h.top),w:Math.round(h.width),h:Math.round(h.height),head:b?Math.round(b.getBoundingClientRect().top-h.top):0,content:Math.round(low),sh:b?b.scrollHeight:0,tr:(function(t){return t&&t.scrollWidth>t.clientWidth?1:0})(c.querySelector(".ctitle"))})});parent.postMessage(JSON.stringify({vw:innerWidth,cards:out}),"*")},3500)</script>`;

let server: Server;
let base = "";
let tmp = "";

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "cockpit-narrow-"));
  server = createServer((req, res) => {
    const url = req.url ?? "";
    const json = (o: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
    if (url.startsWith("/cockpit/data")) return json(fixtureData());
    if (url.startsWith("/cockpit/system")) return json(fixtureSystem());
    if (url.startsWith("/cockpit/queue")) return json(fixtureQueue());
    if (url.startsWith("/cockpit/limits")) return json(fixtureLimits());
    if (url.startsWith("/cockpit/pool")) return json(fixturePoolWithSlot());
    if (url.startsWith("/frame")) {
      const w = /w=(\d+)/.exec(url)?.[1] ?? "822";
      res.setHeader("content-type", "text/html");
      return res.end(`<body style="margin:0"><iframe src="/page" style="width:${w}px;height:5000px;border:0"></iframe><script>onmessage=function(e){document.body.setAttribute("data-fit",e.data)}</script></body>`);
    }
    if (url.startsWith("/page")) {
      res.setHeader("content-type", "text/html");
      return res.end(cockpitHtml().replace("</body>", INJECT + "</body>"));
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => { killChromes(); server?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

interface Card { id: string; type: string; x: number; y: number; w: number; h: number; head: number; content: number; sh: number; tr: number }
async function measure(width: number): Promise<Card[]> {
  const o = { width: 1000, height: 5200, budgetMs: 8000 };
  const dom = await dumpDom(`${base}/frame?w=${width}`, o);
  const m = /data-fit="([^"]*)"/.exec(dom);
  if (!m) throw new Error("no result in dump");
  const cards = (JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&")) as { cards: Card[] }).cards;
  const f = process.env.PAI_NARROW_TABLE;
  if (f) writeFileSync(f.replace(/(\.\w+)?$/, `-${width}$1`), cards.map((c) => `${c.id}\t${c.type}\tx=${c.x}\ty=${c.y}\tw=${c.w}\th=${c.h}\thead=${c.head}\tcontent=${c.content}\tsh=${c.sh}\ttr=${c.tr}`).join("\n") + "\n");
  return cards;
}

/** Card heights at 822 px before the narrow-mode change (main 309bfe95, fixture data). */
const WIDE_822 = [
  "kpis:202",
  "kpis.requests:83",
  "kpis.input:83",
  "kpis.output:83",
  "kpis.cache-read:83",
  "kpis.cache-write:83",
  "kpis.errors:83",
  "pool:424",
  "pool.pool:96",
  "pool.host:96",
  "pool.tasks:96",
  "pool.hit:96",
  "pool.spares:96",
  "pool.not-pooled:96",
  "pool.slots:84",
  "system:1197",
  "sys-metrics:314",
  "system.memory:90",
  "system.swap:90",
  "system.wired:90",
  "system.compressed:90",
  "system.cpu-load:90",
  "system.gpu-load:90",
  "system.ane-load:28",
  "system.soc-temp:90",
  "system.cpu-w:28",
  "system.gpu-w:28",
  "system.ane-w:28",
  "system.system-w:90",
  "system.power:90",
  "system.energy:90",
  "sys-power:231",
  "system.power-chart:203",
  "sys-servers:608",
  "system.srv:gyro-m/rss:90",
  "system.srv:gyro-m/e2e:90",
  "system.srv:gyro-m/decode:90",
  "system.srv:gyro-m/prefix:90",
  "system.srv:ollama-local-with-a-long-name/rss:90",
  "system.srv:ollama-local-with-a-long-name/e2e:90",
  "system.srv:ollama-local-with-a-long-name/decode:90",
  "system.srv:ollama-local-with-a-long-name/prefix:90",
  "memory:206",
  "memory.kv:80",
  "memory.index:90",
  "memory.backend:90",
  "memory.passes:90",
  "memory.daemon:90",
  "routing:76",
  "routing.flow:48",
  "limits-local:68",
  "limits-cloud:245",
  "limits.cloud.none:67",
  "limits.cloud:anthropic:142",
  "limits.cloud:glm:142",
  "limits.cloud:gyro-m:142",
  "workers:291",
  "workers.local:61",
  "workers.wt:61",
  "workers.sess:PAI:125",
  "models:76",
  "models.endpoints:48",
  "cache:909",
  "cache-rings:542",
  "cache.ring:glm/qwen3.8-flash-next-gyro-m:166",
  "cache.ring:glm/glm-5.3-flash:166",
  "cache.ring:anthropic/claude-sonnet-5-5:166",
  "cache.ring:anthropic/claude-haiku-5-5:166",
  "cache.ring:anthropic/claude-opus-5-5:166",
  "cache.low:61",
  "cache.note:61",
  "cache.local:61",
  "cache.providers:193",
  "tokens:300",
  "daily:300",
  "speed:230",
  "pause:131",
  "sessions:322",
  "runs:194",
  "settings:323",
  "settings.registry-edit:220",
  "settings.registry-backups:67",
];

/** Cards per line of a group's member cards of one type: the sizes of the groups sharing a top edge. */
function perLine(cards: Card[], prefix: string, type: string): number[] {
  const lines = new Map<number, Card[]>();
  for (const c of cards) if (c.id.startsWith(prefix) && c.type === type && c.w > 0) lines.set(c.y, [...(lines.get(c.y) ?? []), c]);
  return [...lines.values()].map((l) => l.length);
}
const MIN_W = { metric: 110, kv: 150 };

const CHART = /^chart$/;
describe.skipIf(!CHROME)("cockpit narrow mode card heights, real layout in Chromium", () => {
  it("390 px: no card is taller than its content + 24 px, a chart is at most 0.6 * width + header", async () => {
    const cards = await measure(390);
    expect(cards.length).toBeGreaterThan(10);
    for (const c of cards) {
      // a card with no body (hidden metric, minimized) is just its header; an empty group keeps its type minimum (header + 40)
      if (c.head <= 0 || c.h <= HEAD) continue;
      const chart = CHART.test(c.type);
      if (chart) expect(c.h, `${c.id} (${c.type}) chart ${c.h}px`).toBeLessThanOrEqual(Math.round(0.6 * 390) + HEAD + c.head);
      else expect(c.h, `${c.id} (${c.type}) ${c.h}px, content ${c.content}px + head ${c.head}px`).toBeLessThanOrEqual(Math.max(c.head + c.content + 24, c.type === "group" ? c.head + 40 : 0));
    }
  }, 120_000);
  it("620 and 390 px: a row that does not fit wraps into a grid of cards at least their minW wide, none overlapping", async () => {
    for (const width of [620, 390]) {
      const cards = await measure(width);
      const totals = perLine(cards, "kpis.", "metric"), pool = perLine(cards, "pool.", "kv");
      expect(Math.max(...totals), `${width}px totals per line ${totals}`).toBeGreaterThanOrEqual(2);
      expect(Math.max(...pool), `pool kv per line ${pool}`).toBeGreaterThanOrEqual(1);
      for (const c of cards) {
        const min = MIN_W[c.type as keyof typeof MIN_W];
        if (min && c.w > 0 && /^(kpis|pool)\./.test(c.id)) expect(c.w, `${c.id} ${c.w}px at ${width}`).toBeGreaterThanOrEqual(min - 1);
      }
      const grid = cards.filter((c) => /^(kpis|pool)\./.test(c.id) && c.w > 0 && c.h > 0);
      for (let i = 0; i < grid.length; i++) for (let j = i + 1; j < grid.length; j++) {
        const a = grid[i]!, b = grid[j]!;
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        expect(ox > 0.5 && oy > 0.5, `${a.id} overlaps ${b.id} at ${width}`).toBe(false);
      }
    }
  }, 120_000);
  it("620 px: lines are balanced, no metric title is cut, an empty slots table is fitted to its content", async () => {
    const cards = await measure(620);
    const totals = perLine(cards, "kpis.", "metric");
    expect(totals, `totals per line ${totals}`).toEqual([3, 3]);
    for (const c of cards) if (c.type === "metric" && c.w > 0) expect(c.tr, `${c.id} title cut at ${c.w}px`).toBe(0);
    const slots = cards.find((c) => c.id === "pool.slots")!;
    expect(slots.h - slots.head - slots.content, `slots ${slots.h}px, content ${slots.content}px`).toBeLessThanOrEqual(24);
  }, 120_000);
  it("822 px: wide-mode heights are unchanged", async () => {
    const cards = await measure(822);
    expect(cards.length).toBeGreaterThan(10);
    expect(cards.map((c) => `${c.id}:${c.h}`)).toEqual(WIDE_822);
  }, 120_000);
});
