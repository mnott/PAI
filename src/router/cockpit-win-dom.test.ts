/**
 * A5 win/card.ts — the card DOM factory and runtime (spec 2.2, 2.3, 4.1, 3.2). Headless Chromium
 * drives a page with three test cards and posts one JSON result like cockpit-win-morph.test.ts.
 * Skipped when no Chromium is installed.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WIN_CARD_JS } from "./cockpit-page/win/card.js";
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

const JS = [WIN_TREE_JS, WIN_LAYOUT_JS, WIN_MORPH_JS, WIN_STORE_JS, WIN_INFO_JS, WIN_CARD_JS].join("\n");

const PAGE = `<!doctype html><html><head><style>${STYLE}</style></head><body style="margin:0"><header></header><main id="m"></main>
<script>
window.onerror=function(m,s,l,c){window.__err=String(m)+" @"+l+":"+c};
localStorage.clear();
${JS}
var r={};
function rect(id){var e=Win.el(id),b=e.getBoundingClientRect(),o=document.getElementById("m").getBoundingClientRect();return[Math.round(b.left-o.left),Math.round(b.top-o.top),Math.round(b.width),Math.round(b.height)].join(",")}
function rects(){return["a","b","c"].map(rect).join("|")}
var mounts=0,updates=0,resizes=0,ran=0;
Win.registerType("t",{minW:200,defaultH:150,
 mount:function(ctx){mounts++;ctx.body.innerHTML='<span data-k="v"></span><div data-k="rows"></div><div data-k="html"></div>'},
 update:function(ctx,d){updates++;ctx.text("v",d.v);ctx.cls("v","hot",d.v==="2");ctx.attr("v","data-n",d.v);
  ctx.list("rows",d.rows,function(x){return x},function(x){var e=document.createElement("div");e.textContent=x;return e});
  ctx.html("html","<b data-k=\\"b\\">"+d.v+"</b>")},
 resize:function(ctx,w,h){resizes++;ctx.body.setAttribute("data-size",w+"x"+h)}});
var tree=split("c",[split("r",[leaf("a"),leaf("b")],[0.5,0.5]),leaf("c")],[200,150]);
Win.init(document.getElementById("m"),{tree:tree,kids:{},stDefaults:{},cards:[
 {id:"a",type:"t",title:"Alpha",feeds:["f"],info:"alpha help",actions:[{id:"go",label:"go",title:"do it",run:function(){ran++}},{id:"dead",label:"dead"},{id:"off",label:"off",enabled:function(){return"not now"},run:function(){ran+=100}}]},
 {id:"b",type:"t",title:"Beta",feeds:["f"]},
 {id:"c",type:"t",title:"Gamma",feeds:["g"]}]},{storage:localStorage});
setTimeout(function(){
 var A=Win.el("a");
 r.order=Array.prototype.map.call(document.querySelectorAll(".chead"),function(h){return Array.prototype.map.call(h.children,function(k){return k.className.split(" ")[0]}).join(",")});
 r.contain=Array.prototype.map.call(document.querySelectorAll(".cbody"),function(b){return b.style.contain+"/"+getComputedStyle(b).contain});
 r.actBtns=A.querySelectorAll(".cact").length;
 r.actOffDisabled=A.querySelector('[data-act="off"]').disabled;r.actOffTitle=A.querySelector('[data-act="off"]').title;
 A.querySelector('[data-act="go"]').click();A.querySelector('[data-act="off"]').click();r.ran=ran;
 r.info=!!A.querySelector(".chead .ctitle .win-info");
 r.attrs=A.getAttribute("data-card")+"|"+A.getAttribute("data-type")+"|"+A.getAttribute("role")+"|"+A.getAttribute("aria-label");
 r.cardPos=getComputedStyle(A).position;
 r.mainH=document.getElementById("m").style.height;
 r.rects0=rects();r.mountsAtInit=mounts;
 r.size0=A.querySelector(".cbody").getAttribute("data-size");
 // update through ctx: content changes, boxes do not
 var n=Win.update("f",{v:"1",rows:["x","y","z"]});
 r.updated=n;r.vtext=A.querySelector('[data-k="v"]').textContent;r.rows1=A.querySelectorAll('[data-k="rows"] > div').length;
 var rowY=A.querySelector('[data-k="rows"] > div[data-k="y"]');
 Win.update("f",{v:"2",rows:["y","x","z","w"]});
 r.rowIdent=A.querySelector('[data-k="rows"] > div[data-k="y"]')===rowY;r.hot=A.querySelector('[data-k="v"]').classList.contains("hot");
 r.rectsAfterUpdate=rects();r.updatesC=updates;
 Win.ctx("a").status("err","boom");r.status=A.querySelector(".cstatus").textContent+"|"+A.querySelector(".cstatus").getAttribute("data-kind");
 Win.ctx("a").title("Alpha 2");r.title=A.querySelector(".ctt").textContent+"|"+A.getAttribute("aria-label")+"|"+A.querySelector(".cgrip").getAttribute("aria-label");
 // minimize a: header only, the rest does not move; restore returns the same rect
 var before=rects(),minBtn=A.querySelector(".cmin");
 minBtn.click();
 r.minRects=rects();r.minH=A.style.height;r.minExpanded=minBtn.getAttribute("aria-expanded");
 r.minBodyDisplay=getComputedStyle(A.querySelector(".cbody")).display;
 r.minMain=document.getElementById("m").style.height;
 r.mountsAfterMin=mounts;
 minBtn.click();
 r.restRects=rects();r.before=before;r.mountsAfterRestore=mounts;r.restExpanded=minBtn.getAttribute("aria-expanded");
 r.textKept=A.querySelector('[data-k="v"]').textContent;
 minBtn.click();
 setTimeout(function(){
  r.saved=localStorage.getItem("pai.cockpit.win.v2");
  // width change relayouts
  var m=document.getElementById("m");
  r.hasRO=typeof ResizeObserver!=="undefined";
  var n0=Win.layouts();r.syncSame=Win.sync();r.layoutsSame=Win.layouts()-n0;
  m.style.width="600px";
  r.syncNarrow=Win.sync();r.layoutsNarrow=Win.layouts()-n0;r.syncAgain=Win.sync();
  r.narrowRects=rects();r.resizes=resizes;
  document.body.setAttribute("data-probe",JSON.stringify(r));
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

describe.skipIf(!CHROME)("win cards (A5, spec 2.2/2.3/4.1) in Chromium", () => {
  it("header child order, contain, ctx writes, minimize/restore rect, persisted state, width relayout", async () => {
    const o = { width: 1000, height: 900, budgetMs: 4000, scrollbars: false };
    const url = base;
    const dom = await dumpDom(url, o);
    const e = /data-err="([^"]*)"/.exec(dom);
    if (e && e[1]) throw new Error(`page error: ${e[1]}`);
    const m = /data-probe="([^"]*)"/.exec(dom);
    if (!m) throw new Error("no probe result");
    const r = JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
    // 2.2 control set and order: grip, title, status, actions, minimize
    expect(r.order[0], "a: grip, title, status, actions (only with a handler), minimize").toBe("cgrip,ctitle,cstatus,cbtn,cbtn,cbtn");
    expect(r.order[1]).toBe("cgrip,ctitle,cstatus,cbtn");
    expect(r.order[2]).toBe("cgrip,ctitle,cstatus,cbtn");
    expect(r.actBtns, "the action without a handler is not rendered").toBe(2);
    expect(r.actOffDisabled, "impossible action is disabled").toBe(true);
    expect(r.actOffTitle, "with its reason").toBe("not now");
    expect(r.ran, "enabled action ran once, disabled never").toBe(1);
    expect(r.info, "info renders next to the title").toBe(true);
    expect(r.attrs).toBe("a|t|group|Alpha");
    expect(r.cardPos).toBe("relative");
    // positions are CSS grid now: no size containment on a body (the card is as tall as its content), no explicit px
    for (const c of r.contain) expect(c).toBe("/none");
    // heights are content-driven: a grid row is as tall as its tallest card, the next starts GAP (6 px) below
    const q = (r.rects0 as string).split("|").map((s: string) => s.split(",").map(Number));
    expect(q[0]!.slice(0, 3)).toEqual([0, 0, 483]);
    expect(q[1]!.slice(0, 3)).toEqual([489, 0, 483]);
    expect(q[2]!.slice(0, 3)).toEqual([0, Math.max(q[0]![3]!, q[1]![3]!) + 6, 972]);
    expect(r.mainH, "the page has no explicit height").toBe("");
    expect(r.mountsAtInit, "mount ran once per card").toBe(3);
    expect(r.size0, "resize(ctx,w,h) got the body box").toBe(`483x${q[0]![3]! - 28}`);
    // 4.1 ctx
    expect(r.updated, "update(feed) reaches only the subscribed cards").toBe(2);
    expect(r.vtext).toBe("1");
    expect(r.rows1).toBe(3);
    expect(r.rowIdent, "keyed list row survives").toBe(true);
    expect(r.hot).toBe(true);
    // a card is as tall as its content, so a content update may change heights; x and width (the grid spans) never change
    const xw = (rs: string) => rs.split("|").map((x) => x.split(",").filter((_, i) => i === 0 || i === 2).join(","));
    expect(xw(r.rectsAfterUpdate), "content updates never change an x or width").toEqual(xw(r.rects0));
    expect(r.status).toBe("boom|err");
    expect(r.title).toBe("Alpha 2|Alpha 2|move Alpha 2");
    // minimize: header height only, siblings and band unchanged; restore returns the same rect; no remount
    expect(r.minH, "no inline height").toBe("");
    expect(r.minRects.split("|")[1], "sibling b did not move").toBe(r.before.split("|")[1]);
    expect(r.minRects.split("|")[2], "card c did not move").toBe(r.before.split("|")[2]);
    expect(r.minRects.split("|")[0]).toBe("0,0,483,28");
    expect(r.minExpanded).toBe("false");
    expect(r.minBodyDisplay).toBe("none");
    expect(r.mountsAfterMin).toBe(3);
    expect(r.restRects, "restore returns the same rects").toBe(r.before);
    expect(r.mountsAfterRestore, "no remount on restore").toBe(3);
    expect(r.restExpanded).toBe("true");
    expect(r.textKept, "body state kept across minimize").toBe("2");
    // persisted: one write, min flag stored
    const saved = JSON.parse(r.saved);
    expect(saved.v).toBe(2);
    expect(saved.st.a.min).toBe(1);
    // width change relayouts: two-up halves of 600 - GAP
    expect(r.narrowRects.split("|")[1]!.split(",").slice(0, 3).join(","), "b at half of 600 - GAP").toBe("303,0,297");
    expect(Number(r.narrowRects.split("|")[2]!.split(",")[2]), "c spans the new width").toBe(600);
    expect(r.resizes, "resize called again for the new width").toBeGreaterThan(3);
    expect(r.hasRO, "main is observed by a ResizeObserver").toBe(true);
    expect(r.layoutsSame, "no relayout without a change").toBe(0);
    expect(r.layoutsNarrow, "a width change needs no relayout: the grid reflows by itself").toBe(0);
  }, 120_000);
});
