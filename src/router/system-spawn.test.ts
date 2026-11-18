import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SystemMonitor } from "./system.js";
import { parseListenPorts } from "../workers/local-instances.js";

describe("no mactop in the router", () => {
  it("SystemMonitor never runs mactop or top", async () => {
    const cmds: string[] = [];
    const m = new SystemMonitor({ file: "/dev/null", telemetryFile: "/dev/null", run: async (c) => (cmds.push(c), "") });
    await m.current();
    expect(cmds.some((c) => /mactop|top$/.test(c))).toBe(false);
  });
  it("no router/workers source spawns mactop", () => {
    for (const dir of ["src/router", "src/workers", "src/daemon"]) {
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts") && !x.endsWith(".test.ts"))) {
        const src = readFileSync(join(dir, f), "utf8");
        expect(/\b(exec|execFile|spawn)\w*\([^)]*mactop/.test(src), `${dir}/${f}`).toBe(false);
      }
    }
  });
});

describe("listening-port parse", () => {
  it("collects ports from one lsof -Fpn listing", () => {
    expect([...parseListenPorts("p1\nn*:8037\nn127.0.0.1:11434\nn[::1]:80\n")].sort((a, b) => a - b)).toEqual([80, 8037, 11434]);
  });
});

describe("cockpit page script", () => {
  it("every inline script of the served page parses", async () => {
    const { Script } = await import("node:vm");
    const { cockpitHtml } = await import("./cockpit-page.js");
    const scripts = [...cockpitHtml().matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((s) => s.trim());
    expect(scripts.length).toBeGreaterThan(0);
    for (const src of scripts) expect(() => new Script(src)).not.toThrow();
  });
  it("queue row renders as one line with at most five action buttons (pause, next, up, down, menu)", async () => {
    const vm = await import("node:vm");
    const { WIN_WORKERS_JS } = await import("./cockpit-page/win/cards-workers.js");
    const ctx = vm.createContext({});
    vm.runInContext(`function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}\n` + WIN_WORKERS_JS, ctx);
    const row = { slot: 1, kind: "job", id: "w-20261118-120000-55574", sid: "55574", state: "waiting", stateText: "waiting for a local slot", priority: "normal", session: "mdf", model: "gyro-l", modelFull: "local: qwen", local: true, task: "a very long task text ".repeat(20), summary: "Fix the queue. It lists pane runs as jobs.", seconds: 70, activity: "", now: "", detail: "", restarting: true, waits: [{ id: "pane-1", label: "wait: right pane fix (local)" }], actions: ["next", "up", "down", "pause", "freeze", "deep-freeze", "to-cloud", "prio-low", "prio-normal", "prio-high", "prio-now"] };
    (ctx as Record<string, unknown>).__r = row;
    const html = vm.runInContext("wkTRow(__r)", ctx) as string;
    expect(html.match(/<tr/g)).toHaveLength(1);
    expect(html).not.toContain("<br");
    expect((html.match(/<button/g) ?? []).length - (html.match(/class="wq-chip/g) ?? []).length).toBeLessThanOrEqual(5);
    expect(html).toContain("waiting #1");
    expect(html).toContain("restarting on new version");
    // the task tooltip: the task, the plain-prose summary and the full worker id
    expect(html).toContain('title="a very long task');
    expect(html).toContain("Fix the queue. It lists pane runs as jobs.");
    expect(html).toContain("id: w-20261118-120000-55574");
    // the short id in grey under the task; the waiting-session eye with its tooltip
    expect(html).toContain('<div class="wq-id"');
    expect(html).toContain(">55574<");
    expect(html).toContain('class="wq-eye"');
    expect(html).toContain("a session waits for this job: wait: right pane fix (local)");
    expect(html).toContain("aria-label=");
  });
  it("the row … menu carries copy id; a pane run is never drawn as a queue row", async () => {
    const vm = await import("node:vm");
    const { WIN_WORKERS_JS } = await import("./cockpit-page/win/cards-workers.js");
    const ctx = vm.createContext({});
    vm.runInContext(`function esc(s){return String(s==null?"":s)}\n` + WIN_WORKERS_JS, ctx);
    const row = { slot: "running", kind: "job", id: "w-1", sid: "1", state: "running", stateText: "running", priority: "normal", session: "mdf", model: "", local: false, task: "t", seconds: 5, activity: "", now: "", detail: "", actions: ["pause"] };
    (ctx as Record<string, unknown>).__rows = [row];
    vm.runInContext("WQ={table:__rows};WK_MENU={key:'row:w-1',x:0,y:0}", ctx);
    expect(vm.runInContext("wkMenuHtml()", ctx)).toContain('data-copy="copy"');
    expect(vm.runInContext("wkMenuHtml()", ctx)).toContain("copy id");
  });
  it("waiting rows show inline move up and move down only where they change something", async () => {
    const vm = await import("node:vm");
    const { WIN_WORKERS_JS } = await import("./cockpit-page/win/cards-workers.js");
    const ctx = vm.createContext({});
    vm.runInContext(`function esc(s){return String(s==null?"":s)}\n` + WIN_WORKERS_JS, ctx);
    const mk = (id: string, actions: string[]) => ({ slot: 1, kind: "job", id, state: "waiting", stateText: "", priority: "normal", session: "mdf", model: "", local: true, task: id, seconds: 5, activity: "", now: "", detail: "", actions });
    (ctx as Record<string, unknown>).__f = mk("f", ["pause", "next", "down"]);
    (ctx as Record<string, unknown>).__m = mk("m", ["pause", "next", "up", "down"]);
    (ctx as Record<string, unknown>).__l = mk("l", ["pause", "next", "up"]);
    const row = (n: string) => vm.runInContext(`wkTRow(__${n})`, ctx) as string;
    expect(row("m")).toContain('data-qa="up"');
    expect(row("m")).toContain('data-qa="down"');
    expect(row("m")).toContain("move down: one place later in the waiting order");
    expect(row("m")).toContain("move up: one place earlier in the waiting order");
    expect(row("f")).not.toContain('data-qa="up"');
    expect(row("f")).toContain('data-qa="down"');
    expect(row("l")).toContain('data-qa="up"');
    expect(row("l")).not.toContain('data-qa="down"');
    // not duplicated in the … menu
    (ctx as Record<string, unknown>).__rows = [mk("m", ["pause", "next", "up", "down"])];
    vm.runInContext("WQ={table:__rows};WK_MENU={key:'row:m',x:0,y:0}", ctx);
    expect(vm.runInContext("wkMenuHtml()", ctx)).not.toContain('data-qa="down"');
  });
  it("the activity word shows with its meaning in the tooltip", async () => {
    const vm = await import("node:vm");
    const { WIN_WORKERS_JS } = await import("./cockpit-page/win/cards-workers.js");
    const ctx = vm.createContext({});
    vm.runInContext(`function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}\n` + WIN_WORKERS_JS, ctx);
    const mk = (activity: string, activityTip: string) => ({ slot: "running", kind: "job", id: "w1", state: "running", stateText: "running", priority: "normal", session: "mdf", model: "gyro-l", local: true, task: "t", seconds: 5, activity, activityTip, now: "Bash: npm test", detail: "", actions: [] });
    (ctx as Record<string, unknown>).__a = mk("writing", "its request is open at the model — the model is writing its reply");
    (ctx as Record<string, unknown>).__b = mk("tool", "no request open at the model; a tool (build, test) is running");
    const html = vm.runInContext("wkTRow(__a)", ctx) as string;
    expect(html).toContain('<span class="wq-act" title="its request is open at the model — the model is writing its reply">writing</span>');
    expect(vm.runInContext("wkTRow(__b)", ctx)).toContain('title="no request open at the model; a tool (build, test) is running');
    // every word has a tooltip, idle included
    (ctx as Record<string, unknown>).__c = mk("idle 10m", "no request at the model and no tool running for 10 minutes; it may be stuck");
    expect(vm.runInContext("wkTRow(__c)", ctx)).toContain('title="no request at the model and no tool running for 10 minutes; it may be stuck');
    // the (i) legend carries a real CSS tooltip: shown on hover AND click/tap, never only the native title
    const bar = vm.runInContext("wkBar({table:[]})", ctx) as string;
    expect(bar).toContain('class="wq-i"');
    expect(bar).toContain('data-tip=');
    expect(bar).toContain('<span class="wq-tip" role="tooltip">');
    // the legend itself: states, activity words (both 'in line' meanings), buttons and chips
    for (const w of ["writing =", "in line =", "tool =", "waiting =", "idle Nm ="]) expect(bar).toContain(w);
    expect(bar).toContain("either at the engine or for a slot");
    expect(bar).toContain("Buttons: ▶ one step toward running");
    expect(bar).toContain("⏸ one step toward paused");
    expect(bar).toContain("more actions");
    expect(bar).toContain("session chip filters");
    expect(bar).toContain("topic chip filters");
    expect(bar).toContain("model chip names the model");
  });
  it("the (i) legend tooltip shows on click/tap: the CSS rule covers hover, focus and .on", async () => {
    const { readFileSync } = await import("node:fs");
    const cssSrc = readFileSync("src/router/cockpit-page/css.ts", "utf8");
    expect(cssSrc).toContain(".wq-i:hover .wq-tip,.wq-i:focus-visible .wq-tip,.wq-i.on .wq-tip{display:block}");
    // the page script toggles .on on click (touch screens have no hover)
    const { WIN_WORKERS_JS } = await import("./cockpit-page/win/cards-workers.js");
    expect(WIN_WORKERS_JS).toContain('closest(".wq-i")');
    expect(WIN_WORKERS_JS).toContain('classList.add("on")');
  });
  it("queue view filters by the chosen sessions and sorts by session then position", async () => {
    const vm = await import("node:vm");
    const { WIN_WORKERS_JS } = await import("./cockpit-page/win/cards-workers.js");
    const ctx = vm.createContext({});
    vm.runInContext(`function esc(s){return String(s==null?"":s)}\n` + WIN_WORKERS_JS, ctx);
    const mk = (id: string, session: string, state = "waiting") => ({ slot: 1, kind: "job", id, state, stateText: "", priority: "normal", session, model: "gyro-l", local: true, task: id, seconds: 5, activity: "", now: "", detail: "", actions: [] });
    (ctx as Record<string, unknown>).__rows = [mk("a1", "zeta"), mk("b1", "alpha"), mk("a2", "zeta"), mk("b2", "alpha"), mk("c1", "mid")];
    const ids = (e: string) => (vm.runInContext(`(${e}).map(function(r){return r.id}).join(",")`, ctx) as string);
    expect(ids("wkView(__rows)")).toBe("a1,b1,a2,b2,c1");
    vm.runInContext('WK_FILTERS=["alpha","mid"]', ctx);
    expect(ids("wkView(__rows)")).toBe("b1,b2,c1");
    expect(vm.runInContext("wkBar({table:__rows})", ctx)).toContain("showing 3 of 5");
    vm.runInContext('WK_FILTERS=[];WK_SORT={col:"session",dir:"asc"}', ctx);
    expect(ids("wkView(__rows)")).toBe("b1,b2,c1,a1,a2");
    const html = vm.runInContext("wkQTable(wkView(__rows))", ctx) as string;
    expect(html).toContain('<tr class="wq-g"><td colspan="7">alpha</td></tr>');
    expect(html).toContain("▲");
    vm.runInContext("WK_SORT=null", ctx);
    expect(vm.runInContext("wkQTable(wkView(__rows))", ctx)).toContain(">waiting</td>");
  });
  it("models card: a managed endpoint of a carded model is nested, not a second row; the card says 1 instance healthy", async () => {
    const vm = await import("node:vm");
    const { WIN_MODELS_JS } = await import("./cockpit-page/win/cards-models.js");
    const ctx = vm.createContext({ Win: { registerType() {} } });
    vm.runInContext(`function esc(s){return String(s==null?"":s)}\nfunction shortModel(s){return s}\nfunction gbm(s){return s}\nfunction gb(s){return s}\nfunction pct(s){return s}\n` + WIN_MODELS_JS, ctx);
    (ctx as Record<string, unknown>).__inv = { runtimes: [{ name: "gyro-l", kind: "strata", tier: "gyro-l", models: [], status: "up" }], tiers: [{ tier: "gyro-l", maxInstances: 2 }], instances: [{ id: "gyro-l#1", model: "gyro-l", state: "ready", inflight: 0 }], registryModels: [], consumers: [], runtimeCommands: {} };
    vm.runInContext("WMD={inv:__inv}", ctx);
    expect(vm.runInContext('wmdNested({id:"gyro-l#1",origin:"managed",model:"gyro-l",provider:"gyro-l"})', ctx)).toBe(true);
    expect(vm.runInContext('wmdNested({id:"x",origin:"registered",model:"gyro-l",provider:"gyro-l"})', ctx)).toBe(false);
    expect(vm.runInContext('wmdNested({id:"o#1",origin:"managed",model:"other",provider:"other"})', ctx)).toBe(false);
    expect(vm.runInContext("wmdInstText(wmdCards(__inv)[0].tier)", ctx)).toBe("1 instance · healthy");
  });
  it("model is a coloured chip and destructive actions confirm inline", async () => {
    const vm = await import("node:vm");
    const { WIN_WORKERS_JS } = await import("./cockpit-page/win/cards-workers.js");
    const ctx = vm.createContext({ setTimeout, clearTimeout });
    vm.runInContext(`function esc(s){return String(s==null?"":s)}\n` + WIN_WORKERS_JS, ctx);
    expect(vm.runInContext('wkModelHue({local:false,model:"cloud: opus"})!==wkModelHue({local:false,model:"cloud: sonnet"})', ctx)).toBe(true);
    expect(vm.runInContext('wkArm("x:to-cloud","to-cloud",function(){})', ctx)).toBe(false);
    expect(vm.runInContext('wkArm("x:to-cloud","to-cloud",function(){})', ctx)).toBe(true);
    expect(vm.runInContext('wkArm("x:pause","pause",function(){})', ctx)).toBe(true);
    vm.runInContext("clearTimeout(WK_CT)", ctx);
  });
  it("queue table colgroup leaves the task column the free width", async () => {
    const vm = await import("node:vm");
    const { WIN_WORKERS_JS } = await import("./cockpit-page/win/cards-workers.js");
    const { readFileSync } = await import("node:fs");
    const cssSrc = readFileSync("src/router/cockpit-page/css.ts", "utf8");
    const ctx = vm.createContext({});
    vm.runInContext(`function esc(s){return String(s==null?"":s)}\n` + WIN_WORKERS_JS, ctx);
    // the short id and the eye ride inside the clipped task cell: the table never widens
    expect(cssSrc).toContain(".wq-tc{position:relative}");
    const html = vm.runInContext("wkQTable([])", ctx) as string;
    const cols = [...html.matchAll(/<col(?!group)([^>]*)>/g)].map((m) => m[1]!);
    expect(cols).toHaveLength(7);
    expect(cols[2]).toMatch(/width:\d+%/);
    cols.forEach((c, i) => {
      if (i !== 2) expect(c).toMatch(/width:\d+px/);
    });
  });
  it("the spec? marker has a real tooltip: the guard's count and the first conflicting reason, shortened", async () => {
    const { denialMark, specMarkTip } = await import("../workers/denials.js");
    const s = {
      denialCount: 3,
      denials: [
        { at: "2026-11-18T21:52:00Z", tool: "Bash", hook: "ztk", input: "git push", reason: "Never push from a worker session; the operator merges. Never push from a worker session; the operator merges.", specConflict: true },
        { at: "2026-11-18T21:53:00Z", tool: "Write", hook: "hook", input: "/x", reason: "path outside worktree", specConflict: false },
      ],
    };
    expect(denialMark(s)).toBe("denied 3 spec?");
    const tip = specMarkTip(s);
    expect(tip.startsWith("the guard blocked this job 3 times; the block may contradict its brief: Never push from a worker session")).toBe(true);
    expect(tip).toContain("operator merges");
    expect(tip.length).toBeLessThanOrEqual("the guard blocked this job 3 times; the block may contradict its brief: ".length + 160);
    // no spec conflict = no marker, no tip
    expect(specMarkTip({ denialCount: 2, denials: [{ at: "x", tool: "Bash", hook: "h", input: "", reason: "r", specConflict: false }] })).toBe("");
    expect(specMarkTip({})).toBe("");
  });
  it("queue model column is a short name", async () => {
    const { shortModel } = await import("../workers/queue-table.js");
    expect(shortModel(true, "gyro-l", "gyro-l/qwen3.8-flash-next-gyro-l")).toBe("gyro-l");
    expect(shortModel(false, "anthropic", "claude-sonnet-5-5")).toBe("cloud: sonnet");
  });
  it("queue row: level badge, child mark, cloud marker, narrow columns and chip hues", async () => {
    const vm = await import("node:vm");
    const { WIN_WORKERS_JS } = await import("./cockpit-page/win/cards-workers.js");
    const { cockpitHtml } = await import("./cockpit-page.js");
    const ctx = vm.createContext({});
    vm.runInContext(`function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}\n` + WIN_WORKERS_JS, ctx);
    const mk = (id: string, o: object) => ({ slot: "running", kind: "job", id, sid: id, state: "running", stateText: "running", priority: "normal", session: "PAI", model: "cloud: opus", modelFull: "cloud: anthropic claude-opus", local: false, level: 2, task: "t " + id, seconds: 5, activity: "", now: "", detail: "", actions: ["pause"], ...o });
    (ctx as Record<string, unknown>).__t = [mk("o", { level: 1, cloudWhy: "class orchestrate runs on the cloud" }), mk("k", { parent: "o", cloudWhy: "moved by operator" })];
    vm.runInContext("WQ={table:__t}", ctx);
    const o = vm.runInContext("wkTRow(WQ.table[0])", ctx) as string;
    const k = vm.runInContext("wkTRow(WQ.table[1])", ctx) as string;
    expect(o).toContain("L1 coordinates: splits the work, starts L2 workers, checks their results");
    expect(o).not.toContain("wq-kid");
    expect(k).toContain("L2 does the work");
    expect(k).toContain("wq-kid");
    expect(o).toContain("class orchestrate runs on the cloud");
    expect(o).toContain("↑ cloud: opus");
    expect(k).toContain("moved by operator");
    expect(k).toContain("priority: normal");
    // palette: 12 hues; visible sessions never share one
    (ctx as Record<string, unknown>).__n = Array.from({ length: 12 }, (_, i) => "sess" + i);
    const hues = vm.runInContext("wkAssign(__n);__n.map(wkSessHue)", ctx) as number[];
    expect(new Set(hues).size).toBe(12);
    // narrow screens: columns hide, never tiles
    const page = cockpitHtml();
    expect(page).toMatch(/@media\(max-width:900px\)\{table\.wq\{min-width:0\}[^}]*nth-child\(5\)/);
    expect(page).toMatch(/@media\(max-width:760px\)\{table\.wq col:nth-child\(4\)/);
  });
});
