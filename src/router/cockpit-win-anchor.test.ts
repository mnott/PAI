/**
 * A8 win/anchor.ts: anchor keeper (spec 4.3). Headless Chromium drives a page with absolutely
 * placed cards and posts one JSON result like cockpit-win-morph.test.ts. Skipped when no Chromium.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WIN_ANCHOR_JS } from "./cockpit-page/win/anchor.js";
import { CHROME, dumpDom, killChromes } from "./cdp-browser.js";

const PROBE = `<div id="main" style="position:relative;height:3000px"></div>
<script>
eval(${JSON.stringify(WIN_ANCHOR_JS)});
window.onerror=function(m,s,l,c){window.__err=String(m)+" @"+l+":"+c};
var main=document.getElementById("main"),r={};
function card(id,top){var d=document.createElement("div");d.className="card";d.setAttribute("data-card",id);
 d.style.cssText="position:absolute;left:0;width:300px;height:180px;contain:strict;overflow:hidden;top:"+top+"px";
 var b=document.createElement("div");b.className="cbody";d.appendChild(b);main.appendChild(d);return d}
var cards=[];for(var i=0;i<12;i++)cards.push(card("c"+i,i*200));
function rects(){return cards.map(function(c){var x=c.getBoundingClientRect();return[x.left,x.top,x.width,x.height].join(",")}).join("|")}
function run(){
 var A=anchorInit(document,window,main);
 window.scrollTo(0,600);A.track();
 r.anchorId=A.tracked&&A.tracked.id;
 var before=rects(),y0=window.scrollY,n=0;
 var body=cards[3].firstChild;
 function grow(){
  body.appendChild(document.createElement("p")).textContent="line "+n;
  body.style.minHeight=(n*20)+"px";
  if(++n<8)return setTimeout(grow,15);
  setTimeout(function(){
   r.yAfterGrow=window.scrollY;r.y0=y0;r.rectsSame=rects()===before;r.drifts=A.drifts;
   // structural add above the anchor: every card shifts down 100, keeper compensates
   var idx=cards.indexOf(A.tracked.el),off0=A.tracked.el.getBoundingClientRect().top,el=A.tracked.el;
   A.keep(function(){for(var j=0;j<cards.length;j++)cards[j].style.top=(parseFloat(cards[j].style.top)+100)+"px"});
   r.yAfterAdd=window.scrollY;
   r.offKept=Math.abs(el.getBoundingClientRect().top-off0)<1;
   r.globalKeep=typeof anchorKeep==="function";
   // mutation-driven drift is corrected and logged
   var logs=[];var oc=console.log;console.log=function(){logs.push(Array.prototype.join.call(arguments," "))};
   A.debug=true;A.lastScroll=-1e9;
   var el2=el,o2=el2.getBoundingClientRect().top;
   el2.style.marginTop="0px";
   for(var j=0;j<cards.length;j++)cards[j].style.top=(parseFloat(cards[j].style.top)+40)+"px";
   setTimeout(function(){
    console.log=oc;
    r.mutFixed=Math.abs(el2.getBoundingClientRect().top-o2)<1;
    r.log=logs.join(";");r.dbg=[A.pending,A.drifts,A.tracked&&A.tracked.offset,el2.getBoundingClientRect().top,o2,window.scrollY].join(",");
    document.body.setAttribute("data-probe",JSON.stringify(r));
   },1000);
  },100);
 }
 grow();
}
setTimeout(run,50);
</script>`;

let tmp = "";
let server: Server;
let base = "";
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "cockpit-win-anchor-"));
  server = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><html><body style="margin:0">${PROBE}<script>setTimeout(function(){if(window.__err)document.body.setAttribute("data-err",window.__err)},2500)</script></body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => { killChromes(); server?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

describe("win anchor source", () => {
  it("is ES5 text with the spec names", () => {
    for (const n of ["anchorInit", "anchorKeep", "debug", "anchor", "[anchor] drift"]) expect(WIN_ANCHOR_JS).toContain(n);
  });
});

describe.skipIf(!CHROME)("win anchor (A8, spec 4.3) in Chromium", () => {
  it("content growth leaves scroll and rects; structural add compensates once", async () => {
    const o = { width: 800, height: 600, budgetMs: 8000, scrollbars: false };
    const url = `${base}/?debug=scroll`;
    const dom = await dumpDom(url, o);
    const e = /data-err="([^"]*)"/.exec(dom);
    if (e && e[1]) throw new Error(`page error: ${e[1]}`);
    const m = /data-probe="([^"]*)"/.exec(dom);
    if (!m) throw new Error("no probe result");
    const r = JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
    expect(r.y0, "scrolled to 600").toBe(600);
    expect(r.anchorId).toBe("c3");
    expect(r.yAfterGrow, "scrollY unchanged by slot content growth").toBe(600);
    expect(r.rectsSame, "no card rect changed").toBe(true);
    expect(r.drifts, "keeper never had to act").toBe(0);
    expect(r.yAfterAdd, "structural add compensated by 100").toBe(700);
    expect(r.offKept, "anchor keeps its viewport offset").toBe(true);
    expect(r.globalKeep).toBe(true);
    expect(r.mutFixed, "mutation drift corrected "+r.dbg).toBe(true);
    expect(r.log).toContain("[anchor] drift 40 px");
  }, 120_000);
});
