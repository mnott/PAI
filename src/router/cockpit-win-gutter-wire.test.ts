/**
 * A12 wiring — resize gutters live in the card runtime (win/card.ts + win/gutter.ts). Headless Chromium
 * with synthetic PointerEvents/KeyboardEvents; one JSON result like cockpit-win-dragdrop.test.ts.
 * Skipped when no Chromium is installed.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WIN_ANCHOR_JS } from "./cockpit-page/win/anchor.js";
import { WIN_CARD_JS } from "./cockpit-page/win/card.js";
import { WIN_INFO_JS } from "./cockpit-page/win/info.js";
import { WIN_LAYOUT_JS } from "./cockpit-page/win/layout.js";
import { WIN_MORPH_JS } from "./cockpit-page/win/morph.js";
import { WIN_STORE_JS } from "./cockpit-page/win/store.js";
import { WIN_TREE_JS } from "./cockpit-page/win/tree.js";
import { CHROME, dumpDom, killChromes } from "./cdp-browser.js";

const cssSrc = readFileSync(fileURLToPath(new URL("./cockpit-page/css.ts", import.meta.url)), "utf8");
const cm = cssSrc.match(/export const css = \(L: CockpitLayout[^`]*`([\s\S]*?)`;/);
if (!cm) throw new Error("css rules not found in cockpit-page/css.ts");
const STYLE = cm[1]!;

const JS = [WIN_TREE_JS, WIN_LAYOUT_JS, WIN_MORPH_JS, WIN_STORE_JS, WIN_INFO_JS, WIN_CARD_JS, WIN_ANCHOR_JS].join("\n");

const PAGE = `<!doctype html><html><head><style>${STYLE}</style></head><body style="margin:0"><header></header><main id="m" style="margin:0"></main>
<script>
window.onerror=function(m,s,l,c){window.__err=String(m)+" @"+l+":"+c};
localStorage.clear();
${JS}
var r={},J=JSON.stringify;
Win.registerType("t",{minW:200,defaultH:150});
function mk(){return split("c",[split("r",[leaf("a"),leaf("b")],[0.5,0.5]),leaf("g")],[200,300])}
function mkKids(){return {g:split("r",[leaf("x"),leaf("y")],[0.5,0.5])}}
var cards=[{id:"a",type:"t",title:"Alpha"},{id:"b",type:"t",title:"Beta"},{id:"g",type:"group",title:"Grp"},{id:"x",type:"t",title:"X"},{id:"y",type:"t",title:"Y"}];
var m=document.getElementById("m");
function init(el){Win.init(el,{tree:mk(),kids:mkKids(),stDefaults:{},cards:cards},{storage:localStorage})}
init(m);
function W(id){return Math.round(Win.el(id).getBoundingClientRect().width*10)/10}
function ptr(type,t,x,y){t.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,clientX:x,clientY:y,pointerType:"mouse",button:0,pointerId:1}))}
function gut(key,path){return document.querySelector('.wgutter[data-key="'+key+'"][data-path="'+path+'"][data-index="0"]')}
function dragG(g,dx){var b=g.getBoundingClientRect(),x=b.left+b.width/2,y=b.top+b.height/2;ptr("pointerdown",g,x,y);ptr("pointermove",document,x+dx,y);ptr("pointerup",document,x+dx,y)}
setTimeout(function(){
 var g0=gut("","0");
 r.count=document.querySelectorAll(".wgutter").length;
 r.attrs=g0?[g0.getAttribute("data-path"),g0.getAttribute("data-index"),g0.getAttribute("data-axis")].join("|"):"none";
 r.before=[W("a"),W("b")];
 dragG(g0,80);
 r.after=[W("a"),W("b")];
 r.dA=Math.round((r.after[0]-r.before[0])*10)/10;r.dB=Math.round((r.before[1]-r.after[1])*10)/10;
 r.sameEl=gut("","0")===g0;
 Win.update("none",{});
 r.afterUpdate=[W("a"),W("b")];
 dragG(g0,2000);
 r.afterTooFar=[W("a"),W("b")];
 g0.focus();
 var k0=W("a");
 g0.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true,cancelable:true}));
 r.kbGrow=Math.round((W("a")-k0)*10)/10;
 g0.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowLeft",bubbles:true,cancelable:true}));
 r.kbBack=Math.round((W("a")-k0)*10)/10;
 r.kbFocus=document.activeElement===gut("","0");
 r.gBefore=[W("x"),W("y")];
 var gg=gut("g","");
 r.gExists=!!gg;
 if(gg){dragG(gg,60);r.gAfter=[W("x"),W("y")]}
 function TK(){var s=Win.state();return J([s.tree,s.kids])}var want=TK();
 Win.flush();
 var wantA=W("a"),wantX=W("x");
 setTimeout(function(){
  Win.flush();
  var m2=document.createElement("main");m2.id="m2";m2.style.margin="0";document.body.appendChild(m2);
  m.remove();
  init(m2);
  r.reloadA=W("a")===wantA;r.reloadX=W("x")===wantX;r.reloadTree=TK()===want;
  r.reloadW=[W("a"),W("b"),wantA];
  document.body.setAttribute("data-probe",J(r));
 },400);
},50);
</script></body></html>`;

let tmp = "";
let server: Server;
let base = "";
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "cockpit-win-gutter-"));
  server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(PAGE.replace("</body>", `<script>setTimeout(function(){if(window.__err)document.body.setAttribute("data-err",window.__err)},900)</script></body>`));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => { killChromes(); server?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

describe.skipIf(!CHROME)("win resize gutters wired (A12, spec 3.3) in Chromium", () => {
  it("drag resizes both neighbours, survives updates and reload, arrows resize, group bodies too", async () => {
    const o = { width: 1000, height: 900, budgetMs: 4000, scrollbars: false };
    const url = base;
    const dom = await dumpDom(url, o);
    const e = /data-err="([^"]*)"/.exec(dom);
    if (e && e[1]) throw new Error(`page error: ${e[1]}`);
    const m = /data-probe="([^"]*)"/.exec(dom);
    if (!m) throw new Error("no probe result");
    const r = JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
    expect(r.attrs, "gutter between a and b carries path/index/axis").toBe("0|0|x");
    expect(r.count, "root row, root band, group row").toBe(3);
    expect(r.dA, `a grew by 80 (${JSON.stringify(r.before)} -> ${JSON.stringify(r.after)})`).toBe(80);
    expect(r.dB, "b shrank by 80").toBe(80);
    expect(r.sameEl, "the gutter element survives the relayout").toBe(true);
    expect(r.afterUpdate, "a data update changes no size").toEqual(r.after);
    expect(r.afterTooFar, "a drag below the min width is refused").toEqual(r.after);
    expect(r.kbGrow, "ArrowRight grows the left neighbour").toBe(16);
    expect(r.kbBack, "ArrowLeft shrinks it back").toBe(0);
    expect(r.kbFocus, "focus stays on the gutter").toBe(true);
    expect(r.gExists, "group body has its gutter").toBe(true);
    expect(r.gAfter[0] - r.gBefore[0], `group neighbours resize ${JSON.stringify(r.gBefore)} -> ${JSON.stringify(r.gAfter)}`).toBeGreaterThan(0);
    expect(r.reloadA, "reload restores a's width " + JSON.stringify(r.reloadW)).toBe(true);
    expect(r.reloadX, "reload restores x's width").toBe(true);
    expect(r.reloadTree).toBe(true);
  }, 90_000);
});
