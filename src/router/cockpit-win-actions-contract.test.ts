/**
 * cockpit-win-actions-contract.test.ts — the field contract (spec 5.2).
 * Every entry of WIN_VERBS — the ONE production table in win/actions.ts, not a
 * hand-written copy — is run through the real runner runCockpitAction in
 * cockpit-actions.ts (stub deps) with the exact body its build produces. The
 * test fails when the handler answers "unknown action", "required" (missing
 * target/value) or "must be" for an enabled control — the guard against the
 * stop button posting the wrong field. local.start/stop/scale must post the
 * model in the field named "target". Queue verbs (route set) are checked
 * against the real queue handler in cockpit.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import http from "node:http";
import type { AddressInfo } from "node:net";

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
const api = (new Function(`${m[1]}\nreturn {defAction:defAction,actionDef:actionDef,winBody:winBody,runAction:runAction,WIN_VERBS:WIN_VERBS};`) as any)();
const { actionDef, winBody, runAction, WIN_VERBS } = api;

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
  "queue.next": { id: "w1" },
  "queue.up": { id: "w1" },
  "queue.front": { id: "w1" },
  "queue.move": { id: "w1", position: 2 },
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
  it("every WIN_VERBS entry is registered and known to the handler, and posts the fields it declares", async () => {
    const tmp = dirs[0];
    const verbs = Object.keys(WIN_VERBS);
    expect(verbs.length).toBeGreaterThanOrEqual(11);
    for (const verb of verbs) {
      // the table IS the registry: defAction ran over it at load
      expect(actionDef(verb), `verb ${verb} must be registered from WIN_VERBS`).toBe(WIN_VERBS[verb]);
      expect(ARGS[verb], `verb ${verb} needs enabled args in this test`).toBeTruthy();
      if (WIN_VERBS[verb].route) continue; // queue verbs run against the real queue handler below
      const body = winBody(WIN_VERBS[verb], ARGS[verb]);
      expect(typeof body.action, `${verb}: build must set action`).toBe("string");
      // every field build sets is one the def declares
      for (const k of Object.keys(body)) {
        if (k === "action") continue;
        expect(WIN_VERBS[verb].fields, `${verb}: body field ${k} not declared`).toContain(k);
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

  it("D1: every WIN_VERBS entry runs through the REAL runner (runCockpitAction) with no refusal", async () => {
    const tmp = dirs[0];
    for (const verb of Object.keys(WIN_VERBS)) {
      if (WIN_VERBS[verb].route) continue; // queue verbs: the next test
      // memory verbs need a clean home each (see above)
      const home = /^memory\./.test(WIN_VERBS[verb].build(ARGS[verb]).action) ? (dirs.push(mkdtempSync(join(tmpdir(), "pai-win-contract-run-"))), dirs[dirs.length - 1]) : tmp;
      const deps = stubDeps(home);
      if (verb === "memory.stop") deps.readRun = () => ({ kind: "index", state: "running", pid: 4321, by: "cli" } as never);
      const statuses: [string, string, string][] = [];
      // the handler answers at once; a jobId means the runner polls /cockpit/job, whose
      // contract is win-actions.test.ts — the fake answers the poll as done so the run ends
      const posted: any[] = [];
      const host = {
        fetch: async (url: string, opts: any) => {
          // a jobId means the runner would poll /cockpit/job (JOB_POLL under real timers):
          // refuse it at once so this test stays synchronous — the poll itself is
          // win-actions.test.ts's contract
          if (url.startsWith("/cockpit/job")) return { status: 404, text: async () => JSON.stringify({ error: "no such job" }) };
          const body = JSON.parse(opts.body);
          posted.push(body);
          const r = await runCockpitAction(body, deps);
          return { status: 200, text: async () => JSON.stringify(r) };
        },
        setStatus: (id: string, kind: string, text: string) => void statuses.push([id, kind, text]),
        setBusy: () => {},
        refresh: () => {},
      };
      // pollMs=1: the job poll settles at once, the test stays synchronous
      const r = await runAction("card", verb, ARGS[verb], null, host, { pollMs: 1 });
      const why = `${verb} body ${JSON.stringify(posted[0])} -> ${r.message}`;
      expect(posted.length, `${verb}: the runner must POST the action once`).toBe(1);
      // the handler accepted the body: ok at once, or accepted as a job (the runner then
      // polls /cockpit/job, refused here on purpose — the poll is win-actions.test.ts)
      expect(r.ok || r.message === "no such job", why).toBe(true);
      expect(r.message, why).not.toMatch(/unknown action|required|must be/);
      expect(statuses[0], `${verb}: pending first`).toEqual(["card", "pending", `${verb} ...`]);
      // a plain reply lands ok; a jobId reply ends "no such job" — either way the refusal
      // text shown is never a field refusal
      const last = statuses[statuses.length - 1];
      expect(["ok", "err"], `${verb}: final status shown`).toContain(last[1]);
      expect(last[2], `${verb}: status text`).not.toMatch(/unknown action|required|must be|no answer/);
    }
  });

  it("D4: queue verbs post to their route and the real queue handler accepts the body", async () => {
    const { handleCockpit } = await import("./cockpit.js");
    const { alive } = await import("../workers/status.js");
    const logDir = mkdtempSync(join(tmpdir(), "pai-win-contract-q-"));
    dirs.push(logDir);
    // the real queue format: queue/<provider>/<id> holding "<pid> [front] <rank> @<since>",
    // alive only for our own process; the status file names the provider
    mkdirSync(join(logDir, "queue", "glm"), { recursive: true });
    const pid = process.pid;
    const since = Date.now();
    writeFileSync(join(logDir, "queue", "glm", "w1"), `${pid} 0 @${since}`);
    writeFileSync(join(logDir, "queue", "glm", "w2"), `${pid} 1 @${since}`);
    writeFileSync(join(logDir, "w1.status"), JSON.stringify({ id: "w1", provider: "glm", state: "queued", pid }));
    writeFileSync(join(logDir, "w2.status"), JSON.stringify({ id: "w2", provider: "glm", state: "queued", pid }));
    expect(alive(pid)).toBe(true);
    const srv = http.createServer((req, res) => {
      if (!handleCockpit(req, res, { get: async () => [] } as never, () => [], () => new Map(), undefined, () => [], () => null as never, async () => null as never, () => logDir)) res.end("other");
    });
    async function ask(path: string, body: string) {
      if (!srv.listening) await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
      const port = (srv.address() as AddressInfo).port;
      return new Promise<{ status: number; body: string }>((resolve) => {
        const rq = http.request({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json" } }, (res) => {
          let b = "";
          res.on("data", (c) => (b += c));
          res.on("end", () => resolve({ status: res.statusCode!, body: b }));
        });
        rq.write(body);
        rq.end();
      });
    }
    try {
      for (const verb of ["queue.next", "queue.up", "queue.front", "queue.move"]) {
        const def = WIN_VERBS[verb];
        expect(def.route, `${verb} must carry its route`).toBe(`/cockpit/queue/${verb.split(".")[1]}`);
        const body = winBody(def, ARGS[verb]);
        const r = await ask(def.route, JSON.stringify(body));
        const j = JSON.parse(r.body);
        const why = `${verb} body ${JSON.stringify(body)} -> ${r.status} ${r.body}`;
        expect(r.status, why).toBe(200);
        expect(j.error, why).toBeUndefined();
        expect(j.id, why).toBe("w1");
        expect(Array.isArray(j.order), why).toBe(true);
      }
    } finally {
      srv.close();
    }
  });

  it("local.start/stop/scale post the model in the field named target (the stop-button bug)", () => {
    for (const verb of ["local.start", "local.stop", "local.scale"]) {
      const body = winBody(WIN_VERBS[verb], ARGS[verb]);
      expect(body.target, `${verb} must carry the model in "target"`).toBe("gyro-m");
      expect(body.model, `${verb} must not post a "model" field`).toBeUndefined();
      expect(WIN_VERBS[verb].fields).toContain("target");
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
