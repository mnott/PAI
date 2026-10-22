/**
 * A layout change survives leaving the page: hidden placeholder cards (zero-size, in the default tree) do not
 * block the save, and a save still pending in the debounce is flushed on pagehide.
 * Headless Chromium on the real page with a mock server. Skipped without Chromium.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cockpitHtml } from "./cockpit-page.js";
import { CHROME, dumpDom, killChromes } from "./cdp-browser.js";

const data = () => ({
  window: "1h", totals: { requests: 5000, input: 9e6, output: 4e5, cacheWrite: 1e6, cacheRead: 9e7, errors: 0, hitRatio: 0.9 },
  byModel: [], series: [], weights: { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 }, cachePause: [], byProvider: [],
  bustParts: {}, bySession: [], workers: [], daily: { models: {}, days: [] }, sessionSplit: null, speed: [], promptByProvider: {}, promptSince: {},
});

let server: Server;
let base = "";
let tmp = "";
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "cockpit-win-persist-"));
  server = createServer((req, res) => {
    const url = req.url ?? "";
    if (url.startsWith("/page")) {
      res.setHeader("content-type", "text/html");
      // at 1500 ms: move the first group last, then either wait out the debounce or leave the page at once
      const probe = `<script>setTimeout(function(){var K="pai.cockpit.win.v2",S=Win.state();
var hidden=Array.prototype.filter.call(document.querySelectorAll("#win-root .card"),function(c){return c.getBoundingClientRect().height===0||c.style.display==="none"}).length;
var t=JSON.parse(JSON.stringify(S.tree));t.ch.push(t.ch.shift());t.sz.push(t.sz.shift());
Win.apply("",t);
var mode="__MODE__";
function out(){var v=localStorage.getItem(K);document.body.setAttribute("data-r",JSON.stringify({hidden:hidden,first:v?JSON.parse(v).tree.ch[0].id:null,was:S.tree.ch?"x":"y"}))}
if(mode==="leave"){window.dispatchEvent(new Event("pagehide"));out()}else setTimeout(out,600)},1500)</script>`;
      const m = /[?&]mode=(\w+)/.exec(url);
      return res.end(cockpitHtml().replace("</body>", probe.replace("__MODE__", m?.[1] ?? "wait") + "</body>"));
    }
    res.setHeader("content-type", "application/json");
    if (url.startsWith("/cockpit/data")) return res.end(JSON.stringify(data()));
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => { killChromes(); server?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

async function open(mode: string): Promise<{ hidden: number; first: string | null }> {
  const dom = await dumpDom(`${base}/page?mode=${mode}`, { width: 1400, height: 1400, budgetMs: 8000 });
  const m = /data-r="([^"]*)"/.exec(dom);
  if (!m) throw new Error("no probe result");
  return JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
}

describe.skipIf(!CHROME)("cockpit layout persistence", () => {
  it("saves a layout change while hidden placeholder cards are in the page", async () => {
    const r = await open("wait");
    expect(r.hidden, "placeholders present").toBeGreaterThan(0);
    expect(r.first).toBe("pool");
  }, 120_000);
  it("flushes a pending save when the page is left before the debounce fires", async () => {
    const r = await open("leave");
    expect(r.first).toBe("pool");
  }, 120_000);
});
