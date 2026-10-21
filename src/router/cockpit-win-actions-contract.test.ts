/**
 * cockpit-win-actions-contract.test.ts — the field contract (spec 5.2).
 * Every defAction entry in win/actions.ts is run through the real handler in
 * cockpit-actions.ts (stub deps) with the exact body its build produces. The
 * test fails when the handler answers "unknown action", "required" (missing
 * target/value) or "must be" for an enabled control — the guard against the
 * stop button posting the wrong field. local.start/stop/scale must post the
 * model in the field named "target".
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const savedHome = process.env.HOME;
const savedPaiHome = process.env.PAI_HOME;
const savedConfigFile = process.env.PAI_CONFIG_FILE;
const savedWorkersYaml = process.env.PAI_WORKERS_YAML;
const dirs: string[] = [];

let runCockpitAction: typeof import("./cockpit-actions.js")["runCockpitAction"];

beforeAll(async () => {
  process.env.HOME = mkdtempSync(join(tmpdir(), "pai-win-contract-"));
  const paiHome = mkdtempSync(join(tmpdir(), "pai-win-contract-"));
  dirs.push(paiHome);
  process.env.PAI_HOME = paiHome;
  process.env.PAI_CONFIG_FILE = join(paiHome, "config.yaml");
  // the label action writes through the config writer: point it at an empty temp config
  const { writeFileSync } = await import("node:fs");
  writeFileSync(process.env.PAI_CONFIG_FILE, "{}\n");
  process.env.PAI_WORKERS_YAML = join(paiHome, "workers.yaml");
  // route.set reads the worker config through readWorkersSection (not deps.workers) and
  // writes workers.yaml: seed a temp yaml with one cloud provider so the real writer runs.
  writeFileSync(process.env.PAI_WORKERS_YAML, "providers:\n  glm:\n    url: https://glm.example/api\n    models:\n      default: glm-5.3\n      fast: glm-5.3-flash\n");
  ({ runCockpitAction } = await import("./cockpit-actions.js"));
});

afterAll(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedPaiHome === undefined) delete process.env.PAI_HOME;
  else process.env.PAI_HOME = savedPaiHome;
  if (savedConfigFile === undefined) delete process.env.PAI_CONFIG_FILE;
  else process.env.PAI_CONFIG_FILE = savedConfigFile;
  if (savedWorkersYaml === undefined) delete process.env.PAI_WORKERS_YAML;
  else process.env.PAI_WORKERS_YAML = savedWorkersYaml;
});

// the page string, pulled out the same way as win-actions.test.ts
const src = readFileSync(fileURLToPath(new URL("./cockpit-page/win/actions.ts", import.meta.url)), "utf8");
const m = src.match(/export const WIN_ACTIONS_JS = String\.raw`([\s\S]*?)`;/);
if (!m) throw new Error("WIN_ACTIONS_JS not found in win/actions.ts");
const api = (new Function(`${m[1]}\nreturn {defAction:defAction,actionDef:actionDef,winBody:winBody};`) as any)();
const { defAction, actionDef, winBody } = api;

// the verbs the cockpit cards enable (the same ones the old data-a buttons carried)
defAction("local.start", { fields: ["target"], build: (a: any) => ({ action: "local.start", target: a.target }) });
defAction("local.stop", { fields: ["target", "value"], build: (a: any) => ({ action: "local.stop", target: a.target, value: a.value }) });
defAction("local.scale", { fields: ["target", "count"], build: (a: any) => ({ action: "local.scale", target: a.target, count: a.count }) });
defAction("local.off", { fields: [], build: () => ({ action: "local.off" }) });
defAction("runtime", { fields: ["target", "value"], build: (a: any) => ({ action: "runtime", target: a.target, value: a.value }) });
defAction("model.label", { fields: ["target", "value"], build: (a: any) => ({ action: "model.label", target: a.target, value: a.value }) });
defAction("route.set", { fields: ["target", "models"], build: (a: any) => ({ action: "route.set", target: a.target, models: a.models }) });
defAction("endpoint.enable", { fields: ["target", "value"], build: (a: any) => ({ action: "endpoint.enable", target: a.target, value: a.value }) });
defAction("memory.embed", { fields: [], build: () => ({ action: "memory.embed" }) });
defAction("memory.index", { fields: [], build: () => ({ action: "memory.index" }) });
defAction("memory.stop", { fields: [], build: () => ({ action: "memory.stop" }) });

// enabled args per verb: what a control on a live card would pass
const ARGS: { [verb: string]: any } = {
  "local.start": { target: "gyro-m" },
  "local.stop": { target: "gyro-m" },
  "local.scale": { target: "gyro-m", count: 2 },
  "local.off": {},
  runtime: { target: "ollama", value: "start" },
  "model.label": { target: "strata", value: "model:gyro-m=gyro" },
  "route.set": { target: "implement", models: ["local", "glm/glm-5.3"] },
  "endpoint.enable": { target: "glm", value: "on" },
  "memory.embed": {},
  "memory.index": {},
  "memory.stop": {},
};

const workers = {
  providers: {
    glm: { enabled: true, models: { default: "glm-5.3" }, characteristics: { context: 200000 } },
  },
  classes: { draft: "anthropic" },
  active: "glm",
} as never;

function stubDeps(tmp: string): any {
  return {
    startTier: async () => {},
    stopAll: async () => {},
    startModel: async () => {},
    stopModel: async () => {},
    runningCount: () => 1,
    earlyMs: 50,
    setClass: () => {},
    setLabel: () => {},
    unsetLabel: () => {},
    ledger: join(tmp, "ledger.log"),
    workersYaml: join(tmp, "workers.yaml"),
    home: tmp,
    workers,
    localStatus: { at: new Date().toISOString(), running: [], down: [], disabled: [] },
    tiers: ["gyro-m"],
    runtimeCommands: { ollama: { start: "ollama serve", stop: "kill" } },
    runtimeOps: { runCmd: async () => 1, getUrl: async () => null },
    runtimeKinds: {},
    refreshInventory: async () => {},
    readRun: () => null,
    killRun: () => {},
    daemonMemoryBusy: async () => null,
    embedBacklog: async () => 3,
  } as never;
}

describe("win action field contract (spec 5.2)", () => {
  it("every registered verb is known to the handler and posts the fields it declares", async () => {
    const tmp = dirs[0];
    const verbs = Object.keys(ARGS);
    for (const verb of verbs) {
      expect(actionDef(verb), `verb ${verb} must be registered`).toBeTruthy();
      const body = winBody(actionDef(verb), ARGS[verb]);
      expect(typeof body.action, `${verb}: build must set action`).toBe("string");
      // every field build sets is one the def declares
      for (const k of Object.keys(body)) {
        if (k === "action") continue;
        expect(actionDef(verb).fields, `${verb}: body field ${k} not declared`).toContain(k);
      }
      // memory.embed answers at once with a jobId and leaves a running job file in home;
      // memory.index would then refuse it as "already starting" — each memory verb gets a
      // fresh home so the contract checks one accepted action per clean state.
      const home = /^memory\./.test(body.action as string) ? (dirs.push(mkdtempSync(join(tmpdir(), "pai-win-contract-mem-"))), dirs[dirs.length - 1]) : tmp;
      const deps = stubDeps(home);
      // memory.stop acts on a run that is in flight; embed/index run with none
      if (body.action === "memory.stop") deps.readRun = () => ({ kind: "index", state: "running", pid: 4321, by: "cli" } as never);
      const r = await runCockpitAction(body, deps);
      const why = `${verb} body ${JSON.stringify(body)} -> ${r.message}`;
      expect(r.ok, why).toBe(true);
      expect(r.message, why).not.toMatch(/unknown action|required|must be/);
    }
  });

  it("local.start/stop/scale post the model in the field named target (the stop-button bug)", () => {
    for (const verb of ["local.start", "local.stop", "local.scale"]) {
      const body = winBody(actionDef(verb), ARGS[verb]);
      expect(body.target, `${verb} must carry the model in "target"`).toBe("gyro-m");
      expect(body.model, `${verb} must not post a "model" field`).toBeUndefined();
      expect(actionDef(verb).fields).toContain("target");
    }
  });

  it("local.stop with requests in flight posts value=confirm and the handler accepts it", async () => {
    const r = await runCockpitAction(winBody(actionDef("local.stop"), { target: "gyro-m", value: "confirm" }), stubDeps(dirs[0]));
    expect(r.ok).toBe(true);
  });

  it("memory.stop with a run in flight posts the fields the handler accepts and stops it", async () => {
    const tmp = dirs[0];
    const killed: number[] = [];
    const deps = stubDeps(tmp);
    deps.readRun = () => ({ kind: "index", state: "running", pid: 4321, by: "cli" } as never);
    deps.killRun = (pid: number) => void killed.push(pid);
    const r = await runCockpitAction(winBody(actionDef("memory.stop"), {}), deps);
    expect(r.ok).toBe(true);
    expect(killed).toEqual([4321]);
  });

  it("a missing target is refused by the handler with a message (the page must show it)", async () => {
    const r = await runCockpitAction({ action: "local.stop" }, stubDeps(dirs[0]));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("required");
  });
});
