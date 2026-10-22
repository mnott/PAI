/**
 * A7 win/dragdrop.ts — pointer and keyboard drag wired to moveCard (spec 3.3, 5.3). Headless Chromium
 * with synthetic PointerEvents/KeyboardEvents; one JSON result like cockpit-win-dom.test.ts.
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
import { WIN_DRAGDROP_JS } from "./cockpit-page/win/dragdrop.js";
import { WIN_DROP_JS } from "./cockpit-page/win/drop.js";
import { WIN_INFO_JS } from "./cockpit-page/win/info.js";
import { WIN_LAYOUT_JS } from "./cockpit-page/win/layout.js";
import { WIN_MORPH_JS } from "./cockpit-page/win/morph.js";
import { WIN_STORE_JS } from "./cockpit-page/win/store.js";
import { WIN_TREE_JS } from "./cockpit-page/win/tree.js";
import { CHROME, dumpDom, killChromes } from "./cdp-browser.js";

// the real stylesheet, pulled from css.ts like win-info.test.ts does
const cssSrc = readFileSync(fileURLToPath(new URL("./cockpit-page/css.ts", import.meta.url)), "utf8");
const cm = cssSrc.match(/export const css = \(L: CockpitLayout[^`]*`([\s\S]*?)`;/);
if (!cm) throw new Error("css rules not found in cockpit-page/css.ts");
const STYLE = cm[1]!;

const JS = [WIN_TREE_JS, WIN_LAYOUT_JS, WIN_MORPH_JS, WIN_STORE_JS, WIN_INFO_JS, WIN_DROP_JS, WIN_CARD_JS, WIN_ANCHOR_JS, WIN_DRAGDROP_JS].join("\n");

const PAGE = `<!doctype html><html><head><style>${STYLE}</style></head><body style="margin:0"><header></header><main id="m"></main>
<script>
window.onerror=function(m,s,l,c){window.__err=String(m)+" @"+l+":"+c};
localStorage.clear();
${JS}
var r={};
Win.registerType("t",{minW:200,defaultH:150});
function mk(){return split("c",[leaf("a"),leaf("b"),leaf("c")],[1,1,1])}
var cards=[{id:"a",type:"t",title:"Alpha"},{id:"b",type:"t",title:"Beta"},{id:"c",type:"t",title:"Gamma"}];
var m=document.getElementById("m");
Win.init(m,{tree:mk(),kids:{},stDefaults:{},cards:cards},{storage:localStorage});
winDragInit(document,window,{pressMs:50});
var J=JSON.stringify;
function R(id){return Win.el(id).getBoundingClientRect()}
function ptr(type,t,x,y,pt){var e=new PointerEvent(type,{bubbles:true,cancelable:true,clientX:x,clientY:y,pointerType:pt||"mouse",button:0});t.dispatchEvent(e)}
function drag(id,tid,fx,fy,pt){
 var g=Win.el(id).querySelector(".cgrip"),b=R(tid);
 ptr("pointerdown",g,5,5,pt);
 ptr("pointermove",window,b.left+b.width*fx,b.top+b.height*fy,pt);
}
function drop(tid,fx,fy){var b=R(tid);ptr("pointerup",window,b.left+b.width*fx,b.top+b.height*fy)}
function key(t,k,o){var e=new KeyboardEvent("keydown",Object.assign({key:k,bubbles:true,cancelable:true},o||{}));t.dispatchEvent(e)}
function reset(){var st=Win.state().st;for(var k in st)delete st[k].w;Win.apply("",mk())}
function rowReset(){reset();var st=Win.state().st;st.a=st.a||{};st.b=st.b||{};st.a.w=6;st.b.w=6;Win.relayout()}
function tr(){return J(Win.state().tree)}
setTimeout(function(){
 var t0=tr();r.t0=t0;
 // 1. a to the bottom edge of b: b over a inside the row cell
 drag("a","b",0.5,0.95);
 var ind=document.querySelector(".dropind");
 r.indShown=!!ind;r.indBad=ind&&ind.classList.contains("bad");r.indZone=ind&&ind.getAttribute("data-zone");
 r.treeDuring=tr()===t0;
 drop("b",0.5,0.95);
 r.indGone=!document.querySelector(".dropind");
 r.stack=tr();
 var ra=R("a"),rb=R("b");
 r.stackRects=[Math.round(rb.left),Math.round(rb.top),Math.round(ra.left),Math.round(ra.top),Math.round(ra.width)===Math.round(rb.width)].join(",");
 r.stackA=ra.top>=rb.bottom&&Math.round(ra.left)===Math.round(rb.left);
 // 2. a to the right edge of c: a two-up
 reset();
 drag("a","c",0.95,0.5);drop("c",0.95,0.5);
 r.twoUp=tr();
 var rc=R("c");ra=R("a");
 r.twoUpRects=ra.left>rc.left&&Math.round(ra.top)===Math.round(rc.top)&&Math.round(ra.width)===Math.round(rc.width);
 // 3. Esc cancels
 reset();var before=tr();
 drag("a","c",0.5,0.95);
 key(window,"Escape");
 r.escIndGone=!document.querySelector(".dropind");
 drop("c",0.5,0.95);
 r.escSame=tr()===before;
 // pointercancel
 drag("a","c",0.5,0.95);ptr("pointercancel",window,0,0);drop("c",0.5,0.95);
 r.cancelSame=tr()===before;
 // middle = none
 drag("a","c",0.5,0.5);r.midInd=!!document.querySelector(".dropind");drop("c",0.5,0.5);r.midSame=tr()===before;
 // touch: not armed before the long press; armed after
 drag("a","c",0.5,0.95,"touch");r.touchEarly=!!document.querySelector(".dropind");
 ptr("pointerup",window,0,0);
 // 4. keyboard
 rowReset();
 var g=Win.el("a").querySelector(".cgrip");g.focus();
 key(g,"Enter");r.pressed=g.getAttribute("aria-pressed");r.grabbed=Win.el("a").querySelector(".cgrip").getAttribute("aria-pressed");
 key(g,"ArrowRight");
 r.kbRight=tr();r.kbFocus=document.activeElement===Win.el("a").querySelector(".cgrip");
 r.live=document.querySelector(".cwlive").textContent;
 key(g,"Escape");
 r.kbEsc=tr()===before;r.kbEscPressed=g.getAttribute("aria-pressed");
 key(g,"Enter");key(g,"ArrowDown");key(g,"Enter");
 r.kbDown=tr();r.kbDropped=g.getAttribute("aria-pressed");
 rowReset();
 key(g,"ArrowRight",{altKey:true});r.altMove=tr();
 rowReset();key(g,"ArrowRight");r.noGrabNoMove=tr()===before;
 // 6. reload restores the arrangement
 reset();
 drag("a","c",0.95,0.5);drop("c",0.95,0.5);
 var want=tr();
 Win.flush();
 setTimeout(function(){
  Win.flush();
  var m2=document.createElement("main");m2.id="m2";document.body.appendChild(m2);
  Win.init(m2,{tree:mk(),kids:{},stDefaults:{},cards:cards},{storage:localStorage});
  r.reload=tr()===want;r.want=want;
  document.body.setAttribute("data-probe",J(r));
 },400);
},50);
</script></body></html>`;

let tmp = "";
let server: Server;
let base = "";
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "cockpit-win-dom-"));
  server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(PAGE.replace("</body>", `<script>setTimeout(function(){if(window.__err)document.body.setAttribute("data-err",window.__err)},900)</script></body>`));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => { killChromes(); server?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

describe.skipIf(!CHROME)("win drag and drop (A7, spec 3.3/5.3) in Chromium", () => {
  it("pointer stack and two-up, Esc/cancel/middle leave the tree, keyboard flow, reload restores", async () => {
    const o = { width: 1000, height: 900, budgetMs: 4000, scrollbars: false };
    const url = base;
    const dom = await dumpDom(url, o);
    const e = /data-err="([^"]*)"/.exec(dom);
    if (e && e[1]) throw new Error(`page error: ${e[1]}`);
    const m = /data-probe="([^"]*)"/.exec(dom);
    if (!m) throw new Error("no probe result");
    const r = JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
    expect(r.indShown, "zone indicator shown while dragging").toBe(true);
    expect(r.indBad).toBe(false);
    expect(r.indZone).toBe("bottom");
    expect(r.treeDuring, "nothing changes during the drag").toBe(true);
    expect(r.indGone, "indicator removed on drop").toBe(true);
    expect(r.stackA, "a under b " + r.stack + " " + r.stackRects).toBe(true);
    expect(r.twoUpRects, "a is beside c, same width").toBe(true);
    expect(r.escIndGone).toBe(true);
    expect(r.escSame, "Esc leaves the tree unchanged").toBe(true);
    expect(r.cancelSame, "pointercancel leaves the tree unchanged").toBe(true);
    expect(r.midInd, "middle zone shows no indicator").toBe(false);
    expect(r.midSame).toBe(true);
    expect(r.touchEarly, "touch before the long press does not drag").toBe(false);
    expect(r.pressed).toBe("true");
    expect(r.kbRight, "arrow right moves a to the right of b").not.toBe(r.t0);
    expect(JSON.parse(r.kbRight).ch.map((c: any) => c.id).join()).toBe("b,a,c");
    expect(r.kbFocus, "focus stays on the grip").toBe(true);
    expect(r.live).toContain("moved Alpha right of Beta");
    expect(r.kbEsc, "Esc restores the tree from before the grab").toBe(true);
    expect(r.kbEscPressed).toBe("false");
    expect(r.kbDropped, "Enter drops").toBe("false");
    expect(r.kbDown).not.toBe(r.t0);
    expect(JSON.parse(r.altMove).ch.map((c: any) => c.id).join(), "Alt+arrow moves without grab").toBe("b,a,c");
    expect(r.noGrabNoMove, "arrow without grab does nothing").toBe(true);
    expect(r.reload, "reload restores the arrangement").toBe(true);
  }, 120_000);
});
