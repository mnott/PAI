/**
 * Registry backups rows never break inside a word: at narrow card widths the button group drops whole under the name,
 * no button overflows its box and every button label stays on one line (headless Chromium, skipped when none is installed).
 */

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cockpitHtml } from "./cockpit-page.js";
import { WIN_REGISTRY_JS } from "./cockpit-page/win/cards-registry.js";
import { CHROME, dumpDom, killChromes } from "./cdp-browser.js";

// wrgBackupsHtml is private to the card script: lift its source out and run it in the page.
const FN = WIN_REGISTRY_JS.slice(WIN_REGISTRY_JS.indexOf("function wrgBackupsHtml"), WIN_REGISTRY_JS.indexOf("var wrgIo=null;"));
const PROBE = `<script>function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;")}
${FN}
setTimeout(function(){
var out={};try{[520,360,300].forEach(function(w){
 var host=document.querySelector("main.win")||document.body,d=document.createElement("div");d.style.cssText="width:"+w+"px;font-size:12px";host.appendChild(d);
 d.innerHTML=wrgBackupsHtml({busy:false,arm:null,delArm:null,editing:null,backups:[{name:"workers.yaml.20261022-105038.bak",size:25088,summary:"+1 -1 lines",label:""}]});
 var r=[];Array.prototype.forEach.call(d.querySelectorAll("button,.mid,.dim"),function(b){var lh=parseFloat(getComputedStyle(b).lineHeight)||18;
  r.push({t:b.textContent,over:b.scrollWidth>b.clientWidth,tall:b.getBoundingClientRect().height>lh*1.6})});
 var row=d.querySelector(".wrg-row").getBoundingClientRect();
 out[w]={items:r,rowW:Math.round(row.width),dw:d.scrollWidth<=w}});
}catch(e){out.err=String(e)}document.body.setAttribute("data-r",JSON.stringify(out))},1500)</script>`;

describe.skipIf(!CHROME)("registry backup rows never break words", () => {
  let server: Server, base = "";
  beforeAll(async () => {
    server = createServer((req, res) => {
      if ((req.url ?? "").startsWith("/page")) {
        res.setHeader("content-type", "text/html");
        return res.end(cockpitHtml().replace("</body>", PROBE + "</body>"));
      }
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => { killChromes(); server?.close(); });

  it("no button or name overflows or wraps at card widths 520/360/300", async () => {
    const dom = await dumpDom(`${base}/page`, { width: 1400, height: 1000, budgetMs: 8000 });
    const m = /data-r="([^"]*)"/.exec(dom);
    if (!m) throw new Error("no probe result in dump");
    const out = JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
    for (const w of ["520", "360", "300"]) {
      expect(out.err).toBeUndefined();expect(out[w].items.length).toBeGreaterThanOrEqual(6);
      for (const it of out[w].items) { expect(it.over, `${w} ${it.t} overflows`).toBe(false); expect(it.tall, `${w} ${it.t} wraps`).toBe(false); }
      expect(out[w].dw, `${w} row overflows its card`).toBe(true);
    }
  }, 120_000);
});
