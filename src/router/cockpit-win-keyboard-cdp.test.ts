/**
 * Spec 5.3 on the real cockpit page, real key events over CDP (Input.dispatchKeyEvent):
 *   K1 Tab reaches the grips in reading (DOM) order    K2 grip Enter grabs, arrows move, Esc restores, Enter drops
 *   K3 Alt+arrow moves without grabbing                K4 focus stays on the grip
 *   K5 minimize toggles by Enter/Space, aria-expanded  K6 one polite live region announces moves and minimizes
 *   K7 gutters are focusable separators, arrows resize 16 px   K8 prefers-reduced-motion: no transitions or animations
 * Skipped when no Chromium is installed.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cockpitHtml } from "./cockpit-page.js";
import { fixtureData, fixtureLimits, fixturePool, fixtureQueue, fixtureSystem } from "./cockpit-fixtures.js";

const CHROME = process.env.CHROME_BIN ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));

let server: Server;
let base = "";
let tmp = "";
let proc: ChildProcess | undefined;
let ws: WebSocket | undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "cockpit-win-drag-cdp-"));
  server = createServer((req, res) => {
    const url = req.url ?? "";
    const json = (o: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
    if (url.startsWith("/cockpit/data")) return json(fixtureData());
    if (url.startsWith("/cockpit/system")) return json(fixtureSystem());
    if (url.startsWith("/cockpit/queue")) return json(fixtureQueue());
    if (url.startsWith("/cockpit/limits")) return json(fixtureLimits());
    if (url.startsWith("/cockpit/pool")) return json(fixturePool());
    if (url.startsWith("/cockpit/")) return json({});
    if (url.startsWith("/page")) { res.setHeader("content-type", "text/html"); return res.end(cockpitHtml()); }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => { try { ws?.close(); } catch { /* closed */ } proc?.kill("SIGKILL"); server?.close(); if (tmp) try { rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* the browser may still be flushing its profile */ } });

async function launch(w: number, h: number) {
  const dir = join(tmp, "profile");
  proc = spawn(CHROME!, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`, `--window-size=${w},${h}`, "--no-first-run", "--disable-gpu", "--use-mock-keychain", "--password-store=basic", "about:blank"], { stdio: "ignore" });
  let port = 0;
  for (let i = 0; i < 100 && !port; i++) {
    await sleep(200);
    try { port = Number(readFileSync(join(dir, "DevToolsActivePort"), "utf8").split("\n")[0]); } catch { /* not up yet */ }
  }
  if (!port) throw new Error("chrome did not start");
  let tabs: { type: string; webSocketDebuggerUrl: string }[] = [];
  for (let i = 0; i < 50 && !tabs.some((t) => t.type === "page"); i++) { try { tabs = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as typeof tabs; } catch { /* not up yet */ } if (!tabs.some((t) => t.type === "page")) await sleep(200); }
  ws = new WebSocket(tabs.find((t) => t.type === "page")!.webSocketDebuggerUrl);
  await new Promise((r) => { ws!.onopen = r; });
  let id = 0;
  const pend = new Map<number, (d: { result: unknown }) => void>();
  ws.onmessage = (m) => { const d = JSON.parse(String(m.data)); if (d.id && pend.has(d.id)) { pend.get(d.id)!(d); pend.delete(d.id); } };
  const send = (method: string, params: object = {}) => new Promise<{ result: any }>((r) => { const i = ++id; pend.set(i, r as never); ws!.send(JSON.stringify({ id: i, method, params })); });
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  const ev = async <T>(expr: string): Promise<T> => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result.result.value as T;
  };
  return { send, ev };
}

const VK: Record<string, number> = { Tab: 9, Enter: 13, Escape: 27, " ": 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };
const ST = `(function(){var a=document.activeElement;var c=a&&a.closest&&a.closest(".card");var l=document.querySelector(".cwlive");return{cls:a&&a.className,card:c&&c.dataset.card,pressed:a&&a.getAttribute("aria-pressed"),exp:a&&a.getAttribute("aria-expanded"),live:l?l.textContent:null,tree:JSON.stringify(Win.state().tree)+JSON.stringify(Win.state().kids)}})()`;
interface St { cls: string; card: string | null; pressed: string | null; exp: string | null; live: string | null; tree: string }

describe.skipIf(!CHROME)("cockpit keyboard and accessibility, spec 5.3 (CDP key events)", () => {
  it("K1-K8", async () => {
    const b = await launch(1500, 1000);
    const key = async (k: string, alt = false) => {
      const p = { key: k, code: k === " " ? "Space" : k, windowsVirtualKeyCode: VK[k], modifiers: alt ? 1 : 0 };
      await b.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...p });
      if (k === "Enter" || k === " ") await b.send("Input.dispatchKeyEvent", { type: "char", ...p, text: k === "Enter" ? "\r" : " " });
      await b.send("Input.dispatchKeyEvent", { type: "keyUp", ...p });
      await sleep(150);
    };
    const st = () => b.ev<St>(ST);
    const focus = (sel: string) => b.ev(`(function(){var e=document.querySelector(${JSON.stringify(sel)});e.scrollIntoView({block:"center"});e.focus();return !!e})()`);
    await b.send("Page.navigate", { url: `${base}/page` });
    for (let i = 0; i < 60; i++) { await sleep(250); if (await b.ev<boolean>(`!!document.querySelector('#win-root [data-card="kpis.errors"] .cgrip')&&typeof Win!=="undefined"`)) break; }
    await sleep(1500);

    // K1: Tab visits the grips in DOM order (kpis group first, then its cards left to right)
    await b.ev(`window.scrollTo(0,0);document.activeElement&&document.activeElement.blur()`);
    const seq: string[] = [];
    for (let i = 0; i < 40; i++) { await key("Tab"); const s = await st(); if (s.cls === "cgrip" && s.card) seq.push(s.card); }
    const dom = await b.ev<string[]>(`Array.from(document.querySelectorAll(".card .cgrip")).filter(function(g){return g.offsetParent}).map(function(g){return g.closest(".card").dataset.card})`);
    expect(seq.length, "K1 reached grips by Tab").toBeGreaterThan(8);
    expect(seq, "K1 Tab order is DOM order").toEqual(dom.slice(0, seq.length));
    expect(seq.slice(0, 7)).toEqual(["kpis", "kpis.requests", "kpis.input", "kpis.output", "kpis.cache-read", "kpis.cache-write", "kpis.errors"]);

    // K2 + K4: grab, move right (swap past the neighbour), refused move announces, Esc restores, Enter drops
    const card = "kpis.requests";
    await focus(`[data-card="${card}"] .cgrip`);
    const a0 = await st();
    await key("Enter");
    expect((await st()).pressed, "K2 Enter grabs").toBe("true");
    await key("ArrowRight");
    const a2 = await st();
    expect(a2.tree).not.toBe(a0.tree);
    expect(a2.live).toBe("moved requests right of input");
    expect(`${a2.cls}:${a2.card}`, "K4 focus stays on the grip").toBe(`cgrip:${card}`);
    await key("ArrowRight"); await key("ArrowLeft"); const a2b = await st();
    await key("ArrowDown");
    const a3 = await st();
    expect(a3.live, "K2 a refused move announces the reason").toMatch(/^no room: /);
    expect(a3.tree, "refused move leaves the tree").toBe(a2b.tree);
    await key("Escape");
    const a4 = await st();
    expect(a4.tree, "K2 Esc restores the tree from before the grab").toBe(a0.tree);
    expect(a4.pressed).toBe("false");
    expect(`${a4.cls}:${a4.card}`).toBe(`cgrip:${card}`);
    await key("Enter"); await key("ArrowRight"); const a5 = await st(); await key("Enter"); const a6 = await st();
    expect(a6.pressed, "K2 Enter drops").toBe("false");
    expect(a6.tree, "drop keeps the move").toBe(a5.tree);
    expect(a6.live).toBe("dropped requests");

    // K3: Alt+arrow moves without grabbing (pool.pool below pool.slots)
    await focus('[data-card="pool.pool"] .cgrip');
    const c0 = await st();
    await key("ArrowDown", true);
    const c1 = await st();
    expect(c1.pressed, "K3 never grabbed").not.toBe("true");
    expect(c1.tree).not.toBe(c0.tree);
    expect(c1.live).toBe("moved pool below slots");
    expect(`${c1.cls}:${c1.card}`, "K4 focus stays after Alt+arrow").toBe("cgrip:pool.pool");

    // K5 + K6: Enter and Space on the minimize button; one polite region carries the announcements
    await focus('[data-card="kpis.input"] .cmin');
    expect((await st()).exp).toBe("true");
    await key("Enter");
    const m1 = await st();
    expect(m1.exp).toBe("false");
    expect(m1.live).toBe("input minimized");
    await key(" ");
    const m2 = await st();
    expect(m2.exp).toBe("true");
    expect(m2.live).toBe("input restored");
    const live = await b.ev<{ win: number; polite: string[] }>(`({win:document.querySelectorAll(".cwlive").length,polite:Array.from(document.querySelectorAll("[aria-live]")).map(function(x){return x.className+"/"+x.getAttribute("aria-live")}).filter(function(v,i,a){return a.indexOf(v)===i})})`);
    expect(live.win, "K6 one announcement region").toBe(1);
    expect(live.polite.sort()).toEqual(["cstatus/polite", "cwlive/polite"]);

    // K7: gutters are focusable separators; an arrow resizes by 16 px
    const gs = await b.ev<{ role: string | null; tab: number }[]>(`Array.from(document.querySelectorAll(".wgutter")).map(function(g){return{role:g.getAttribute("role"),tab:g.tabIndex}})`);
    expect(gs.length).toBeGreaterThan(0);
    expect(gs.every((g) => g.role === "separator" && g.tab === 0)).toBe(true);
    await b.ev(`(function(){var g=Array.from(document.querySelectorAll(".wgutter[data-axis=x]")).find(function(x){return x.offsetWidth>0});g.setAttribute("data-kt","1")})()`);
    const widths = () => b.ev<number[]>(`Array.from(document.querySelectorAll("#win-root .card")).map(function(c){return Math.round(c.getBoundingClientRect().width*100)/100})`);
    await focus("[data-kt]");
    const w0 = await widths(); await key("ArrowRight"); const w1 = await widths(); await key("ArrowLeft"); const w2 = await widths();
    const diff = (x: number[], y: number[]) => y.map((v, i) => Math.round((v - x[i]!) * 100) / 100).filter((v) => v);
    expect(diff(w0, w1).sort((p, q) => p - q), "K7 ArrowRight moves 16 px").toEqual([-16, 16]);
    expect(diff(w1, w2).sort((p, q) => p - q), "K7 ArrowLeft moves back").toEqual([-16, 16]);

    // K8: reduced motion leaves no transition and no animation anywhere
    await b.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await sleep(300);
    const moving = await b.ev<string[]>(`(function(){var bad=[];document.querySelectorAll("*").forEach(function(e){var s=getComputedStyle(e);var t=s.transitionDuration.split(",").some(function(v){return parseFloat(v)>0});var a=s.animationName!=="none"&&parseFloat(s.animationDuration)>0;if(t||a)bad.push(e.className+"|"+s.transitionDuration+"|"+s.animationName)});return bad})()`);
    expect(moving, "K8").toEqual([]);
  }, 180_000);
});
