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
  it("queue row renders as one line with at most three action buttons", async () => {
    const vm = await import("node:vm");
    const { WIN_WORKERS_JS } = await import("./cockpit-page/win/cards-workers.js");
    const ctx = vm.createContext({});
    vm.runInContext(`function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}\n` + WIN_WORKERS_JS, ctx);
    const row = { slot: 1, kind: "job", id: "w1", state: "waiting", stateText: "waiting for a local slot", priority: "normal", session: "mdf", model: "gyro-l", modelFull: "local: qwen", local: true, task: "a very long task text ".repeat(20), seconds: 70, activity: "", now: "", detail: "", stale: true, actions: ["next", "up", "down", "pause", "freeze", "deep-freeze", "to-cloud", "prio-low", "prio-normal", "prio-high", "prio-now"] };
    (ctx as Record<string, unknown>).__r = row;
    const html = vm.runInContext("wkTRow(__r)", ctx) as string;
    expect(html.match(/<tr/g)).toHaveLength(1);
    expect(html).not.toContain("<br");
    expect((html.match(/<button/g) ?? []).length - (html.match(/class="wq-chip/g) ?? []).length).toBeLessThanOrEqual(3);
    expect(html).toContain("waiting #1");
    expect(html).toContain("stale waiter");
    expect(html).toContain('title="a very long task');
    expect(html).toContain("aria-label=");
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
    const ctx = vm.createContext({});
    vm.runInContext(`function esc(s){return String(s==null?"":s)}\n` + WIN_WORKERS_JS, ctx);
    const html = vm.runInContext("wkQTable([])", ctx) as string;
    const cols = [...html.matchAll(/<col(?!group)([^>]*)>/g)].map((m) => m[1]!);
    expect(cols).toHaveLength(7);
    expect(cols[2]).toMatch(/width:\d+%/);
    cols.forEach((c, i) => {
      if (i !== 2) expect(c).toMatch(/width:\d+px/);
    });
  });
  it("queue model column is a short name", async () => {
    const { shortModel } = await import("../workers/queue-table.js");
    expect(shortModel(true, "gyro-l", "gyro-l/qwen3.8-flash-next-gyro-l")).toBe("gyro-l");
    expect(shortModel(false, "anthropic", "claude-sonnet-5-5")).toBe("cloud: sonnet");
  });
});
