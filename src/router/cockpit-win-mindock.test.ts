/**
 * A minimized card inside a group docks as a title chip at the bottom of its container (siblings take its place);
 * restoring it puts it back on its old rect; a root-level card minimizes in place; a reload keeps the dock.
 * The real page in headless Chromium, driven through Win in an iframe. Skipped when no Chromium is installed.
 */

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cockpitHtml } from "./cockpit-page.js";
import { fixtureData, fixtureLimits, fixturePoolWithSlot, fixtureQueue, fixtureSystem } from "./cockpit-fixtures.js";
import { join } from "node:path";
import { CHROME, dumpDom, killChromes, screenshot } from "./cdp-browser.js";

const SCRIPT = `
var f=document.getElementById("f"),res={};
function R(id){var e=f.contentDocument.querySelector('[data-card="'+id+'"]');if(!e)return null;var r=e.getBoundingClientRect();return{x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height),disp:e.style.display,cls:e.className,pa:e.parentNode.closest("[data-card]")?e.parentNode.closest("[data-card]").getAttribute("data-card"):""}}
function snap(){return{g:R("sys-metrics"),a:R("system.cpu-load"),b:R("system.gpu-load"),c:R("system.memory"),e:R("system.ane-load"),chips:Array.prototype.map.call(f.contentDocument.querySelectorAll('[data-card="sys-metrics"] .card.chip'),function(e){return e.getAttribute("data-card")}),btn:!!f.contentDocument.querySelector('[data-card="system.gpu-load"].chip button.cmin')}}
function put(){document.body.setAttribute("data-res",JSON.stringify(res))}
function at(ms,fn){setTimeout(function(){fn();put()},ms)}
at(3500,function(){res.before=snap();res.before.root=R("settings")});
at(4000,function(){f.contentWindow.Win.toggleMin("system.gpu-load")});
at(5000,function(){res.mined=snap();f.contentWindow.Win.toggleMin("settings")});
at(6000,function(){res.root=R("settings");res.rootChip=f.contentDocument.querySelector('[data-card="settings"]').classList.contains("chip");f.contentWindow.Win.toggleMin("settings");f.contentWindow.Win.flush()});
at(7000,function(){f.contentWindow.Win.toggleMin("system.gpu-load")});
at(8000,function(){res.restored=snap();f.contentWindow.Win.toggleMin("system.gpu-load");f.contentWindow.Win.flush()});
at(9000,function(){f.contentWindow.location.reload()});
at(13000,function(){res.reloaded=snap()});
`;
const FRAME = `<body style="margin:0"><iframe id="f" src="/page" style="width:1500px;height:5000px;border:0"></iframe><script>${SCRIPT}</script></body>`;

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

interface Rc { x: number; y: number; w: number; h: number; disp: string; cls: string; pa: string }
interface Sn { g: Rc; a: Rc; b: Rc; c: Rc; e: Rc | null; chips: string[]; btn: boolean; root?: Rc }

describe.skipIf(!CHROME)("minimized cards dock at the bottom of their container", () => {
  it("nested: leaves the layout, chip at the group bottom, restore returns the rect, root unchanged, reload keeps it", async () => {
    const dom = await dumpDom(`${base}/frame`, { width: 1600, height: 5200, budgetMs: 20000 });
    const m = /data-res="([^"]*)"/.exec(dom);
    if (!m) throw new Error("no result in dump");
    const r = JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&")) as { before: Sn; mined: Sn; restored: Sn; reloaded: Sn; root: Rc; rootChip: boolean };
    const near = (a: number, b: number) => Math.abs(a - b) <= 1;
    // the default-minimized system cards are chips already
    expect(r.before.chips).toContain("system.ane-load");
    // gone from its row, siblings take the room
    expect(r.before.b.disp).toBe("");
    expect(r.mined.chips).toContain("system.gpu-load");
    expect(r.mined.btn).toBe(true);
    const chip = r.mined.b;
    expect(chip.h).toBe(22);
    expect(chip.cls).toContain("chip");
    // at the bottom of the container body
    expect(chip.y + chip.h).toBeGreaterThan(r.mined.g.y + r.mined.g.h - 12);
    expect(chip.y).toBeGreaterThan(r.mined.a.y + r.mined.a.h - 1);
    expect(r.mined.a.w).toBeGreaterThanOrEqual(r.before.a.w);
    // restore: back on the same rect
    for (const k of ["x", "y", "w", "h"] as const) expect(near(r.restored.b[k], r.before.b[k]), `restored ${k}: ${r.restored.b[k]} vs ${r.before.b[k]}`).toBe(true);
    expect(r.restored.chips).not.toContain("system.gpu-load");
    // root group minimizes in place: header height, no chip
    expect(r.root.h).toBe(28);
    expect(r.rootChip).toBe(false);
    expect(near(r.root.y, r.before.root!.y)).toBe(true);
    // reload keeps the dock
    expect(r.reloaded.chips).toContain("system.gpu-load");
  }, 60000);

  it("PAI_WIN_SHOTS=<dir> writes mindock.png of the default page", async () => {
    const dir = process.env.PAI_WIN_SHOTS;
    if (!dir) return;
    await screenshot(`${base}/page`, join(dir, "mindock.png"), { width: 1500, height: 2600, budgetMs: 8000 });
  }, 60000);
});
