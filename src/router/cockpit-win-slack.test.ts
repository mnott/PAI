/**
 * Content-driven heights (headless fixture check): the real page at 540 and 1100 px. A card without a user height is at most 16 px
 * taller than its content (a leaf: its body squeezed to the header reads its content; a group: its lowest child or dock chip), and a
 * group's dock sits at or below its last line. PAI_SLACK=1 prints the table and the 5 largest.
 */

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cockpitHtml } from "./cockpit-page.js";
import { CHROME, dumpDom, killChromes } from "./cdp-browser.js";

let phase = "A";
const LONG = "upstream connect error or disconnect/reset before headers. reset reason: connection termination while talking to a very long provider host name ".repeat(3);

const data = () => {
  const b = phase !== "A";
  return {
    window: b ? "week" : "1h",
    totals: { requests: b ? 90000 : 5000, input: 9e6, output: 4e5, cacheWrite: 1e6, cacheRead: 9e7, errors: b ? 40 : 0, hitRatio: b ? null : 0.9 },
    byModel: [{ model: "m-one", requests: b ? 99999 : 10, input: 1e6, output: 1e5, cacheWrite: 1e5, cacheRead: 1e6, errors: b ? 3 : 0, hitRatio: b ? null : 0.5 }],
    series: [], weights: { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 }, cachePause: [], byProvider: [],
    bustParts: {}, bySession: [], workers: [], daily: { models: {}, days: [] }, sessionSplit: null, speed: [], promptByProvider: {}, promptSince: {},
    errors: b ? [{ at: 1, model: "m-one", message: LONG }] : [],
  };
};
const waiting = (n: number, long: boolean) => Array.from({ length: n }, (_, i) => ({ id: `w-${i}`, label: (long ? LONG : "waiting job ") + i, waitedSec: 30 + i, position: i + 1, session: "PAI", model: "m1" }));
const queue = () => ({
  providers: [
    { provider: "local", cap: 1, conversationSlots: 2, running: [{ id: "w-run", label: "running job", ageSec: 120, now: "editing", session: "PAI", model: "m1" }], waiting: waiting(phase === "A" ? 2 : 6, phase !== "A") },
    { provider: "glm", cap: 3, running: [{ id: "w-g", label: "glm job", ageSec: 90, now: "", session: "Whazaa", model: "glm-5" }], waiting: [] },
  ],
  panes: [{ label: "pane one", cwd: "/work/x", ageSec: 50, log: "/tmp/l" }], paneViolations: [], plans: [{ job: "plan-1", merged: 1, total: 3, phase: "build", phaseSec: 10, ageSec: 99, running: ["a"] }],
  builds: { slots: 2, testSlots: 1, running: [{ kind: "test", id: "t1", label: "vitest", session: "PAI", ageSec: 5 }], waiting: [] },
  sessionMax: {}, localModel: phase === "A" ? LONG : "local model gyro-m up", worktrees: phase === "A" ? "3 worktrees" : LONG,
});
const users = (n: number) => Array.from({ length: n }, (_, i) => `worker:consumer-with-a-long-name-${i}`);
const mlist = (p: string, n: number, u = 1) => Array.from({ length: n }, (_, i) => ({ model: `${p}-model-${i}.gguf`, kind: "coding", loaded: i === 0, memoryMb: 4096, usedBy: users(u) }));
const models = () => ({
  at: 1, tiers: [{ tier: "gyro-m", maxInstances: 2 }, { tier: "iq3s", maxInstances: 1 }], consumers: [], runtimeCommands: {},
  instances: [{ id: "gyro-m-1", model: "gyro-m", state: "ready", port: 8101, pid: 11, inflight: 0 }],
  runtimes: [
    { name: "strata", kind: "strata", port: 8101, status: "running", tier: "gyro-m", users: ["worker:local"], models: mlist("g", phase === "A" ? 1 : 5, phase === "A" ? 1 : 9) },
    { name: "strata2", kind: "strata", port: 8102, status: "stopped", tier: "iq3s", users: [], models: mlist("i", phase === "A" ? 4 : 1, phase === "A" ? 9 : 1) },
  ].concat(phase === "C" ? [{ name: "strata3", kind: "strata", port: 8103, status: "running", tier: "gyro-m", users: [], models: [{ model: "new.gguf", kind: "chat", loaded: true, memoryMb: 100, usedBy: [] }] }] : []),
});
const limits = () => ({
  activeLocal: null,
  limits: [{ provider: "glm", kind: "cloud", windows: [{ name: "5h", percent: phase === "A" ? 30 : null, resetAt: phase === "A" ? Date.now() + 3600_000 : null }] }],
  routing: { flow: "", choices: [], rows: [], endpoints: [{ id: "ep1", origin: "registered", host: "h1", healthy: true, enabled: true, tags: [], classes: [] }] },
});

const PROBE = `<script>
setTimeout(function(){
 var cards=Array.prototype.slice.call(document.querySelectorAll("#win-root .card")).filter(function(c){return c.style.display!=="none"});
 var out=[],i;
 function r(c){var b=c.getBoundingClientRect();return{t:b.top+window.scrollY,b:b.bottom+window.scrollY,l:b.left,r:b.right}}
 for(i=0;i<cards.length;i++){
  var c=cards[i],id=c.getAttribute("data-card"),g=c.querySelector(":scope>.cbody.cgroup"),b=r(c),o={id:id,h:Math.round(b.b-b.t),kind:g?"group":"leaf",chart:c.getAttribute("data-type")==="chart",chip:c.classList.contains("chip")};
  if(c.classList.contains("chip")){out.push(o);continue}
  if(g){
   var kids=Array.prototype.slice.call(g.children).filter(function(k){return k.style.display!=="none"}),m=0,dk=1e9;
   kids.forEach(function(k){var kb=r(k);m=Math.max(m,kb.b);if(k.classList.contains("chip"))dk=Math.min(dk,kb.t)});
   var nonChip=kids.filter(function(k){return!k.classList.contains("chip")}),lb=0;
   nonChip.forEach(function(k){lb=Math.max(lb,r(k).b)});
   o.content=kids.length?Math.round(m-b.t):28;o.dock=dk<1e9?Math.round(dk-lb):null;
  }else{
   var body=c.querySelector(":scope>.cbody"),h0=c.style.height,st=body.scrollTop;
   c.style.height="28px";o.content=Math.ceil(body.scrollHeight)+28;c.style.height=h0;body.scrollTop=st;
  }
  o.user=c.hasAttribute("data-uh");
  out.push(o);
 }
 document.body.setAttribute("data-r",JSON.stringify(out));
},9000);
</script>`;

let server: Server;
let base = "";
beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "";
    res.setHeader("content-type", "application/json");
    if (url.startsWith("/cockpit/data")) return res.end(JSON.stringify(data()));
    if (url.startsWith("/cockpit/queue")) return res.end(JSON.stringify(queue()));
    if (url.startsWith("/cockpit/models")) return res.end(JSON.stringify(models()));
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
afterAll(() => { killChromes(); server?.close(); });

type Row = { chart?: boolean; id: string; h: number; kind: string; chip: boolean; content?: number; dock: number | null; user: boolean };
async function read(width: number) {
  const dom = await dumpDom(`${base}/page`, { width, height: 900, budgetMs: 15000 });
  const m = /data-r="([^"]*)"/.exec(dom);
  if (!m) throw new Error("no probe result in dump");
  return JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")) as Row[];
}

describe.skipIf(!CHROME)("content-driven heights: no empty space at the bottom of a card", () => {
  for (const width of [540, 1100]) {
    it(`${width} px: box height minus content height is at most 16 px; the dock is below the last line`, async () => {
      const rows = (await read(width)).filter((r) => !r.chip && r.content !== undefined && !r.user && !r.chart);
      expect(rows.length).toBeGreaterThan(15);
      const slack = rows.map((r) => ({ id: r.id, kind: r.kind, h: r.h, content: r.content!, slack: r.h - r.content! })).sort((a, b) => b.slack - a.slack);
      if (process.env.PAI_SLACK) console.log(`${width} px: ${rows.length} cards\n` + slack.slice(0, 5).map((s) => `${s.id}\t${s.kind}\th ${s.h}\tcontent ${s.content}\tslack ${s.slack}`).join("\n"));
      expect(slack.filter((s) => s.slack > 16).map((s) => `${s.id} ${s.slack}`)).toEqual([]);
      for (const r of rows) if (r.dock != null) expect(r.dock, `${r.id} dock top vs last line bottom`).toBeGreaterThanOrEqual(0);
    }, 120_000);
  }
});
