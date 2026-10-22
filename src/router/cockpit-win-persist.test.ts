/**
 * A layout change survives leaving the page: hidden placeholder cards (zero-size, in the default tree) do not
 * block the save, and a save still pending in the debounce is flushed on pagehide.
 * Headless Chromium on the real page with a mock server. Skipped without Chromium.
 */

import { execFile, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cockpitHtml } from "./cockpit-page.js";

const CHROME = process.env.CHROME_BIN ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));

const data = () => ({
  window: "1h", totals: { requests: 5000, input: 9e6, output: 4e5, cacheWrite: 1e6, cacheRead: 9e7, errors: 0, hitRatio: 0.9 },
  byModel: [], series: [], weights: { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 }, cachePause: [], byProvider: [],
  bustParts: {}, bySession: [], workers: [], daily: { models: {}, days: [] }, sessionSplit: null, speed: [], promptByProvider: {}, promptSince: {},
});

let server: Server;
let base = "";
let tmp = "";
const browsers = new Set<ChildProcess>();
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
afterAll(() => { for (const c of browsers) c.kill("SIGKILL"); server?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

function open(mode: string): Promise<{ hidden: number; first: string | null }> {
  const args = ["--headless=new", "--disable-gpu", "--use-mock-keychain", "--password-store=basic", "--no-first-run", "--hide-scrollbars", `--user-data-dir=${join(tmp, "p" + Math.random().toString(36).slice(2))}`, "--window-size=1400,1400", "--virtual-time-budget=8000", "--dump-dom", `${base}/page?mode=${mode}`];
  return new Promise((resolve, reject) => {
    const c = execFile(CHROME!, args, { encoding: "utf8", timeout: 90_000, maxBuffer: 64 << 20 }, (err, stdout) => {
      browsers.delete(c);
      if (err) return reject(err);
      const m = /data-r="([^"]*)"/.exec(stdout);
      if (!m) return reject(new Error("no probe result"));
      resolve(JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&")));
    });
    browsers.add(c);
  });
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
