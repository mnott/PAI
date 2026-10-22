/** Root grid invariants (headless): every card inside its parent, no sibling overlap; PAI_GRID=1 prints rects. */

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

const MOVE = `<script>
setTimeout(function(){
 if(location.search.indexOf("mv=1")<0)return;
 var st=Win.state(),tk=st.kids["tokens-group"];
 Win.apply("tokens-group",{k:"s",d:"c",ch:tk.ch.slice(0,2),sz:[0.5,0.5]});
 var sm=st.kids["sys-metrics"];
 Win.apply("sys-metrics",{k:"s",d:"c",ch:[sm,{k:"c",id:"speed"}],sz:[0.8,0.2]});
},5000);
</script>`;
const PROBE = `<script>
setTimeout(function(){
 var cards=Array.prototype.slice.call(document.querySelectorAll("#win-root .card")).filter(function(c){return c.style.display!=="none"});
 var out=[];
 cards.forEach(function(c){
  var b=c.getBoundingClientRect(),p=c.parentElement&&c.parentElement.closest(".card"),pb=p?p.getBoundingClientRect():null,id=c.getAttribute("data-card");
  out.push({id:id,p:p?p.getAttribute("data-card"):null,x:Math.round(b.left),y:Math.round(b.top+scrollY),w:Math.round(b.width),h:Math.round(b.height),chip:c.classList.contains("chip"),
   pr:pb?{x:Math.round(pb.left),y:Math.round(pb.top+scrollY),w:Math.round(pb.width),h:Math.round(pb.height)}:null,tr:getComputedStyle(c).transform,
   trunc:c.classList.contains("chip")?(function(){var t=c.querySelector("*")||c;return c.scrollWidth>c.clientWidth+1})():false});
 });
 document.body.setAttribute("data-r",JSON.stringify(out));
 document.body.setAttribute("data-e",String(window.__err)+" "+location.search+" "+JSON.stringify(Win.state().kids["tokens-group"]).slice(0,300));
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
      return res.end(cockpitHtml().replace("</head>", '<script>window.onerror=function(m,s,l,c){window.__err=String(m)+" @"+l+":"+c}</script></head>').replace("</body>", MOVE + PROBE + "</body>"));
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => { killChromes(); server?.close(); });

type Box = { x: number; y: number; w: number; h: number };
type Row = Box & { id: string; p: string | null; chip: boolean; pr: Box | null; tr: string; trunc: boolean };
async function read(width: number, q = "") {
  const dom = await dumpDom(`${base}/page${q}`, { width, height: 900, budgetMs: 15000 });
  const m = /data-r="([^"]*)"/.exec(dom);
  if (!m) throw new Error("no probe result in dump");
  if (process.env.PAI_GRID) console.log(/data-e="([^"]*)"/.exec(dom)?.[1]);
  return JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")) as Row[];
}
const inter = (a: Box, b: Box) => a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1;
function overlaps(rows: Row[]) {
  const bad: string[] = [];
  for (const r of rows) {
    if (r.pr && (r.x < r.pr.x - 1 || r.y < r.pr.y - 1 || r.x + r.w > r.pr.x + r.pr.w + 1 || r.y + r.h > r.pr.y + r.pr.h + 1)) bad.push(`${r.id} outside ${r.p}`);
    for (const s of rows) if (r.id < s.id && r.p === s.p && inter(r, s)) bad.push(`${r.id} x ${s.id}`);
  }
  return bad;
}

describe.skipIf(!CHROME)("root grid readings", () => {
  it("a card moved between groups is drawn inside its new group (540 px)", async () => {
    const rows = await read(540, "?mv=1");
    const sp = rows.find((r) => r.id === "speed");
    expect(sp?.p).toBe("sys-metrics");
    expect(overlaps(rows)).toEqual([]);
  }, 120_000);
  for (const width of [540, 1100]) {
    it(`${width} px`, async () => {
      const rows = await read(width);
      if (process.env.PAI_GRID) console.log(`${width} px\n` + rows.map((r) => `${r.id}\tp=${r.p}\t${r.x},${r.y} ${r.w}x${r.h}\ttr=${r.tr}${r.chip ? "\tchip trunc=" + r.trunc : ""}`).join("\n"));
      expect(overlaps(rows)).toEqual([]);
    }, 120_000);
  }
});
