/**
 * A11 win/info.ts — the info popover: hover/focus shows, Esc hides, and the
 * popup is never clipped by a card with overflow:hidden (it lives on <body>).
 * Headless Chromium, skipped when none is installed.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { CHROME, dumpDom, killChromes } from "../cdp-browser.js";

// the module source is the contract: pull WIN_INFO_JS out of it, like win-tree.test.ts
const src = readFileSync(fileURLToPath(new URL("./win/info.ts", import.meta.url)), "utf8");
const m = src.match(/export const WIN_INFO_JS = String\.raw`([\s\S]*?)`;/);
if (!m) throw new Error("WIN_INFO_JS not found in win/info.ts");
const INFO_JS = m[1]!;

// node-side sanity: the string is ES5 and defines the API
const api = (new Function(`${INFO_JS}\nreturn {winInfoHtml:winInfoHtml,winInfoShow:winInfoShow,winInfoHide:winInfoHide,winInfoWire:winInfoWire,winInfoPlace:winInfoPlace};`) as any)();
if (!api.winInfoHtml('a"<b').includes('class="win-info"') || !api.winInfoHtml('a"<b').includes('data-info="a&quot;&lt;b"')) throw new Error("winInfoHtml must render the escaped .win-info anchor");

// the real stylesheet, pulled from css.ts the same way (css() interpolates nothing, so a
// stub layout is enough there too)
const cssSrc = readFileSync(fileURLToPath(new URL("./css.ts", import.meta.url)), "utf8");
const cm = cssSrc.match(/export const css = \(L: CockpitLayout[^`]*`([\s\S]*?)`;/);
if (!cm) throw new Error("css rules not found in cockpit-page/css.ts");
const STYLE = cm[1]!;

const PAGE = `<!doctype html><html><head><style>${STYLE}</style></head><body>
<div class="card" style="overflow:hidden;height:40px;width:200px;margin:40px 0 0 20px">
 <span id="a" class="win-info" tabindex="0" role="button" aria-describedby="win-info-pop" data-info="the long help text">ⓘ</span>
 <div style="height:30px"></div>
</div>
<div id="dbg" style="font-size:10px"></div>
<div id="below" style="height:600px"></div>
<script>${INFO_JS}
winInfoWire(document,window);
var out=[];
function done(){parent.postMessage(JSON.stringify(out),"*")}
var a=document.getElementById("a");var keyed="no";
function snap(why){var p=document.getElementById("win-info-pop");var a=document.getElementById("a");
 var card=document.querySelector(".card");
 out.push({why:why,hidden:p?p.hidden:null,open:!!p&&!p.hidden,disp:p?getComputedStyle(p).display:"",keyed:keyed,
  card:Math.round(card.getBoundingClientRect().top)+","+Math.round(card.getBoundingClientRect().bottom),
  pop:p?Math.round(p.getBoundingClientRect().top)+","+Math.round(p.getBoundingClientRect().bottom):"-",
  st:p?p.style.top:"",
  cb:Math.round(card.getBoundingClientRect().bottom),
  ct:Math.round(card.getBoundingClientRect().top),
  pt:p?Math.round(p.getBoundingClientRect().top):0,
  pb:p?Math.round(p.getBoundingClientRect().bottom):0,
  at:p?Math.round(p.getBoundingClientRect().top):0,
  ab:p?Math.round(p.getBoundingClientRect().bottom):0,
  ac:p?Math.round(a.getBoundingClientRect().top):0,
  ad:p?Math.round(a.getBoundingClientRect().bottom):0,
  al:p?Math.round(a.getBoundingClientRect().left):0,
  ar:p?Math.round(a.getBoundingClientRect().right):0,
  aw:p?Math.round(a.getBoundingClientRect().width):0,
  ah:p?Math.round(a.getBoundingClientRect().height):0,
  cw:p?Math.round(card.getBoundingClientRect().width):0,
  ch:p?Math.round(card.getBoundingClientRect().height):0,
  pl:p?Math.round(p.getBoundingClientRect().left):0,
  pr:p?Math.round(p.getBoundingClientRect().right):0,
  vw:innerWidth,vh:innerHeight,
  sl:p?p.style.left:"",
  ow:p?p.offsetWidth:0,oh:p?p.offsetHeight:0,
  pos:p?getComputedStyle(p).position:"",
  z:p?getComputedStyle(p).zIndex:"",
  par:p?p.parentNode.tagName:"",
  op:p?p.offsetParent?p.offsetParent.className:"none":"",
  cs:p?getComputedStyle(card).position:"",
  ov:p?getComputedStyle(card).overflow:"",
  ct2:p?getComputedStyle(card).contain:"",
  html:p?document.documentElement.getBoundingClientRect().top:"",
  body:p?document.body.getBoundingClientRect().top:"",
  sc:p?window.scrollY:"",
  fr:p?window.frameElement?"in-iframe":"top":"",
  ih:p?window.innerHeight:"",iw:p?window.innerWidth:"",
  sh:p?window.screen.height:"",sw:p?window.screen.width:"",
  d:p?document.documentElement.scrollHeight:"",
  ds:p?document.documentElement.scrollTop:"",
  vis:p?document.visibilityState:"",
  rf:p?p.getBoundingClientRect().relative:"none",
  kids:p?document.body.children.length:"",
  cs2:p?getComputedStyle(card).display:"",
  cs3:p?getComputedStyle(card).margin:"",
  cs4:p?getComputedStyle(card).padding:"",
  cs5:p?getComputedStyle(card).border:"",
  cs6:p?getComputedStyle(card).boxSizing:"",
  text:p?p.textContent:"",
  inBody:!!p&&p.parentNode===document.body,
  popTop:p?Math.round(p.getBoundingClientRect().top):0,popLeft:p?Math.round(p.getBoundingClientRect().left):0,
  popRight:p?Math.round(p.getBoundingClientRect().right):0,
  cardBottom:Math.round(a.getBoundingClientRect().bottom),
  expanded:a.getAttribute("aria-expanded"),
  active:document.activeElement&&document.activeElement.id});
 // dump-dom freezes virtual time at the last postMessage: report on every snapshot
 parent.postMessage(JSON.stringify(out),"*")}
setTimeout(function(){
 // hover shows
 a.dispatchEvent(new PointerEvent("pointerover",{bubbles:true}));
 snap("hover");
 // Esc hides and returns focus (dispatched on the anchor, as a real key press)
 document.addEventListener("keydown",function(e){keyed=e.key});
 a.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));
 snap("esc");
 // focus shows
 a.focus();a.dispatchEvent(new FocusEvent("focusin",{bubbles:true}));
 snap("focus");
 // click toggles off
 a.dispatchEvent(new MouseEvent("click",{bubbles:true}));
 snap("click-off");
 // click toggles on again
 a.dispatchEvent(new MouseEvent("click",{bubbles:true}));
 snap("click-on");
 // pointerout hides
 a.dispatchEvent(new PointerEvent("pointerout",{bubbles:true}));
 snap("out");
 // not clipped: the popup escapes the overflow:hidden card
 var card=document.querySelector(".card");
 var p=document.getElementById("win-info-pop");
 a.dispatchEvent(new PointerEvent("pointerover",{bubbles:true}));
 var r=p.getBoundingClientRect(),cr=card.getBoundingClientRect();
 document.getElementById("dbg").textContent="card="+cr.top+","+cr.bottom+" pop="+r.top+","+r.bottom+" style="+p.style.top+" hidden="+p.hidden;
 out.push({why:"clip",popTop:Math.round(r.top),popBottom:Math.round(r.bottom),cardBottom:Math.round(cr.bottom),
  below:"below="+(r.top>=a.getBoundingClientRect().bottom),wh:p.getAttribute("data-probe")+" st="+p.style.top+" hid="+p.hidden,
  escapes:"escapes="+(r.bottom>cr.bottom||r.top<cr.top||r.left<cr.left||r.right>cr.right),
  popInCardRect:r.left>=cr.left&&r.right<=cr.right&&r.top>=cr.top&&r.bottom<=cr.bottom});
 done();
},300);
</script></body></html>`;

let tmp = "";

interface Snap { why: string; hidden: boolean | null; open: boolean; disp: string; keyed: string; card: string; pop: string; st: string; sl: string; ow: number; oh: number; pos: string; z: string; par: string; op: string; cs: string; ov: string; ct2: string; html: string; body: string; sc: string; fr: string; ih: string; iw: string; sh: string; sw: string; d: string; ds: string; vis: string; rf: string; kids: string; cs2: string; cs3: string; cs4: string; cs5: string; cs6: string; cb: number; ct: number; pt: number; pb: number; at: number; ab: number; ac: number; ad: number; al: number; ar: number; aw: number; ah: number; cw: number; ch: number; pl: number; pr: number; vw: number; vh: number; text: string; inBody: boolean; popTop: number; popLeft: number; popRight: number; cardBottom: number; expanded: string | null; active: string | null }
interface Clip { why: string; popTop: number; popBottom: number; cardBottom: number; below: string; wh: string; escapes: string; popInCardRect: boolean }

async function shoot(): Promise<(Snap | Clip)[]> {
  tmp = mkdtempSync(join(tmpdir(), "win-info-"));
  const host = join(tmp, "host.html");
  writeFileSync(host, `<body style="margin:0"><iframe src="page.html" style="width:900px;height:900px;border:0"></iframe><script>onmessage=function(e){document.body.setAttribute("data-info",e.data)}</script></body>`);
  writeFileSync(join(tmp, "page.html"), PAGE);
  const o = { width: 1000, height: 900, budgetMs: 4000 };
  const dom = await dumpDom(`file://${host}`, o);
  const r = /data-info="([^"]*)"/.exec(dom);
  if (!r) throw new Error("no info result in dump (dbg: " + (/id="dbg"[^>]*>([^<]*)</.exec(dom)?.[1] ?? "none") + ")");
  return JSON.parse(r[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
}

afterAll(() => { killChromes(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

describe.skipIf(!CHROME)("win info popover, real CSS in Chromium", () => {
  it("hover/focus show, Esc hides, click toggles, pointerout hides, popup on body and not clipped by overflow:hidden", async () => {
    const snaps = await shoot();
    const by = (why: string) => snaps.find((s) => s.why === why) as Snap | undefined;
    const hover = by("hover")!;
    expect(hover, "hover snapshot").toBeDefined();
    expect(hover.hidden, "hover: popup visible").toBe(false);
    expect(hover.text).toBe("the long help text");
    expect(hover.inBody, "popup is a child of <body>").toBe(true);
    expect(hover.expanded).toBe("true");
    const esc = by("esc")!;
    expect(`esc: hidden=${esc.hidden} keyed=${esc.keyed} exp=${esc.expanded} act=${esc.active}`, "esc snapshot").toContain("hidden=true");
    expect(esc.expanded).toBe("false");
    expect(esc.active, "Esc returns focus to the anchor").toBe("a");
    expect(by("focus")!.hidden, "focus shows").toBe(false);
    expect(by("click-off")!.hidden, "click toggles off").toBe(true);
    expect(by("click-on")!.hidden, "click toggles on").toBe(false);
    expect(by("out")!.hidden, "pointerout hides").toBe(true);
    const clip = snaps.find((s) => s.why === "clip") as unknown as Clip & Snap;
    expect(clip.escapes, "popup rect escapes the card's overflow:hidden box").toContain("escapes=true");
    expect(clip.popInCardRect, "popup rect is not inside the card rect").toBe(false);
    expect(clip.below, "popup is visible below the anchor").toContain("below=true");
  }, 120_000);
});
