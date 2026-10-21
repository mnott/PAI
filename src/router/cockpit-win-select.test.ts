/**
 * A9 win/select.ts: Select and Menu (spec 5.1). Headless Chromium drives the real page
 * (the win CSS + WIN_SELECT_JS injected) with synthetic events; results come back through
 * postMessage like cockpit-page-fit.test.ts. Skipped when no Chromium is installed.
 */

import { execFile, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cockpitHtml } from "./cockpit-page.js";
import { WIN_SELECT_JS, winSelectCss } from "./cockpit-page/win/select.js";

const CHROME = process.env.CHROME_BIN ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));

/** The probe script: builds a Select and a Menu, drives them, posts one JSON result. */
const PROBE = `<script>
var Select=eval(${JSON.stringify(WIN_SELECT_JS)}+";Select");
var Menu=eval(${JSON.stringify(WIN_SELECT_JS)}+";Menu");
var picks=[];
window.onerror=function(m,s,l,c,e){window.__err=String(m)+" @"+l+":"+c};
var sel=Select.create({options:[{value:"a",label:"Alpha"},{value:"b",label:"Beta",hint:"fast"},{value:"c",label:"Gamma",disabled:true}],value:"a",placeholder:"pick",ariaLabel:"test select",onChange:function(v){picks.push(v)}});
document.body.appendChild(sel.element);
var menu=Menu.create({items:[{label:"one",run:function(){picks.push("m1")}}],ariaLabel:"test menu"});
document.body.appendChild(menu.element);
function key(el,k){el.dispatchEvent(new KeyboardEvent("keydown",{key:k,bubbles:true,cancelable:true}))}
function click(el){el.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true}))}
function mdown(el){el.dispatchEvent(new MouseEvent("mousedown",{bubbles:true,cancelable:true}))}
function pop(){return document.querySelector(".wpop")}
function optEls(){return Array.prototype.slice.call(document.querySelectorAll(".wpop .wopt"))}
function act(){var e=optEls().find(function(x){return x.classList.contains("wact")});return e?e.getAttribute("data-i"):null}
function rgbOf(hex){
 var r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);
 return "rgb("+r+", "+g+", "+b+")";
}
function out(){
 r.cardVar=getComputedStyle(document.documentElement).getPropertyValue("--card").trim();
 r.selects=document.querySelectorAll("select").length;
 parent.postMessage(JSON.stringify({
  picks:picks,
  btnVal:sel.element.querySelector(".wv").textContent,
  open:!!pop(),
  expanded:sel.element.getAttribute("aria-expanded"),
  active:act(),
  ad:sel.element.getAttribute("aria-activedescendant"),
  optCount:optEls().length,
  dbg:r
 }),"*");
}
var r={};
setTimeout(function(){
 click(sel.element);r.open1=!!pop();r.parent1=pop().parentNode.tagName;r.role1=pop().getAttribute("role");
 r.selRole=optEls()[0].getAttribute("role");
 var s0=optEls().find(function(x){return x.getAttribute("aria-selected")==="true"});
 r.selAria=s0?s0.getAttribute("data-i"):null;
 r.popBg=getComputedStyle(pop()).backgroundColor;
 r.optCount=optEls().length;
 key(sel.element,"ArrowDown");r.act1=act();r.ad=sel.element.getAttribute("aria-activedescendant");
 key(sel.element,"ArrowDown");r.act2=act();
 key(sel.element,"ArrowDown");r.act3=act();
 key(sel.element,"Enter");r.picksEnter=picks.slice();r.closed1=!pop();r.btnVal1=sel.element.querySelector(".wv").textContent;
 click(sel.element);key(sel.element,"Escape");r.escClosed=!pop();r.expAfterEsc=sel.element.getAttribute("aria-expanded");
 click(sel.element);var n0=optEls().length;
 sel.setOptions([{value:"x",label:"Xray"},{value:"y",label:"Yankee"}]);
 r.stillOpen=!!pop();r.n0=n0;r.n1=optEls().length;
 sel.setValue("y");r.valAfterSet=sel.element.querySelector(".wv").textContent;
 var s=optEls().find(function(x){return x.classList.contains("wsel")});r.optSel=s?s.getAttribute("data-i"):null;
 mdown(document.body);r.outsideClosed=!pop();
 sel.setDisabled(true,"busy");r.dis=sel.element.disabled;r.title=sel.element.getAttribute("title")||"";
 sel.setDisabled(false);
 click(menu.element);r.menuOpen=menu.element.getAttribute("aria-expanded");r.menuRole=pop().getAttribute("role");
 key(menu.element,"Enter");r.menuPicks=picks.slice();r.menuClosed=!pop();
 out();
},300);
</script>`;

function pageHtml(theme: string): string {
  const full = cockpitHtml();
  const style = full.slice(full.indexOf("<style>"), full.indexOf("</style>") + 8);
  return `<!doctype html><html${theme === "dark" ? ' data-theme="dark"' : ""}><head>${style}<style>${winSelectCss()}</style></head><body>${PROBE}</body></html>`;
}

let tmp = "";
let server: Server;
let base = "";
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "cockpit-win-select-"));
  server = createServer((req, res) => {
    const url = req.url ?? "";
    const theme = /theme=(\w+)/.exec(url)?.[1] ?? "light";
    if (url.startsWith("/page")) {
      res.setHeader("content-type", "text/html");
      return res.end(pageHtml(theme).replace("</body>", `<script>setTimeout(function(){parent.postMessage(JSON.stringify({err:window.__err||""}),"*")},400)</script></body>`));
    }
    res.setHeader("content-type", "text/html");
    res.end(`<body style="margin:0"><iframe src="/page?theme=${theme}" style="width:900px;height:700px;border:0"></iframe><script>onmessage=function(e){var d=e.data,o=null;try{o=JSON.parse(d)}catch(x){}if(o&&o.err)document.body.setAttribute("data-err",o.err);if(o&&o.dbg)document.body.setAttribute("data-probe",JSON.stringify(o.dbg))}</script></body>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

/** Every browser started here, so afterAll can kill what a failed test left behind. */
const browsers = new Set<ChildProcess>();
function run(bin: string, args: string[], opts: { encoding?: "utf8"; timeout: number; maxBuffer?: number }): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const c = execFile(bin, args, { ...opts, encoding: "utf8" }, (err, stdout) => { browsers.delete(c); err ? reject(err) : resolve({ stdout }); });
    browsers.add(c);
  });
}
afterAll(() => { for (const c of browsers) c.kill("SIGKILL"); server?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

interface ProbeResult {
  dbg: {
    open1: boolean; parent1: string; role1: string; act1: string; act2: string; picksEnter: string[]; closed1: boolean;
    btnVal1: string; escClosed: boolean; expAfterEsc: string; stillOpen: boolean; n0: number; n1: number; act3: string;
    valAfterSet: string; optSel: string | null; outsideClosed: boolean; dis: boolean; title: string;
    menuOpen: string; menuRole: string; menuPicks: string[]; menuClosed: boolean;
    popBg: string; cardVar: string; selects: number; selRole: string | null; selAria: string | null; ad: string | null; optCount: number;
  };
}

/** A CSS colour (hex or rgb()) normalised to the rgb() form getComputedStyle reports. */
function rgbOf(v: string): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim());
  if (!hex) return v.trim();
  let h = hex[1]!;
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!;
  return `rgb(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)})`;
}

async function probe(theme: string, tag: string): Promise<ProbeResult> {
  const args = ["--headless=new", "--disable-gpu", "--use-mock-keychain", "--password-store=basic", "--no-first-run", "--hide-scrollbars", `--user-data-dir=${join(tmp, "tp-" + tag)}`, "--window-size=1000,800", "--virtual-time-budget=5000"];
  const { stdout: dom } = await run(CHROME!, [...args, "--dump-dom", `${base}/frame?theme=${theme}`], { encoding: "utf8", timeout: 60_000, maxBuffer: 64 << 20 });
  const e = /data-err="([^"]*)"/.exec(dom);
  if (e && e[1]) throw new Error(`page error for ${tag}: ${e[1].replace(/&quot;/g, '"')}`);
  const m = /data-probe="([^"]*)"/.exec(dom);
  if (!m) throw new Error(`no probe result for ${tag}`);
  const dbg = JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
  if (!dbg || typeof dbg !== "object" || dbg.selects === undefined) throw new Error(`bad probe payload for ${tag}: ${m[1]!.slice(0, 120)}`);
  return { dbg };
}

describe.skipIf(!CHROME)("win Select and Menu (A9, spec 5.1) in Chromium", () => {
  it("click opens, arrows move, Enter picks once, Esc closes, setOptions keeps it open, popup on body", async () => {
    const r = (await probe("light", "light")).dbg;
    expect(r.selects, "no native <select> anywhere").toBe(0);
    expect(r.open1, "click opens").toBe(true);
    expect(r.parent1, "popup appended to body").toBe("BODY");
    expect(r.role1, "popup role").toBe("listbox");
    expect(r.selRole, "option role").toBe("option");
    expect(r.selAria, "the current value is aria-selected").toBe("0");
    expect(r.optCount, "options rendered").toBe(3);
    expect(r.ad, "aria-activedescendant set").toBe("wopt1");
    // open marks the current value (a); arrows: b; the disabled c is skipped (wrap to a); then b
    expect(r.act1, "ArrowDown moves to option 1").toBe("1");
    expect(r.act2, "disabled option skipped, wraps to a").toBe("0");
    expect(r.act3, "ArrowDown moves to option 1 again").toBe("1");
    expect(r.picksEnter.length, "onChange fired once").toBe(1);
    expect(r.picksEnter[0], "picked value").toBe("b");
    expect(r.closed1, "pick closes").toBe(true);
    expect(r.btnVal1, "button shows the picked label").toBe("Beta");
    expect(r.escClosed, "Esc closes").toBe(true);
    expect(r.expAfterEsc, "aria-expanded false after Esc").toBe("false");
    expect(r.stillOpen, "setOptions while open keeps it open").toBe(true);
    expect(r.n0, "options before setOptions").toBe(3);
    expect(r.n1, "options replaced").toBe(2);
    expect(r.valAfterSet, "setValue repaints the button").toBe("Yankee");
    expect(r.optSel, "the selected option is marked").toBe("1");
    expect(r.outsideClosed, "outside mousedown closes").toBe(true);
    expect(r.dis, "setDisabled(true) disables the button").toBe(true);
    expect(r.title, "disabled reason in title").toBe("busy");
    expect(r.menuOpen, "Menu opens").toBe("true");
    expect(r.menuRole, "Menu popup role").toBe("menu");
    expect(r.menuPicks, "menu item ran").toEqual(["b", "m1"]);
    expect(r.menuClosed, "menu closes after run").toBe(true);
  }, 120_000);

  it("popup background equals --card in both themes (no white in dark)", async () => {
    const light = (await probe("light", "light-bg")).dbg;
    const dark = (await probe("dark", "dark-bg")).dbg;
    expect(rgbOf(light.popBg), "light popup").toBe(rgbOf(light.cardVar));
    expect(rgbOf(dark.popBg), "dark popup").toBe(rgbOf(dark.cardVar));
    expect(rgbOf(dark.cardVar), "dark theme active").toBe(rgbOf("#181c26"));
  }, 120_000);
});
