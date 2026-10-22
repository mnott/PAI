/**
 * A6 win/morph.ts: morph, winHtml, winList (spec 4.2). Headless Chromium drives a page with the
 * morph code and posts one JSON result like cockpit-win-select.test.ts. Skipped when no Chromium.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WIN_MORPH_JS } from "./cockpit-page/win/morph.js";
import { CHROME, dumpDom, killChromes } from "./cdp-browser.js";

const PROBE = `<div id="cb" style="height:60px;overflow:auto"><div data-k="rows" id="rows"></div><button data-k="btn" id="b">go</button></div>
<div id="lst"></div>
<script>
var morph=eval(${JSON.stringify(WIN_MORPH_JS)}+";morph");
var winHtml=eval(${JSON.stringify(WIN_MORPH_JS)}+";winHtml");
var winList=eval(${JSON.stringify(WIN_MORPH_JS)}+";winList");
window.onerror=function(m,s,l,c){window.__err=String(m)+" @"+l+":"+c};
var r={};
function rowsHtml(ids,suffix){return ids.map(function(i){return '<div data-k="r'+i+'" class="row">row '+i+suffix+'</div>'}).join("")}
setTimeout(function(){
 var cb=document.getElementById("cb"),rows=document.getElementById("rows"),b=document.getElementById("b");
 // keyed identity
 morph(rows,rowsHtml([1,2,3,4,5,6,7,8,9,10],""));
 var e2=rows.querySelector('[data-k="r2"]'),e5=rows.querySelector('[data-k="r5"]');
 morph(rows,rowsHtml([5,2,11,1,3,4,6,7,8,9,10],"!"));
 r.ident2=rows.querySelector('[data-k="r2"]')===e2;
 r.ident5=rows.querySelector('[data-k="r5"]')===e5;
 r.order=Array.prototype.map.call(rows.children,function(x){return x.getAttribute("data-k")}).join(",");
 r.text5=e5.textContent;
 morph(rows,rowsHtml([5,2],"!"));
 r.afterRemove=rows.children.length;r.ident5b=rows.querySelector('[data-k="r5"]')===e5;
 // scroll
 morph(rows,rowsHtml([1,2,3,4,5,6,7,8,9,10,11,12],""));
 cb.scrollTop=40;var st=cb.scrollTop;
 morph(rows,rowsHtml([1,2,3,4,5,6,7,8,9,10,11,12],"x"));
 r.scrollBefore=st;r.scrollAfter=cb.scrollTop;
 // focus
 b.focus();
 morph(cb,'<div data-k="rows" id="rows">'+rowsHtml([1,2],"y")+'</div><button data-k="btn" id="b" class="hot">go2</button>');
 r.sameBtn=document.getElementById("b")===b;r.focused=document.activeElement===b;r.btnText=b.textContent;r.btnCls=b.className;
 // identical html: no mutation
 var lst=document.getElementById("lst");
 winHtml(lst,'<p data-k="a" class="x">hi <b>there</b></p><span>t</span>');
 var n=0,mo=new MutationObserver(function(m){n+=m.length});
 mo.observe(lst,{childList:true,subtree:true,attributes:true,characterData:true});
 var ret=winHtml(lst,'<p data-k="a" class="x">hi <b>there</b></p><span>t</span>');
 morph(lst,'<p data-k="a" class="x">hi <b>there</b></p><span>t</span>');
 setTimeout(function(){
  r.mutIdentical=n;r.retSkipped=ret===false;
  // winList
  var l2=document.createElement("div");document.body.appendChild(l2);
  function mk(it){var d=document.createElement("div");d.textContent=it.id;return d}
  function upd(row,it){if(row.getAttribute("data-v")!==it.v)row.setAttribute("data-v",it.v)}
  function key(it){return it.id}
  winList(l2,[{id:"a",v:"1"},{id:"b",v:"1"},{id:"c",v:"1"}],key,mk,upd);
  var ea=l2.children[0],ec=l2.children[2];
  winList(l2,[{id:"c",v:"2"},{id:"d",v:"1"},{id:"a",v:"1"}],key,mk,upd);
  r.listOrder=Array.prototype.map.call(l2.children,function(x){return x.getAttribute("data-k")}).join(",");
  r.listIdent=l2.children[0]===ec&&l2.children[2]===ea;
  r.listUpd=ec.getAttribute("data-v");
  var n2=0,mo2=new MutationObserver(function(m){n2+=m.length});
  mo2.observe(l2,{childList:true,subtree:true,attributes:true,characterData:true});
  winList(l2,[{id:"c",v:"2"},{id:"d",v:"1"},{id:"a",v:"1"}],key,mk,upd);
  setTimeout(function(){
   r.listMut=n2;
   document.body.setAttribute("data-probe",JSON.stringify(r));
  },20);
 },20);
},50);
</script>`;

let tmp = "";
let server: Server;
let base = "";
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "cockpit-win-morph-"));
  server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><html><body style="margin:0">${PROBE}<script>setTimeout(function(){if(window.__err)document.body.setAttribute("data-err",window.__err)},300)</script></body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => { killChromes(); server?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

describe.skipIf(!CHROME)("win morph (A6, spec 4.2) in Chromium", () => {
  it("keyed identity, scrollTop, focus, zero mutations on identical html, keyed list", async () => {
    const o = { width: 800, height: 600, budgetMs: 3000, scrollbars: false };
    const url = base;
    const dom = await dumpDom(url, o);
    const e = /data-err="([^"]*)"/.exec(dom);
    if (e && e[1]) throw new Error(`page error: ${e[1]}`);
    const m = /data-probe="([^"]*)"/.exec(dom);
    if (!m) throw new Error("no probe result");
    const r = JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
    expect(r.ident2, "keyed row r2 keeps identity across reorder").toBe(true);
    expect(r.ident5, "keyed row r5 keeps identity when moved to the front").toBe(true);
    expect(r.order).toBe("r5,r2,r11,r1,r3,r4,r6,r7,r8,r9,r10");
    expect(r.text5, "text updated in place").toBe("row 5!");
    expect(r.afterRemove, "removed rows are gone").toBe(2);
    expect(r.ident5b).toBe(true);
    expect(r.scrollBefore, "scroller actually scrolled").toBeGreaterThan(0);
    expect(r.scrollAfter, "scrollTop survives").toBe(r.scrollBefore);
    expect(r.sameBtn, "focused button is the same element").toBe(true);
    expect(r.focused, "focus survives").toBe(true);
    expect(r.btnText).toBe("go2");
    expect(r.btnCls).toBe("hot");
    expect(r.mutIdentical, "identical html: 0 mutations").toBe(0);
    expect(r.retSkipped, "winHtml reports skipped").toBe(true);
    expect(r.listOrder).toBe("c,d,a");
    expect(r.listIdent, "list rows reused and reordered").toBe(true);
    expect(r.listUpd).toBe("2");
    expect(r.listMut, "identical list: 0 mutations").toBe(0);
  }, 120_000);
});
