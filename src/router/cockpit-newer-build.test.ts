/** An open page learns the router serves a newer build: the page carries its build id, /cockpit/data carries the current one;
 *  a differing id shows the header reload link, the same id shows nothing. Headless Chromium, skipped when none is installed. */

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleCockpit, setCockpitBuildId } from "./cockpit.js";
import { CHROME, dumpDom, killChromes } from "./cdp-browser.js";

const PROBE = `<script>setTimeout(function(){var a=document.getElementById("newer");
document.body.setAttribute("data-r",JSON.stringify({hidden:a.hidden,shown:a.offsetParent!==null,tag:a.tagName,title:!!a.title,wired:typeof a.onclick==="function",inHeader:!!a.closest("header"),below:a.previousElementSibling===document.querySelector("header"),h:Math.round(a.getBoundingClientRect().height),text:a.textContent,err:window.__err||null}))},2000)</script>`;

let server: Server;
let base = "";
let pollBuild = "A";
beforeAll(async () => {
  setCockpitBuildId("A");
  server = createServer((req, res) => {
    if ((req.url ?? "").startsWith("/cockpit/data")) {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ window: "1h", build: pollBuild, totals: { requests: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, errors: 0, hitRatio: 0 }, byModel: [], series: [], byProvider: [], bySession: [], cachePause: [], speed: [], promptByProvider: {} }));
    }
    if ((req.url ?? "").startsWith("/cockpit/")) return res.setHeader("content-type", "application/json"), res.end("{}");
    const sent = { body: "" };
    const fake = { setHeader: () => undefined, writeHead: () => undefined, end: (b: string) => void (sent.body = b) } as never;
    handleCockpit({ url: "/cockpit", method: "GET" } as never, fake, { get: async () => [] } as never, () => [], () => new Map(), undefined, () => []);
    res.setHeader("content-type", "text/html");
    res.end(sent.body.replace("</head>", '<script>window.onerror=function(m){window.__err=String(m)}</script></head>').replace("</body>", PROBE + "</body>"));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => { killChromes(); server?.close(); setCockpitBuildId(null); });

async function probe() {
  const dom = await dumpDom(`${base}/page`, { width: 1200, height: 800, budgetMs: 6000 });
  const m = /data-r="([^"]*)"/.exec(dom);
  if (!m) throw new Error("no probe result in dump");
  return JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
}

describe.skipIf(!CHROME)("newer cockpit build notice", () => {
  it("poll returns build B for a page served as A: the reload bar shows below the header", async () => {
    pollBuild = "B";
    const r = await probe();
    expect(r.err).toBeNull();
    expect(r).toMatchObject({ hidden: false, shown: true, tag: "A", title: true, wired: true, inHeader: false, below: true });
    expect(r.h).toBeLessThan(30);
    expect(r.text).toContain("newer cockpit available");
  }, 30000);
  it("poll returns build A: no notice", async () => {
    pollBuild = "A";
    const r = await probe();
    expect(r.err).toBeNull();
    expect(r).toMatchObject({ hidden: true, shown: false });
  }, 30000);
});
