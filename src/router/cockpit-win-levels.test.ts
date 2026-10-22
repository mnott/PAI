/**
 * Group levels: every group card carries data-depth (0 = a top-level band, a nested group one deeper);
 * a top-level header has its own tint (--grp-h1..h8 by DOM position), a 13px title, a 2px bottom border, a
 * 3px left edge in its own --sec colour and a 6px inset body; a nested header keeps the 12px title and has no
 * left edge; a leaf card has no data-depth
 * and its body keeps the old padding. Headless Chromium, skipped when none is installed.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cockpitHtml } from "./cockpit-page.js";
import { CHROME, dumpDom, killChromes } from "./cdp-browser.js";

const data = () => ({
  window: "1h", totals: { requests: 5000, input: 9e6, output: 4e5, cacheWrite: 1e6, cacheRead: 9e7, errors: 0, hitRatio: 0.9 },
  byModel: [], series: [], weights: { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 }, cachePause: [], byProvider: [],
  bustParts: {}, bySession: [], workers: [], daily: { models: {}, days: [] }, sessionSplit: null, speed: [], promptByProvider: {}, promptSince: {},
});
const queue = () => ({
  providers: [{ provider: "local", cap: 1, conversationSlots: 2, running: [], waiting: [] }],
  panes: [], paneViolations: [], plans: [], builds: { slots: 2, testSlots: 1, running: [], waiting: [] }, sessionMax: {}, localModel: "local model gyro-m up", worktrees: "3 worktrees",
});
const pool = () => ({
  enabled: true, hostUp: true, port: 4711, maxSlots: 3, idleKillSecs: 600, hostSince: "2026-10-21 08:00", hostBuiltAt: null, hostStale: false,
  hostLastSeen: "2026-10-20 12:00", slots: [], spares: [], spareClaims: 0, spareMisses: [], totals: { tasksServed: 0, tokensCarried: 0, hitRatio: 0, carriedTasks: 0 },
  last24h: { runs: 0, pooled: 0, notPooled: 0, reasons: [], topReason: null, unattributed: 0, poolOff: 0 }, offReason: null, message: "m",
});
const limits = () => ({ activeLocal: null, limits: [], routing: { flow: "", endpoints: [], choices: [], rows: [] } });
const models = () => ({ registryModels: [], runtimes: [], consumers: [], instances: [], tiers: [], runtimeCommands: {} });
const memory = () => ({ coverage: null, embedded: null, chunks: null, files: null, exact: false, backend: null, jobs: [], passes: [], daemon: null });

const PROBE = `<script>setTimeout(function(){
function rgb(c){var m=c.match(/[\\d.]+/g);return m?m.slice(0,3).map(Number).join(","):c}
var o={err:window.__err||null,theme:document.documentElement.dataset.theme,groups:[],leaves:[]};
Array.prototype.forEach.call(document.querySelectorAll("#win-root .card[data-type=group]"),function(c){
 var head=c.querySelector(".chead"),body=c.querySelector(".cbody.cgroup"),tt=c.querySelector(".ctitle");
 o.groups.push({id:c.getAttribute("data-card"),depth:c.getAttribute("data-depth"),
  headBg:rgb(getComputedStyle(head).backgroundColor),borderBottom:getComputedStyle(head).borderBottomWidth,borderLeft:getComputedStyle(head).borderLeftWidth,borderLeftColor:rgb(getComputedStyle(head).borderLeftColor),
  titleSize:getComputedStyle(tt).fontSize,titleColor:rgb(getComputedStyle(tt).color),
  bodyPad:getComputedStyle(body).paddingTop,bodyBg:rgb(getComputedStyle(body).backgroundColor)});
});
Array.prototype.forEach.call(document.querySelectorAll("#win-root .card:not([data-type=group])"),function(c){
 var head=c.querySelector(".chead"),body=c.querySelector(".cbody");
 o.leaves.push({id:c.getAttribute("data-card"),depth:c.getAttribute("data-depth"),
  headBg:rgb(getComputedStyle(head).backgroundColor),borderLeft:getComputedStyle(head).borderLeftWidth,
  bodyPad:getComputedStyle(body).paddingTop});
});
document.body.setAttribute("data-r",JSON.stringify(o))},2500)</script>`;

let server: Server;
let base = "";
let tmp = "";
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "cockpit-win-levels-"));
  server = createServer((req, res) => {
    const url = req.url ?? "";
    res.setHeader("content-type", "application/json");
    if (url.startsWith("/cockpit/data")) return res.end(JSON.stringify(data()));
    if (url.startsWith("/cockpit/queue")) return res.end(JSON.stringify(queue()));
    if (url.startsWith("/cockpit/pool")) return res.end(JSON.stringify(pool()));
    if (url.startsWith("/cockpit/limits")) return res.end(JSON.stringify(limits()));
    if (url.startsWith("/cockpit/models")) return res.end(JSON.stringify(models()));
    if (url.startsWith("/cockpit/memory")) return res.end(JSON.stringify(memory()));
    if (url.startsWith("/cockpit/registry/backups")) return res.end(JSON.stringify({ backups: [] }));
    if (url.startsWith("/cockpit/registry")) return res.end(JSON.stringify({ yaml: "workers:\n", mtime: 1, hash: "h" }));
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
afterAll(async () => {
  killChromes();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(tmp, { recursive: true, force: true });
});

describe("group levels on the page", () => {
  it.skipIf(!CHROME)("a group carries data-depth; top-level and nested headers differ; a leaf is untouched", async () => {
    const dom = await dumpDom(`${base}/page`, { width: 1300, height: 1400, budgetMs: 6000 });
    const m = dom.match(/data-r="([^"]+)"/);
    expect(m, "the probe wrote no data-r").toBeTruthy();
    const r = JSON.parse(m![1].replace(/&quot;/g, '"'));
    expect(r.err).toBe(null);
    expect(r.groups.length).toBeGreaterThanOrEqual(4);
    const byId = Object.fromEntries(r.groups.map((g: any) => [g.id, g]));
    // the three levels of the example: system (0) > sys-metrics (1) > a metric leaf (none)
    expect(byId.system.depth).toBe("0");
    expect(byId["sys-metrics"].depth).toBe("1");
    expect(byId["sys-power"].depth).toBe("1");
    expect(byId["sys-servers"].depth).toBe("1");
    expect(byId.kpis.depth).toBe("0");
    expect(byId.cache.depth).toBe("0");
    expect(byId["cache-rings"].depth).toBe("1");
    // top-level: tinted header, 13px title, 2px bottom border, 6px inset body
    const cardBg = r.leaves.find((l: any) => l.id === "system.memory").headBg;
    expect(byId.system.headBg).not.toBe(cardBg); // tinted, not the plain card background
    expect(byId.system.titleSize).toBe("13px");
    expect(byId.system.borderBottom).toBe("2px");
    expect(byId.system.bodyPad).toBe("6px");
    // top-level: the header is a solid section-colour bar, no left edge (4cdfd8de)
    expect(byId.system.borderLeft).toBe("0px");
    // nested: no left edge, normal title size, inset body
    expect(byId["sys-metrics"].borderLeft).toBe("0px");
    expect(byId["sys-metrics"].titleSize).toBe("12px");
    expect(byId["sys-metrics"].bodyPad).toBe("6px");
    // a nested header's tint differs from the top-level one and from the plain card
    expect(byId["sys-metrics"].headBg).not.toBe(byId.system.headBg);
    // leaf cards: no depth marker, plain header, no inset
    const leaf = r.leaves.find((l: any) => l.id === "system.memory");
    expect(leaf).toBeTruthy();
    expect(leaf.depth).toBe(null);
    expect(leaf.borderLeft).toBe("0px");
    expect(leaf.bodyPad).toBe("0px");
    // the top-level groups cycle the 8-hue palette by DOM position: the first eight get distinct tints
    const tops = r.groups.filter((g: any) => g.depth === "0").map((g: any) => g.headBg);
    expect(new Set(tops.slice(0, 8)).size).toBe(8);
  }, 60_000);
});
