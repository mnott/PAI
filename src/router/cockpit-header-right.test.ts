/** The header's right group (live stamp, reset, theme) stays at the right edge, with the newer-build link hidden or shown.
 *  Headless Chromium, skipped when none is installed. */

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleCockpit, setCockpitBuildId } from "./cockpit.js";
import { CHROME, dumpDom, killChromes } from "./cdp-browser.js";

const PROBE = `<script>setTimeout(function(){var s=document.getElementById("stamp").getBoundingClientRect(),h=document.querySelector("header").getBoundingClientRect(),n=document.getElementById("newer");
document.body.setAttribute("data-r",JSON.stringify({gap:Math.round(h.right-s.right),newerShown:n.offsetParent!==null,newerBeforeStamp:n.getBoundingClientRect().right<=s.left}))},2000)</script>`;

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
    res.end(sent.body.replace("</body>", PROBE + "</body>"));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => { killChromes(); server?.close(); setCockpitBuildId(null); });

async function probe() {
  const dom = await dumpDom(`${base}/page`, { width: 1500, height: 800, budgetMs: 6000 });
  const m = /data-r="([^"]*)"/.exec(dom);
  if (!m) throw new Error("no probe result in dump");
  return JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
}

describe.skipIf(!CHROME)("header right group at 1500 px", () => {
  it("newer link hidden: the live stamp sits at the header's right edge", async () => {
    pollBuild = "A";
    const r = await probe();
    expect(r.newerShown).toBe(false);
    expect(r.gap).toBeLessThan(120);
  }, 30000);
  it("newer link shown: it sits left of the stamp and the stamp stays at the right edge", async () => {
    pollBuild = "B";
    const r = await probe();
    expect(r.newerShown).toBe(true);
    expect(r.newerBeforeStamp).toBe(true);
    expect(r.gap).toBeLessThan(120);
  }, 30000);
});
