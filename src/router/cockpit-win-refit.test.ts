/**
 * A container width change is a layout event: every auto-fitted card is re-measured at the new width and takes its content height
 * (grow and shrink). The real page in headless Chromium, an iframe resized 1500 -> 600 -> 1500; no card body scrolls for content
 * that fits (charts and tables/lists capped at FIT_MAX excepted) and no card has more than 24 px slack.
 * PAI_REFIT_TABLE=<file> writes the readings. Skipped when no Chromium is installed.
 */

import { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cockpitHtml } from "./cockpit-page.js";
import { fixtureData, fixtureLimits, fixturePoolWithSlot, fixtureQueue, fixtureSystem } from "./cockpit-fixtures.js";
import { CHROME, dumpDom, killChromes } from "./cdp-browser.js";

const READ = `function readAll(f){var d=f.contentDocument,out=[];d.querySelectorAll("[data-card]").forEach(function(c){var b=c.querySelector(".cbody"),h=c.getBoundingClientRect();if(!h.height||c.classList.contains("min")||!b)return;var low=0,top=b.getBoundingClientRect().top;Array.prototype.slice.call(b.children).forEach(function(k){var r=k.getBoundingClientRect();if(r.height>0)low=Math.max(low,r.bottom-top)});out.push({id:c.getAttribute("data-card"),type:c.getAttribute("data-type"),h:Math.round(h.height),head:Math.round(top-h.top),content:Math.round(low),sh:b.scrollHeight,ch:b.clientHeight,group:c.querySelector("[data-card]")?1:0})});return out}`;
const FRAME = `<body style="margin:0"><iframe id="f" src="/page" style="width:1500px;height:5000px;border:0"></iframe><script>${READ}
var f=document.getElementById("f"),res={};
function step(name,w,ms){setTimeout(function(){if(w)f.style.width=w+"px";setTimeout(function(){res[name]=readAll(f);document.body.setAttribute("data-fit",JSON.stringify(res))},1200)},ms)}
step("a",0,3000);step("b",600,4500);step("c",1500,7000);
</script></body>`;

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

interface Rd { id: string; type: string; h: number; head: number; content: number; sh: number; ch: number; group: number }

describe.skipIf(!CHROME)("width change re-fits card heights", () => {
  it("1500 -> 600 -> 1500: no inner scroll for fitting content, no card with > 24 px slack", async () => {
    const dom = await dumpDom(`${base}/frame`, { width: 1600, height: 5200, budgetMs: 14000 });
    const m = /data-fit="([^"]*)"/.exec(dom);
    if (!m) throw new Error("no result in dump");
    const all = JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&")) as Record<string, Rd[]>;
    const f = process.env.PAI_REFIT_TABLE;
    const bad: string[] = [];
    let table = "";
    for (const k of ["a", "b", "c"]) {
      expect(all[k]?.length, `reading ${k}`).toBeGreaterThan(10);
      for (const c of all[k]!) {
        if (c.group) continue;
        const scroll = c.sh > c.ch + 1, slack = c.h - c.head - c.content;
        const capped = c.type === "chart" || c.h >= 360 || c.type === "table" || c.type === "list";
        table += `${k}\t${c.id}\t${c.type}\th=${c.h}\tcontent=${c.content}\tscroll=${scroll ? 1 : 0}\tslack=${slack}\n`;
        if (capped && c.type !== "table" && c.type !== "list") continue;
        if (scroll && !capped) bad.push(`${k} ${c.id} scrolls (sh=${c.sh} ch=${c.ch})`);
        if (c.type !== "chart" && c.h < 360 && slack > 24) bad.push(`${k} ${c.id} slack ${slack}`);
      }
    }
    if (f) writeFileSync(f, table);
    expect(bad).toEqual([]);
  }, 40000);
});
