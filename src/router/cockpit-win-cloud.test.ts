/**
 * B7 `cloud`: the real page with ?win=1 shows limits as server / down-list / provider cards, start and stop through runAction. Headless Chromium, skipped when none is installed.
 * PAI_WIN_SHOTS=<dir> writes cloud-<width>-<theme>.png.
 */

import { execFile, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cockpitHtml } from "./cockpit-page.js";

const CHROME = process.env.CHROME_BIN ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));

const data = () => ({
  window: "1h", totals: { requests: 5000, input: 9e6, output: 4e5, cacheWrite: 1e6, cacheRead: 9e7, errors: 0, hitRatio: 0.9 },
  byModel: [], series: [], weights: { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 }, cachePause: [], byProvider: [],
  bustParts: {}, bySession: [], workers: [], daily: { models: {}, days: [] }, sessionSplit: null, speed: [], promptByProvider: {}, promptSince: {},
});
const win = (name: string, percent: number) => ({ name, percent, resetAt: Date.now() + 3_600_000 });
const limits = () => ({
  activeLocal: "gyro", runningLocal: ["gyro", "iq3s", "coder"],
  limits: [
    { provider: "gyro", kind: "local", up: true, rssMb: 20480, tokensPerSec: 41, served: ["org/gyro-m"], windows: [] },
    { provider: "iq3s", kind: "local", up: false, starting: { state: "loading", sinceSec: 12, message: "", log: "" }, windows: [] },
    { provider: "coder", kind: "local", up: coderUp, windows: [] },
    { provider: "glm", kind: "cloud", windows: [win("5h", 30), win("week", 60)] },
    { provider: "claude", kind: "cloud", windows: [], error: "no key" },
  ],
  routing: { flow: "", endpoints: [], choices: [], rows: [] },
});
let coderUp = false;
const posts: { [k: string]: unknown }[] = [];

/** Reads the cards, then drives the stop (confirm) of the gyro server and the start of the down coder model. */
const PROBE = `<script>setTimeout(function(){
function card(id){return document.querySelector('#win-root [data-card="'+id+'"]')}
function txt(id){var c=card(id);return c?c.textContent.replace(/\\s+/g," "):null}
function st(id){var c=card(id);var s=c&&c.querySelector(".cstatus");return s?s.textContent:null}
var o={err:window.__err||null,gyro:txt("limits.local.srv:gyro"),iq3s:txt("limits.local.srv:iq3s"),down:txt("limits.local.down"),
 glm:txt("limits.cloud:glm"),claude:txt("limits.cloud:claude"),gauges:document.querySelectorAll('#win-root [data-card="limits.cloud:glm"] .gauge').length,
 downHidden:!card("limits.local.down")||card("limits.local.down").style.display==="none",
 over:["limits.local.srv:gyro","limits.cloud:glm","limits.cloud:claude"].map(function(i){var b=card(i)&&card(i).querySelector(".cbody");return b?[i,b.scrollHeight-b.clientHeight]:[i,-1]}),
 scrollbarColor:card("limits.cloud:glm")?getComputedStyle(card("limits.cloud:glm").querySelector(".cbody")).scrollbarColor:null,
 oldCl:getComputedStyle(document.querySelector('[data-section="cloud"]')).display,
 vis:Array.prototype.filter.call(document.querySelectorAll("#win-root .card"),function(c){return c.style.display!=="none"}).map(function(c){return c.getAttribute("data-card")})};
if(!card("limits.local.srv:gyro")){document.body.setAttribute("data-r",JSON.stringify(o));return}
var stop=card("limits.local.srv:gyro").querySelector('[data-act="stop"]');
stop.click();o.armed=stop.textContent;stop.click();
var sb=card("limits.local.down").querySelector("[data-start]");if(sb)sb.click();
setTimeout(function(){o.stopSt=st("limits.local.srv:gyro");o.startSt=st("limits.local.down");document.body.setAttribute("data-r",JSON.stringify(o))},800);
},1500)</script>`;

let server: Server;
let base = "";
let tmp = "";
const browsers = new Set<ChildProcess>();
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "cockpit-win-cloud-"));
  server = createServer((req, res) => {
    const url = req.url ?? "";
    res.setHeader("content-type", "application/json");
    if (url.startsWith("/cockpit/action") && req.method === "POST") {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => { posts.push(JSON.parse(b)); res.end(JSON.stringify({ ok: true, message: "done" })); });
      return;
    }
    if (url.startsWith("/cockpit/data")) return res.end(JSON.stringify(data()));
    if (url.startsWith("/cockpit/limits")) return res.end(JSON.stringify(limits()));
    if (url.startsWith("/cockpit/")) return res.end("{}");
    if (url.startsWith("/page")) {
      res.setHeader("content-type", "text/html");
      return res.end(cockpitHtml().replace("</head>", '<script>window.onerror=function(m,s,l,c){window.__err=String(m)+" @"+l+":"+c}</script></head>').replace("</body>", PROBE + "</body>"));
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => { for (const c of browsers) c.kill("SIGKILL"); server?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = execFile(CHROME!, args, { encoding: "utf8", timeout: 60_000, maxBuffer: 64 << 20 }, (err, stdout) => { browsers.delete(c); err ? reject(err) : resolve(stdout); });
    browsers.add(c);
  });
}
async function open(query: string, width: number, shot?: string) {
  const args = ["--headless=new", "--disable-gpu", "--use-mock-keychain", "--password-store=basic", "--no-first-run", "--hide-scrollbars", `--user-data-dir=${join(tmp, "p" + Math.random().toString(36).slice(2))}`, `--window-size=${width},900`, "--virtual-time-budget=6000"];
  const url = `${base}/page${query}`;
  const dom = await run([...args, "--dump-dom", url]);
  if (shot) await run([...args, `--screenshot=${shot}`, url]);
  const m = /data-r="([^"]*)"/.exec(dom);
  if (!m) throw new Error("no probe result in dump");
  return JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
}

describe.skipIf(!CHROME)("B7 cloud on the win runtime (?win=1)", () => {
  it("server cards, the down list and provider cards replace the old section", async () => {
    const shots = process.env.PAI_WIN_SHOTS;
    const r = await open("?win=1", 1400, shots ? join(shots, "cloud-1400-light.png") : undefined);
    expect(r.err).toBeNull();
    expect(r.vis).toEqual(expect.arrayContaining(["limits-local", "limits.local.srv:gyro", "limits.local.srv:iq3s", "limits.local.down", "limits-cloud", "limits.cloud:glm", "limits.cloud:claude"]));
    expect(r.gyro).toContain("up");
    expect(r.gyro).toContain("gyro-m");
    expect(r.iq3s).toContain("starting");
    expect(r.down).toContain("1 local model down");
    expect(r.down).toContain("coder");
    expect(r.gauges).toBe(2);
    expect(r.glm).toContain("60%");
    expect(r.claude).toContain("no reading");
    expect(r.oldCl).toBe("none");
    // F1/F2: a card's default height fits its content (no overflow scroll, the gauge labels are not clipped)
    for (const [id, over] of r.over) expect(over, id).toBeLessThanOrEqual(0);
    expect(r.scrollbarColor).not.toBe("auto");
  }, 120_000);

  it("F3: with no local model down the down list card is not shown; it is shown with one", async () => {
    coderUp = true;
    try {
      const r = await open("?win=1", 1400);
      expect(r.err).toBeNull();
      expect(r.downHidden).toBe(true);
      expect(r.vis).not.toContain("limits.local.down");
    } finally { coderUp = false; }
    expect((await open("?win=1", 1400)).downHidden).toBe(false);
  }, 120_000);

  it("stop confirms on a second click and posts local.stop; start posts local.start; status shows the result", async () => {
    posts.length = 0;
    const r = await open("?win=1", 1400);
    expect(r.armed).toContain("click again");
    expect(posts).toContainEqual({ action: "local.stop", target: "gyro" });
    expect(posts).toContainEqual({ action: "local.start", target: "coder" });
    expect(r.stopSt).toBe("done");
    expect(r.startSt).toBe("done");
  }, 120_000);

  it("without the flag the old cloud section is unchanged", async () => {
    const r = await open("", 1400);
    expect(r.err).toBeNull();
    expect(r.oldCl).not.toBe("none");
    expect(r.vis).toEqual([]);
  }, 120_000);
});
