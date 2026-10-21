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
