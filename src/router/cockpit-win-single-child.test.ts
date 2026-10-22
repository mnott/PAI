/**
 * A group with exactly one visible child group draws no header for that child: its cards fill the parent body;
 * a second visible child brings the header back. Real page in headless Chromium. Skipped when no Chromium is installed.
 */

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cockpitHtml } from "./cockpit-page.js";
import { fixtureData, fixtureLimits, fixturePoolWithSlot, fixtureQueue, fixtureSystem } from "./cockpit-fixtures.js";
import { join } from "node:path";
import { CHROME, dumpDom, killChromes, screenshot } from "./cdp-browser.js";

const SCRIPT = `
var f=document.getElementById("f"),res={};
function H(id){var e=f.contentDocument.querySelector('[data-card="'+id+'"]');if(!e)return null;var h=e.querySelector(":scope>.chead"),b=e.getBoundingClientRect();return{hh:h?h.offsetHeight:-1,top:Math.round(b.top),h:Math.round(b.height),disp:e.style.display}}
function snap(){var d=f.contentDocument,n=0,cs=[];Array.prototype.forEach.call(d.querySelectorAll('[data-card="system"] .card:not(.chip)'),function(e){if(e.style.display==="none"||!e.getAttribute("data-card"))return;var r=e.getBoundingClientRect();if(e.getAttribute("data-card").indexOf("system.")===0&&r.height>0)cs.push([e.getAttribute("data-card"),r.left,r.top,r.right,r.bottom])});return{inner:H("sys-metrics"),outer:H("system"),heads:Array.prototype.filter.call(d.querySelectorAll('[data-card="system"] .chead'),function(e){return e.offsetHeight>0&&!e.parentNode.classList.contains("chip")&&e.parentNode.getAttribute("data-type")==="group"}).length,cs:cs}}
function put(){document.body.setAttribute("data-res",JSON.stringify(res))}
function at(ms,fn){setTimeout(function(){fn();put()},ms)}
at(3500,function(){res.before=snap()});
at(4000,function(){f.contentWindow.Win.toggleMin("sys-power");f.contentWindow.Win.toggleMin("sys-servers")});
at(5500,function(){res.solo=snap()});
at(6000,function(){f.contentWindow.Win.toggleMin("sys-power")});
at(7500,function(){res.two=snap()});
`;
const FRAME = `<body style="margin:0"><iframe id="f" src="/page" style="width:1500px;height:5000px;border:0"></iframe><script>${SCRIPT}</script></body>`;

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
    if (url.startsWith("/frame")) { res.setHeader("content-type", "text/html"); return res.end(FRAME); }
    if (url.startsWith("/page")) { res.setHeader("content-type", "text/html"); return res.end(cockpitHtml()); }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => { killChromes(); server?.close(); });


interface Sn { inner: { hh: number; top: number; h: number; disp: string }; outer: { hh: number }; heads: number; cs: [string, number, number, number, number][] }

describe.skipIf(!CHROME)("a group with one visible child group draws no duplicate header", () => {
  it("one visible child group: its header is hidden and cards show; a second visible child brings it back; no overlap", async () => {
    const dom = await dumpDom(`${base}/frame`, { width: 1600, height: 5200, budgetMs: 12000 });
    const m = /data-res="([^"]*)"/.exec(dom);
    if (!m) throw new Error("no result in dump");
    const r = JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&")) as { before: Sn; solo: Sn; two: Sn };
    // before: three child groups, each with a header
    expect(r.before.inner.hh).toBeGreaterThan(0);
    // one visible child: header gone, cards still there
    expect(r.solo.inner.hh).toBe(0);
    expect(r.solo.outer.hh).toBeGreaterThan(0);
    expect(r.solo.heads).toBe(r.before.heads - 2); // was - 3: sys-servers moved to Models
    expect(r.solo.cs.length).toBeGreaterThan(0);
    // two visible children again: header back
    expect(r.two.inner.hh).toBeGreaterThan(0);
    for (const s of [r.before, r.solo, r.two]) {
      for (let i = 0; i < s.cs.length; i++) for (let j = i + 1; j < s.cs.length; j++) {
        const a = s.cs[i]!, b = s.cs[j]!;
        const ov = a[1] < b[3] - 1 && b[1] < a[3] - 1 && a[2] < b[4] - 1 && b[2] < a[4] - 1;
        expect(ov, `${a[0]} overlaps ${b[0]}`).toBe(false);
      }
    }
  }, 30000);
});
