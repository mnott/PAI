/**
 * B8a-client: one `model` card per registry model (models.model:<name>), n / max from the instances of the entry's file,
 * and the registry-backups card filling when it mounts after being minimized. Node only: the card code runs against a
 * fake Win; no fetch, no model server is ever touched.
 */

import { describe, expect, it } from "vitest";
import { WIN_MODELS_JS } from "./cockpit-page/win/cards-models.js";
import { WIN_REGISTRY_JS } from "./cockpit-page/win/cards-registry.js";

type Ctx = { id: string; body: { innerHTML: string; addEventListener: () => void }; slots: Record<string, string>; st: string[]; html: (k: string, h: string) => void; list: (k: string, items: any[], key: Function, mk: Function, fill: Function) => void; status: (k: string, t: string) => void };
type Type = { mount: (c: Ctx) => void; update: (c: Ctx, d: any) => void };

function ctxFor(id: string): Ctx {
  const c: Ctx = {
    id, body: { innerHTML: "", addEventListener() {} }, slots: {}, st: [],
    html(k, h) { c.slots[k] = h; },
    list(k, items, key, mk, fill) { c.slots[k] = items.map((i) => { const d: any = mk(); fill(d, i); return d.innerHTML; }).join("|"); },
    status(k, t) { c.st.push(`${k}:${t}`); },
  };
  return c;
}
const STUBS = `var TYPES={};var Win={registerType:function(n,d){TYPES[n]=d},el:function(){return null},ctx:function(){return null},update:function(){},addCards:function(){return true}};
var WinT={leaf:function(){},split:function(){}};var WinA={};function winHost(){return null}var WIN_HOST=null;var BLUR_CANCEL_MS=1;
function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;")}function gbm(m){return m}function gb(m){return m}function pct(v){return v}function shortModel(m){return m}
var document={createElement:function(){return{className:"",innerHTML:""}}};`;

function models() {
  return new Function(`${STUBS}\n${WIN_MODELS_JS}\nreturn{TYPES:TYPES,WMD_SET:function(inv){WMD={inv:inv}},wmdModelActs:wmdModelActs,wmdCards:wmdCards,wmdModel:wmdModel};`)() as {
    TYPES: Record<string, Type>; WMD_SET: (i: any) => void; wmdModelActs: (id: string) => any[]; wmdCards: (i: any) => any[]; wmdModel: (id: string) => any;
  };
}

const reg = (name: string, file: string, ids: string[], max = 4) => ({
  name, file, engine: "strata", port: 8035, tier: name, state: ids.length ? "running" : "stopped",
  instances: ids.map((id, i) => ({ id, pid: 10 + i, port: 8035 + i, inflight: 0 })), maxInstances: max,
});
const inv = (registryModels: any[]) => ({ registryModels, runtimes: [], consumers: [], instances: [], tiers: [] });

function render(m: ReturnType<typeof models>, i: any, name: string) {
  m.WMD_SET(i);
  const c = ctxFor(`models.model:${name}`);
  m.TYPES.model!.mount(c);
  m.TYPES.model!.update(c, i);
  return c;
}

describe("B8a model cards", () => {
  it("a stopped model renders its header badges and an enabled Start", () => {
    const m = models();
    const i = inv([reg("iq3s", "/s/iq3_s.json", [])]);
    const c = render(m, i, "iq3s");
    expect(c.slots.badges).toContain("stopped");
    expect(c.slots.badges).toContain("0 / 4");
    const acts = m.wmdModelActs("models.model:iq3s");
    expect((acts.find((a) => a.id === "start")!.enabled as () => unknown)()).toBe(true);
    expect((acts.find((a) => a.id === "stop")!.enabled as () => unknown)()).toBe("nothing running");
  });

  it("the tier card labels instances and requests (in flight / provider maxConcurrent)", () => {
    const m = models();
    const r = { ...reg("gyro-m", "/s/gyro.json", ["gyro-m#1"]), maxConcurrent: 5 };
    const b = render(m, inv([r]), "gyro-m").slots.badges;
    expect(b).toContain("instances 1 / 4");
    expect(b).toContain("requests 0 / 5");
    expect(render(m, inv([reg("gyro-m", "/s/gyro.json", ["gyro-m#1"])]), "gyro-m").slots.badges).toContain("requests 0<");
  });

  it("two instances of different files mark one card each, n / max from the entry's own instances", () => {
    const m = models();
    const i = inv([reg("gyro-m", "/s/gyro.json", ["gyro-m#1", "gyro-m#2"]), reg("iq3s", "/s/iq3.json", ["iq3s#1"]), reg("coder-next", "/s/c.sh", [], 1)]);
    expect(render(m, i, "gyro-m").slots.badges).toContain("2 / 4");
    expect(render(m, i, "iq3s").slots.badges).toContain("1 / 4");
    const g = render(m, i, "gyro-m");
    expect(g.slots.inst).toContain("gyro-m#1");
    expect(g.slots.inst).not.toContain("iq3s#1");
    expect(render(m, i, "coder-next").slots.badges).toContain("0 / 1");
    expect((m.wmdModelActs("models.model:gyro-m").find((a) => a.id === "more")!.enabled as () => unknown)()).toBe(true);
  });

  it("a runtime card of a registry tier is not listed twice", () => {
    const m = models();
    const rt = { name: "strata", kind: "strata", port: 8035, status: "running", tier: "gyro-m", users: [], models: [{ model: "x", kind: "coding", loaded: true, usedBy: [] }] };
    const small = { name: "ollama", kind: "ollama", port: 11434, status: "running", users: ["pai-embedding"], models: [{ model: "arctic", kind: "embedding", loaded: false, usedBy: ["pai-embedding"] }] };
    const base = { ...inv([reg("gyro-m", "/s/g.json", ["gyro-m#1"])]), runtimes: [rt, small], tiers: [{ tier: "gyro-m", maxInstances: 4 }] };
    expect(m.wmdCards(base).map((e) => e.r.name)).toEqual(["ollama"]);
    expect(m.wmdCards({ ...base, registryModels: [] }).map((e) => e.r.name)).toEqual(["strata", "ollama"]);
  });
});

describe("registry-backups card minimized at load", () => {
  it("fills at mount from the loaded backups", () => {
    const f = new Function(`${STUBS}\n${WIN_REGISTRY_JS}\nreturn{TYPES:TYPES,WRG:WRG};`)() as { TYPES: Record<string, Type>; WRG: any };
    f.WRG.backups = [{ name: "workers.yaml.20260101-000000.bak", size: 300, mtime: 1, summary: "+1 -0 lines" }];
    const c = ctxFor("settings.registry-backups");
    f.TYPES.backups!.mount(c);
    expect(c.slots.l).toContain("20260101-000000");
    expect(c.slots.l).toContain("restore");
  });
});

// ---- C1 restored guards: the runtime card (the page's own helpers, a fake Win/WinA) ----
import { COCKPIT_HTML } from "./cockpit-page.js";
import { fnSrc, varSrc } from "./cockpit-page-src.js";

function rtLib() {
  const posts: { verb: string; args: any }[] = [];
  const labels: { id: string; verb: string; args: any }[] = [];
  const slot: any = { firstChild: null, appendChild(x: any) { slot.firstChild = x; x.parentNode = slot; }, removeChild(x: any) { slot.firstChild = null; x.parentNode = null; } };
  const btn = { dataset: {} };
  const inputs: any[] = [];
  const src = `var TYPES={};var Win={registerType:function(n,d){TYPES[n]=d},el:function(){return{querySelector:function(q){return q.indexOf("data-act")>=0?H.btn:H.slot}}},ctx:function(){return null},update:function(){},addCards:function(){return true}};
var WinT={leaf:function(){},split:function(){}};function winHost(){return null}var WMDX=null;
var WinA={winClick:function(b,id,verb,args){H.posts.push({verb:verb,args:args})},runAction:function(id,verb,args){H.labels.push({id:id,verb:verb,args:args});return Promise.resolve({ok:true})}};
var document={createElement:function(){var i={listeners:{},value:"",setAttribute:function(){},focus:function(){},addEventListener:function(k,f){i.listeners[k]=f}};H.inputs.push(i);return i}};
${varSrc(COCKPIT_HTML, "BLUR_CANCEL_MS")}
${["esc", "gb", "gbm", "shortModel", "pct"].map((n) => fnSrc(COCKPIT_HTML, n)).join("\n")}`;
  const H = { posts, labels, slot, btn, inputs };
  const api = new Function("H", `${src}\n${WIN_MODELS_JS}\nreturn{TYPES:TYPES,WMD_SET:function(inv){WMD={inv:inv}},wmdActs:wmdActs,wmdCards:wmdCards};`)(H) as {
    TYPES: Record<string, Type>; WMD_SET: (i: any) => void; wmdActs: (id: string) => any[]; wmdCards: (i: any) => any[];
  };
  return { ...H, ...api };
}
const rtInv = (extra: Record<string, unknown> = {}) => ({
  tiers: [], instances: [], registryModels: [], live: { runtimes: [],
  }, runtimeCommands: { "vllm-big": { start: "start vllm" }, ollama: { stop: "stop ollama" } },
  consumers: [
    { name: "agent-a", runtime: "ollama", model: "qwen3:8b" },
    { name: "agent-b", runtime: "ollama", model: "llama3:8b" },
    { name: "pai-embedding", runtime: "ollama", model: "nomic-embed-text:latest" },
    { name: "agent-c", runtime: "vllm-big", model: "big" },
  ],
  runtimes: [
    { name: "ollama", kind: "ollama", port: 11434, status: "running", users: [], models: [
      { model: "qwen3:8b", kind: "chat", loaded: true, memoryMb: 5000, usedBy: ["agent-a"] },
      { model: "llama3:8b", kind: "chat", loaded: false, usedBy: ["agent-b"] },
      { model: "nomic-embed-text", kind: "embedding", loaded: false, usedBy: [] }] },
    { name: "vllm-big", kind: "vllm", port: 8000, status: "stopped", users: [], models: [{ model: "big", kind: "chat", loaded: false, usedBy: ["agent-c"] }] },
  ],
  ...extra,
});

describe("C1 guards: runtime cards", () => {
  // w=2 model alias: the pencil opens an input; Enter posts model.label target=<runtime> value=model:<id>=<alias>; Escape posts nothing.
  it("the alias editor posts model.label on Enter and nothing on Escape", async () => {
    const m = rtLib(), inv = rtInv();
    m.WMD_SET(inv);
    const id = "models.rt:ollama/qwen3:8b";
    const alias = m.wmdActs(id).find((a) => a.id === "alias")!;
    expect(alias.enabled()).toBe(true);
    alias.run();
    expect(m.slot.firstChild).toBe(m.inputs[0]);
    m.inputs[0].value = "  Fast ";
    m.inputs[0].listeners.keydown({ key: "Enter", preventDefault() {}, stopPropagation() {} });
    expect(m.labels).toEqual([{ id, verb: "model.label", args: { target: "ollama", value: "model:qwen3:8b=Fast" } }]);
    expect(m.slot.firstChild).toBeNull();
    alias.run();
    m.inputs[1].listeners.keydown({ key: "Escape", stopPropagation() {} });
    expect(m.labels.length).toBe(1);
    expect(m.slot.firstChild).toBeNull();
  });

  // w=3 runtime card content: one card per consumer model, down/idle/slow wording, kind chip, applicable start/stop, stop confirm with requests in flight.
  it("a runtime splits into one card per consumer model and says what is down, idle or slow", () => {
    const m = rtLib(), inv = rtInv();
    m.WMD_SET(inv);
    const cards = m.wmdCards(inv);
    expect(cards.map((c) => c.id)).toEqual(["models.rt:ollama/qwen3:8b", "models.rt:ollama/llama3:8b", "models.rt:ollama/nomic-embed-text", "models.rt:vllm-big/big"]);
    const embed = cards[2]!;
    expect(embed.users).toEqual(["pai-embedding"]); // the :latest consumer finds the plain model
    const paint = (c: any) => {
      const ctx = ctxFor(c.id);
      m.TYPES.runtime!.mount(ctx);
      m.TYPES.runtime!.update(ctx, inv);
      return ctx.slots;
    };
    const q = paint(cards[0]), l = paint(cards[1]), d = paint(cards[3]);
    expect(q.badges).toContain("running");
    const slowInv = rtInv();
    (slowInv.runtimes[0] as { slow?: boolean }).slow = true; // a slow probe reads amber "slow"
    m.WMD_SET(slowInv);
    const sctx = ctxFor(cards[0]!.id);
    m.TYPES.runtime!.mount(sctx);
    m.TYPES.runtime!.update(sctx, slowInv);
    expect(sctx.slots.badges).toContain('badge mstate warn">slow<');
    expect(q.badges).not.toContain(">ollama</span>"); // kind chip hidden when kind == name
    expect(d.badges).toContain(">vllm</span>");
    expect(l.badges).toContain("available (loads on first request)");
    expect(d.badges).toContain("down");
    expect(d.note).toBe("vllm-big :8000 down — agent-c cannot work");
    m.WMD_SET(inv);
    const act = (id: string, a: string) => m.wmdActs(id).find((x) => x.id === a)!.enabled();
    expect(act("models.rt:vllm-big/big", "start")).toBe(true);
    expect(act("models.rt:vllm-big/big", "stop")).toBe("not running");
    expect(act("models.rt:ollama/qwen3:8b", "start")).toBe("already running");
    expect(act("models.rt:ollama/qwen3:8b", "stop")).toBe(true);
  });

  it("stopping a runtime that has requests in flight posts value=confirm, an idle one posts none", () => {
    const m = rtLib();
    const inv = (inflight: number) => rtInv({
      tiers: [{ tier: "gyro-m", maxInstances: 2 }], instances: [{ id: "gyro-m-1", model: "gyro-m", state: "ready", port: 8101, inflight }],
      consumers: [], runtimes: [{ name: "strata", kind: "strata", port: 8101, status: "running", tier: "gyro-m", users: ["worker:local"], models: [{ model: "g.gguf", kind: "chat", loaded: true, usedBy: [] }] }],
    });
    for (const [n, want] of [[2, "confirm"], [0, undefined]] as const) {
      m.posts.length = 0;
      m.WMD_SET(inv(n));
      m.wmdActs("models.rt:strata/g.gguf").find((a) => a.id === "stop")!.run();
      expect(m.posts).toEqual([{ verb: "local.stop", args: { target: "gyro-m", value: want } }]);
    }
  });

  // w=3b Speed / Memory / Conversation-cache cells and the context fill: binary GB with one decimal, decode/prefill text, fill bar from live/last tokens over max context.
  it("the cells show decode, prefill, GB, the conversation cache and the context fill", () => {
    const m = rtLib();
    const inv = rtInv({
      live: { runtimes: [{ name: "ollama", live: { rssMb: 20480, engine: { decode: 41.26, prefill: 812.4, phase: "generating", gpuMemUsed: 115964116992, parked: 3, slots: 8, reusedPct: 62, maxContext: 32768, liveUsed: 8192 } } }] },
    });
    m.WMD_SET(inv);
    const c = m.wmdCards(inv)[0]!, ctx = ctxFor(c.id);
    m.TYPES.runtime!.mount(ctx);
    m.TYPES.runtime!.update(ctx, inv);
    expect(ctx.slots.cells).toContain("41.3");
    expect(ctx.slots.cells).toContain("t/s");
    expect(ctx.slots.cells).toContain("generating · decode · prefill 812 t/s");
    expect(ctx.slots.cells).toContain("20.0"); // 20480 MB
    expect(ctx.slots.cells).toContain("GPU 108.0"); // 115964116992 bytes
    expect(ctx.slots.cells).toContain("Conversation cache");
    expect(ctx.slots.cells).toContain('<b class="wmdv">3</b><small class="wm-u">/ 8</small>');
    expect(ctx.slots.cells).toContain("reused 62.0% of prompt tokens");
    expect(ctx.slots.ctx).toContain("width:25.0%");
    expect(ctx.slots.ctx).toContain("context 25% · 8.2k / 32K");
    const gb = new Function(`${fnSrc(COCKPIT_HTML, "gb")}\nreturn gb;`)() as (b: number, d?: number) => string;
    expect(gb(115964116992, 0)).toBe("108");
    expect(gb(1.53e9)).toBe("1.4");
  });
});
