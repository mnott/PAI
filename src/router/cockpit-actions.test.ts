/**
 * cockpit-actions.test.ts — the /cockpit/action endpoint. Every case runs
 * against a temp PAI_HOME/config.yaml via PAI_CONFIG_FILE (set before
 * daemon/config.ts is first imported, since CONFIG_FILE resolves once at
 * module load) — never the live config.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

const savedHome = process.env.HOME;
const savedPaiHome = process.env.PAI_HOME;
const savedConfigFile = process.env.PAI_CONFIG_FILE;
const savedWorkersYaml = process.env.PAI_WORKERS_YAML;
const dirs: string[] = [];
function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), "pai-cockpit-act-"));
  dirs.push(d);
  return d;
}

let paiHome: string;
let parseLedger: typeof import("../workers/ledger.js")["parseLedger"];
let handleCockpit: typeof import("./cockpit.js")["handleCockpit"];
let sameOriginAction: typeof import("./cockpit.js")["sameOriginAction"];
let setActionHooks: typeof import("./cockpit.js")["setActionHooks"];
let runCockpitAction: typeof import("./cockpit-actions.js")["runCockpitAction"];
let readCockpitJob: typeof import("./cockpit-actions.js")["readCockpitJob"];
let labelPath: typeof import("./cockpit-actions.js")["labelPath"];
let classesOnProvider: typeof import("./cockpit-actions.js")["classesOnProvider"];
let runningLocalModel: typeof import("./cockpit-actions.js")["runningLocalModel"];
let cockpitJobFile: typeof import("./cockpit-actions.js")["cockpitJobFile"];
let setConfigValueOp: typeof import("../config/main-config-ops.js")["setConfigValueOp"];
let unsetConfigValueOp: typeof import("../config/main-config-ops.js")["unsetConfigValueOp"];
let readModelLabels: typeof import("../workers/model-inventory.js")["readModelLabels"];
let modelLabel: typeof import("../workers/model-inventory.js")["modelLabel"];

beforeAll(async () => {
  process.env.HOME = newDir();
  paiHome = newDir();
  process.env.PAI_HOME = paiHome;
  process.env.PAI_CONFIG_FILE = join(paiHome, "config.yaml");
  writeFileSync(process.env.PAI_CONFIG_FILE, "{}\n");
  process.env.PAI_WORKERS_YAML = join(paiHome, "workers.yaml");
  ({ parseLedger } = await import("../workers/ledger.js"));
  ({ handleCockpit, sameOriginAction, setActionHooks } = await import("./cockpit.js"));
  ({ runCockpitAction, readCockpitJob, labelPath, classesOnProvider, runningLocalModel, cockpitJobFile } = await import("./cockpit-actions.js"));
  ({ setConfigValueOp, unsetConfigValueOp } = await import("../config/main-config-ops.js"));
  ({ readModelLabels, modelLabel } = await import("../workers/model-inventory.js"));
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

const workers = {
  providers: { glm: { enabled: true, models: { default: "glm-5.3" } }, local30: { enabled: true, models: { default: "qwen" } } },
  classes: { draft: "anthropic", implement: "glm/fast" },
  active: "glm",
} as never;

function testDeps(tmp: string, calls: Record<string, string[]>, failJob = false) {
  return {
    startTier: async (t: string) => {
      calls.startTier!.push(t);
      if (failJob) throw new Error("server exited");
    },
    stopAll: async () => void calls.stopAll!.push("off"),
    setClass: (cls: string, target: string) => void calls.setClass!.push(`${cls}=${target}`),
    setLabel: (path: string, value: string) => void calls.setLabel!.push(`${path}=${value}`),
    unsetLabel: (path: string) => void calls.unsetLabel!.push(path),
    ledger: join(tmp, "ledger.log"),
    workersYaml: join(tmp, "workers.yaml"),
    home: tmp,
    workers,
    localStatus: { at: new Date().toISOString(), running: [{ provider: "local30", model: "qwen3-coder", why: "" }], down: [], disabled: [] },
    tiers: ["small", "big"],
    runtimeCommands: { ollama: { start: "ollama serve", stop: "kill", ready: "http://127.0.0.1:11434/api/tags" } },
    refreshInventory: async (rt: string) => void calls.refresh?.push(rt),
  } as never;
}
const emptyCalls = () => ({ startTier: [] as string[], stopAll: [] as string[], setClass: [] as string[], setLabel: [] as string[], unsetLabel: [] as string[], runtime: [] as string[], refresh: [] as string[] });

describe("cockpit actions", () => {
  it("local.switch answers at once with a job id, runs the code path, writes the ledger", async () => {
    const tmp = newDir();
    const calls = emptyCalls();
    const r = await runCockpitAction({ action: "local.switch", target: "big" }, testDeps(tmp, calls));
    expect(r.ok).toBe(true);
    expect(r.jobId).toBeTruthy();
    await new Promise((res) => setTimeout(res, 50));
    expect(calls.startTier).toEqual(["big"]);
    expect(readCockpitJob(tmp, r.jobId!)!.state).toBe("done");
    const lines = parseLedger(readFileSync(join(tmp, "ledger.log"), "utf8"));
    expect(
      lines.some((l) => l.event === "COCKPIT-ACTION" && l.fields.who === "cockpit" && l.fields.action === "local.switch" && l.fields.target === "big" && /done/.test(l.fields.result ?? ""))
    ).toBe(true);
  });

  it("worker.priority / worker.pause / worker.resume write the worker's status and the ledger, and refuse bad input", async () => {
    const tmp = newDir();
    const { saveStatus, loadStatus } = await import("../workers/status.js");
    saveStatus(tmp, { id: "w9", pid: process.pid, label: "x", cwd: "/", term: "", provider: "gyro-m", model: "m", state: "running", started: "2026-01-01 00:00:00", updated: "", turns: 0, tools: 0, last: "", rc: null, secs: null } as never);
    const deps = testDeps(tmp, emptyCalls());
    expect((await runCockpitAction({ action: "worker.priority", target: "w9", value: "low" }, deps)).ok).toBe(true);
    expect((await runCockpitAction({ action: "worker.pause", target: "w9" }, deps)).message).toMatch(/paused/);
    expect(loadStatus(tmp, "w9")).toMatchObject({ priority: "low", paused: true });
    expect((await runCockpitAction({ action: "worker.resume", target: "w9" }, deps)).message).toMatch(/resumed/);
    expect(loadStatus(tmp, "w9")!.paused).toBe(false);
    expect((await runCockpitAction({ action: "worker.priority", target: "w9", value: "urgent" }, deps)).ok).toBe(false);
    expect((await runCockpitAction({ action: "worker.pause", target: "ghost" }, deps)).ok).toBe(false);
    expect((await runCockpitAction({ action: "worker.pause" }, deps)).ok).toBe(false);
    const events = parseLedger(readFileSync(join(tmp, "ledger.log"), "utf8")).map((l) => l.event);
    expect(events).toEqual(expect.arrayContaining(["WORKER-PRIORITY", "WORKER-PAUSE", "WORKER-RESUME", "COCKPIT-ACTION"]));
  });

  it("the cockpit routing section is read-only: there is no route action", async () => {
    const tmp = newDir();
    const r = await runCockpitAction({ action: "route", class: "implement", models: ["anthropic/opus"] }, testDeps(tmp, emptyCalls()));
    expect(r.ok).toBe(false);
  });

  it("local.switch on an unknown tier refuses and still writes the ledger", async () => {
    const tmp = newDir();
    const calls = emptyCalls();
    const r = await runCockpitAction({ action: "local.switch", target: "nope" }, testDeps(tmp, calls));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('no tier "nope"');
    expect(calls.startTier).toEqual([]);
    expect(readFileSync(join(tmp, "ledger.log"), "utf8")).toContain("error:");
  });

  it("a failing local job marks the job failed and the ledger records it", async () => {
    const tmp = newDir();
    const calls = emptyCalls();
    const r = await runCockpitAction({ action: "local.switch", target: "big" }, testDeps(tmp, calls, true));
    await new Promise((res) => setTimeout(res, 50));
    expect(readCockpitJob(tmp, r.jobId!)!.state).toBe("failed");
    expect(readFileSync(join(tmp, "ledger.log"), "utf8")).toContain("failed:_server_exited");
  });

  function instDeps(tmp: string, calls: Record<string, string[]>, have: number, refuse = "") {
    return {
      ...(testDeps(tmp, calls) as object),
      startModel: async (m: string) => {
        if (refuse) throw new Error(refuse);
        calls.start!.push(m);
      },
      stopModel: async (t: string, o: object) => void calls.stop!.push(`${t}:${JSON.stringify(o)}`),
      runningCount: () => have,
    } as never;
  }
  const instCalls = () => ({ ...emptyCalls(), start: [] as string[], stop: [] as string[] });

  it("local.start starts one instance; a memory refusal comes back as ok:false", async () => {
    const tmp = newDir();
    const calls = instCalls();
    const r = await runCockpitAction({ action: "local.start", target: "big" }, instDeps(tmp, calls, 0));
    expect(r.ok).toBe(true);
    await new Promise((res) => setTimeout(res, 50));
    expect(calls.start).toEqual(["big"]);
    expect(readCockpitJob(tmp, r.jobId!)!.state).toBe("done");
    const no = await runCockpitAction({ action: "local.start", target: "big" }, instDeps(tmp, instCalls(), 0, "needs 40 GB, 8 free"));
    expect(no).toEqual({ ok: false, message: "needs 40 GB, 8 free" });
    expect((await runCockpitAction({ action: "local.start", target: "nope" }, instDeps(tmp, calls, 0))).ok).toBe(false);
  });

  it("local.stop passes the target and the confirm flag", async () => {
    const tmp = newDir();
    const calls = instCalls();
    await runCockpitAction({ action: "local.stop", target: "big#2" }, instDeps(tmp, calls, 2));
    await runCockpitAction({ action: "local.stop", target: "big", value: "confirm" }, instDeps(tmp, calls, 2));
    await new Promise((res) => setTimeout(res, 50));
    expect(calls.stop).toEqual(['big#2:{"confirm":false}','big:{"confirm":true}']);
  });

  it("local.stop routes one instance id alone, and all:true to every instance of the model", async () => {
    const tmp = newDir();
    const calls = instCalls();
    await runCockpitAction({ action: "local.stop", target: "big#2" }, instDeps(tmp, calls, 2));
    await runCockpitAction({ action: "local.stop", target: "big", all: true, value: "confirm" }, instDeps(tmp, calls, 2));
    await new Promise((res) => setTimeout(res, 50));
    expect(calls.stop).toEqual(['big#2:{"confirm":false}', 'big:{"confirm":true,"all":true}']);
  });

  it("a provider name from the Local servers card resolves to its model for stop, start and scale", async () => {
    const tmp = newDir();
    writeFileSync(join(tmp, "workers.yaml"), "providers:\n  pbig:\n    url: http://127.0.0.1:8035\nlocal_tiers:\n  big:\n    engine: script\n    provider: pbig\n    start: /x.sh\n    port: 8035\n");
    const calls = instCalls();
    await runCockpitAction({ action: "local.stop", target: "pbig" }, instDeps(tmp, calls, 1));
    await runCockpitAction({ action: "local.start", target: "pbig" }, instDeps(tmp, calls, 0));
    await new Promise((res) => setTimeout(res, 50));
    expect(calls.stop).toEqual(['big:{"confirm":false}']);
    expect(calls.start).toEqual(["big"]);
  });

  it("local.scale starts the missing instances or stops the extras", async () => {
    const tmp = newDir();
    const up = instCalls();
    await runCockpitAction({ action: "local.scale", target: "big", value: "3" }, instDeps(tmp, up, 1));
    await new Promise((res) => setTimeout(res, 50));
    expect(up.start).toEqual(["big", "big"]);
    const down = instCalls();
    await runCockpitAction({ action: "local.scale", target: "big", count: 1 }, instDeps(tmp, down, 3));
    await new Promise((res) => setTimeout(res, 50));
    expect(down.stop).toEqual(['big:{"count":2}']);
    expect((await runCockpitAction({ action: "local.scale", target: "big", value: "x" }, instDeps(tmp, down, 3))).ok).toBe(false);
  });

  it("local.off runs stopAll", async () => {
    const tmp = newDir();
    const calls = emptyCalls();
    const r = await runCockpitAction({ action: "local.off" }, testDeps(tmp, calls));
    await new Promise((res) => setTimeout(res, 50));
    expect(calls.stopAll).toEqual(["off"]);
    expect(readCockpitJob(tmp, r.jobId!)!.state).toBe("done");
  });

  it("model.label writes through the config writer; empty label removes (temp config)", async () => {
    const tmp = newDir();
    const calls = emptyCalls();
    const d = testDeps(tmp, calls);
    expect(labelPath("ollama")).toBe("models.labels.ollama");
    expect(labelPath("ollama", "qwen3:8b")).toBe("models.labels.ollama");
    // the real writer, on the temp config
    const base = testDeps(tmp, calls) as Record<string, unknown>;
    const real = { ...base, setLabel: (p: string, v: string, o?: { force?: boolean }) => void setConfigValueOp(p, v, o), unsetLabel: (p: string) => void unsetConfigValueOp(p) } as never;
    const r = await runCockpitAction({ action: "model.label", target: "ollama", value: "coding drafts" }, real);
    expect(r.ok).toBe(true);
    expect(readModelLabels()).toEqual({ ollama: "coding drafts" });
    expect(modelLabel(readModelLabels(), "ollama")).toBe("coding drafts");
    expect(readFileSync(join(tmp, "ledger.log"), "utf8")).toContain("set:coding_drafts");
    const r2 = await runCockpitAction({ action: "model.label", target: "ollama", value: "" }, real);
    expect(r2.ok).toBe(true);
    expect(readModelLabels()).toEqual({});
    // a model-level label nests under the runtime block
    const r3 = await runCockpitAction({ action: "model.label", target: "ollama", value: "model:qwen3:8b" }, real);
    expect(r3.ok).toBe(true); // no label text: removes the model label (no-op here)
    // the mocked writer records the path it was given
    await runCockpitAction({ action: "model.label", target: "ollama", value: "model:qwen3:8b=cheap drafts" }, d);
    expect(calls.setLabel).toEqual(['models.labels.ollama={"qwen3:8b":"cheap drafts"}']);
  });

  it("a runtime label is always a string ('7', 'true', '[wip]' stay text); __proto__ targets are refused", async () => {
    const tmp = newDir();
    const base = testDeps(tmp, emptyCalls()) as Record<string, unknown>;
    const real = { ...base, setLabel: (p: string, v: string, o?: { force?: boolean; asString?: boolean }) => void setConfigValueOp(p, v, o), unsetLabel: (p: string) => void unsetConfigValueOp(p) } as never;
    for (const [rt, label] of [["a", "7"], ["b", "true"], ["c", "[wip]"]] as const) {
      expect((await runCockpitAction({ action: "model.label", target: rt, value: label }, real)).ok).toBe(true);
    }
    expect(readModelLabels()).toEqual({ a: "7", b: "true", c: "[wip]" });
    const bad = await runCockpitAction({ action: "model.label", target: "__proto__.polluted", value: "x" }, real);
    expect(bad.ok).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    for (const rt of ["a", "b", "c"]) await runCockpitAction({ action: "model.label", target: rt, value: "" }, real);
    expect(readModelLabels()).toEqual({});
  });

  it("model labels round-trip for ids with : / . (stored as one map, not nested keys); removing the last one drops the block", async () => {
    const tmp = newDir();
    const calls = emptyCalls();
    const base = testDeps(tmp, calls) as Record<string, unknown>;
    const real = { ...base, setLabel: (p: string, v: string, o?: { force?: boolean }) => void setConfigValueOp(p, v, o), unsetLabel: (p: string) => void unsetConfigValueOp(p) } as never;
    const ids = ["qwen3:8b", "huggingface.co/org/name", "llama3.1:70b-q4_K_M"];
    for (const id of ids) {
      const r = await runCockpitAction({ action: "model.label", target: "ollama", value: `model:${id}=alias of ${id}` }, real);
      expect(r.ok).toBe(true);
    }
    const labels = readModelLabels();
    expect(labels).toEqual({ ollama: Object.fromEntries(ids.map((id) => [id, `alias of ${id}`])) });
    for (const id of ids) expect(modelLabel(labels, "ollama", id)).toBe(`alias of ${id}`);
    // removing one keeps the others
    await runCockpitAction({ action: "model.label", target: "ollama", value: "model:qwen3:8b=" }, real);
    expect(modelLabel(readModelLabels(), "ollama", "qwen3:8b")).toBe("");
    expect(modelLabel(readModelLabels(), "ollama", "huggingface.co/org/name")).toBe("alias of huggingface.co/org/name");
    for (const id of ids.slice(1)) await runCockpitAction({ action: "model.label", target: "ollama", value: `model:${id}=` }, real);
    expect(readModelLabels()).toEqual({});
  });

  it("cloud.role worker maps every class through setClass; bad role and unknown provider refuse", async () => {
    const tmp = newDir();
    const calls = emptyCalls();
    const r = await runCockpitAction({ action: "cloud.role", target: "glm", value: "worker" }, testDeps(tmp, calls));
    expect(r.ok).toBe(true);
    expect(calls.setClass).toEqual(["draft=glm", "plan=glm", "implement=glm", "review=glm", "research=glm", "spotcheck=glm", "simple=glm", "complex=glm", "image=glm"]);
    expect(readFileSync(join(tmp, "ledger.log"), "utf8")).toContain("role=worker");
    const bad = await runCockpitAction({ action: "cloud.role", target: "glm", value: "boss" }, testDeps(tmp, calls));
    expect(bad.ok).toBe(false);
    const unknown = await runCockpitAction({ action: "cloud.role", target: "nobody", value: "worker" }, testDeps(tmp, calls));
    expect(unknown.ok).toBe(false);
  });

  it("runtime start runs the configured command through the runner, writes RUNTIME-START and the job file", async () => {
    const tmp = newDir();
    const calls = emptyCalls();
    const d = testDeps(tmp, calls) as Record<string, unknown>;
    const real = {
      ...d,
      runtimeOps: {
        runShell: async (cmd: string) => { calls.runtime!.push(cmd); return { code: 0 }; },
        spawnDetached: (cmd: string) => { calls.runtime!.push(cmd); return { exit: new Promise<{ code: number | null }>(() => {}) }; },
        // down at the duplicate guard, up once the command ran
        getUrl: async () => calls.runtime!.length > 0,
        runCmd: async () => 0,
        now: () => 0,
        sleep: async () => undefined,
      },
    } as never;
    const r = await runCockpitAction({ action: "runtime", target: "ollama", value: "start" }, real);
    expect(r.ok).toBe(true);
    expect(r.jobId).toBeTruthy();
    await new Promise((res) => setTimeout(res, 50));
    expect(calls.runtime).toEqual(["ollama serve"]);
    expect(readCockpitJob(tmp, r.jobId!)!.state).toBe("done");
    expect(readCockpitJob(tmp, r.jobId!)!.runtime).toBe("ollama");
    const lines = parseLedger(readFileSync(join(tmp, "ledger.log"), "utf8"));
    expect(lines.some((l) => l.event === "RUNTIME-START" && l.fields.runtime === "ollama" && l.fields.result === "ok")).toBe(true);
    expect(lines.some((l) => l.event === "COCKPIT-ACTION" && l.fields.action === "runtime" && l.fields.target === "ollama:start")).toBe(true);
  });

  it("the default action deps' home is the PAI home resolver's absolute path, never a literal ~", async () => {
    const { defaultDeps } = await import("./cockpit-actions.js");
    const { paiHomeDir } = await import("../config/pai-home.js");
    const home = defaultDeps().home;
    expect(home).toBe(paiHomeDir());
    expect(isAbsolute(home)).toBe(true);
    expect(home).not.toContain("~");
  });

  it("a failed runtime start ends its job failed with the runner's message", async () => {
    const tmp = newDir();
    const calls = emptyCalls();
    const real = {
      ...(testDeps(tmp, calls) as Record<string, unknown>),
      runtimeOps: { runShell: async () => ({ code: 0 }), spawnDetached: () => ({ exit: Promise.resolve({ code: 7 }) }), getUrl: async () => false, runCmd: async () => 1, now: () => 0, sleep: async () => undefined },
      runtimeCommands: { srv: { start: "serve", ready: "http://127.0.0.1:1/h" } },
    } as never;
    const r = await runCockpitAction({ action: "runtime", target: "srv", value: "start" }, real);
    await new Promise((res) => setTimeout(res, 50));
    const job = readCockpitJob(tmp, r.jobId!)!;
    expect(job.state).toBe("failed");
    expect(job.message).toContain("exited (7)");
  });

  it("runtime stop on a configured runtime runs its stop command; an unconfigured runtime or op refuses", async () => {
    const tmp = newDir();
    const calls = emptyCalls();
    const real = {
      ...(testDeps(tmp, calls) as Record<string, unknown>),
      runtimeOps: { runShell: async (cmd: string) => { calls.runtime!.push(cmd); return { code: 0 }; }, spawnDetached: () => ({ exit: new Promise<{ code: number | null }>(() => {}) }), getUrl: async () => true, runCmd: async () => 0, now: () => 0, sleep: async () => undefined },
    } as never;
    const r = await runCockpitAction({ action: "runtime", target: "ollama", value: "stop" }, real);
    expect(r.ok).toBe(true);
    await new Promise((res) => setTimeout(res, 50));
    expect(calls.runtime).toEqual(["kill"]);
    expect(parseLedger(readFileSync(join(tmp, "ledger.log"), "utf8")).some((l) => l.event === "RUNTIME-STOP")).toBe(true);
    // no commands configured at all: refuse, nothing runs
    const none = await runCockpitAction({ action: "runtime", target: "strata-box", value: "start" }, { ...(testDeps(tmp, calls) as Record<string, unknown>), runtimeCommands: {} } as never);
    expect(none.ok).toBe(false);
    expect(none.message).toContain("no start command configured for strata-box");
    expect(calls.runtime).toEqual(["kill"]);
    // a runtime configured for start only: stop refuses
    const stopOnly = await runCockpitAction({ action: "runtime", target: "ollama", value: "stop" }, { ...(testDeps(tmp, calls) as Record<string, unknown>), runtimeCommands: { ollama: { start: "ollama serve" } } } as never);
    expect(stopOnly.ok).toBe(false);
    const badOp = await runCockpitAction({ action: "runtime", target: "ollama", value: "restart" }, real);
    expect(badOp.ok).toBe(false);
  });

  it("a double-clicked runtime stop starts once: the second call is refused while the first is in setup", async () => {
    const tmp = newDir();
    const calls = emptyCalls();
    const real = {
      ...(testDeps(tmp, calls) as Record<string, unknown>),
      runtimeOps: { runShell: async (cmd: string) => { calls.runtime!.push(cmd); return { code: 0 }; }, spawnDetached: () => ({ exit: new Promise<{ code: number | null }>(() => {}) }), getUrl: async () => true, runCmd: async () => 0, now: () => 0, sleep: async () => undefined },
    } as never;
    const [a, b] = await Promise.all([
      runCockpitAction({ action: "runtime", target: "ollama", value: "stop" }, real),
      runCockpitAction({ action: "runtime", target: "ollama", value: "stop" }, real),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    await new Promise((res) => setTimeout(res, 50));
    expect(calls.runtime).toEqual(["kill"]);
    // the claim is released: a later call is judged by the usual checks again
    const later = await runCockpitAction({ action: "runtime", target: "ollama", value: "stop" }, real);
    expect(later.message).not.toContain("already being set up");
  });

  it("unknown actions refuse", async () => {
    const tmp = newDir();
    const r = await runCockpitAction({ action: "wat" }, testDeps(tmp, emptyCalls()));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('unknown action "wat"');
  });

  it("role helpers: classes on a provider, the running model for the confirm text", () => {
    expect(classesOnProvider(workers, "glm")).toEqual(["implement"]);
    expect(classesOnProvider(workers, "other")).toEqual([]);
    expect(runningLocalModel({ at: "x", running: [{ provider: "local30", model: "qwen3-coder", why: "" }], down: [], disabled: [] })).toBe("local30 (qwen3-coder)");
    expect(runningLocalModel({ at: "x", running: [], down: [], disabled: [] })).toBeNull();
    expect(cockpitJobFile("/h", "abc")).toBe("/h/cockpit-jobs/abc.json");
    expect(readCockpitJob("/h", "../escape")).toBeNull();
  });
});

describe("cockpit action endpoint", () => {
  const limits = { get: async () => [] as never[] };
  function serve(tmp: string, calls: Record<string, string[]>) {
    setActionHooks({ runLocalJob: async (kind: string, tier: string) => void calls.startTier!.push(`${kind}:${tier}`) }, testDeps(tmp, calls));
    return http.createServer((req, res) => {
      if (!handleCockpit(req, res, limits as never, () => [], () => new Map())) res.end("other");
    });
  }
  async function ask(srv: http.Server, path: string, method: string, body?: string, headers: Record<string, string> = {}) {
    if (!srv.listening) await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    return new Promise<{ status: number; body: string }>((resolve) => {
      const rq = http.request({ host: "127.0.0.1", port, path, method, headers: body ? { "content-type": "application/json", ...headers } : headers }, (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve({ status: res.statusCode!, body: b }));
      });
      if (body) rq.write(body);
      rq.end();
    });
  }

  it("POST /cockpit/action runs an action and answers {ok,message}", async () => {
    const tmp = newDir();
    const calls = emptyCalls();
    const srv = serve(tmp, calls);
    try {
      const r = await ask(srv, "/cockpit/action", "POST", JSON.stringify({ action: "model.label", target: "ollama", value: "drafts" }));
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body)).toMatchObject({ ok: true });
      expect(calls.setLabel).toEqual(["models.labels.ollama=drafts"]);
      expect(readFileSync(join(tmp, "ledger.log"), "utf8")).toContain("who=cockpit");
      const bad = await ask(srv, "/cockpit/action", "POST", JSON.stringify({ action: "nope" }));
      expect(JSON.parse(bad.body).ok).toBe(false);
    } finally {
      srv.close();
      setActionHooks({});
    }
  });

  it("a cross-origin POST is refused (Origin mismatch, Sec-Fetch-Site)", async () => {
    const tmp = newDir();
    const calls = emptyCalls();
    const srv = serve(tmp, calls);
    try {
      const r = await ask(srv, "/cockpit/action", "POST", JSON.stringify({ action: "local.off" }), { origin: "http://evil.example" });
      expect(r.status).toBe(403);
      expect(calls.stopAll).toEqual([]);
      const r2 = await ask(srv, "/cockpit/action", "POST", JSON.stringify({ action: "local.off" }), { "sec-fetch-site": "cross-site" });
      expect(r2.status).toBe(403);
      const host = (srv.address() as AddressInfo).port;
      const ok = await ask(srv, "/cockpit/action", "POST", JSON.stringify({ action: "local.off" }), { origin: `http://127.0.0.1:${host}` });
      expect(ok.status).toBe(200);
    } finally {
      srv.close();
      setActionHooks({});
    }
  });

  it("DNS rebinding (Host and Origin both the attacker name) is refused on every cockpit POST", async () => {
    const tmp = newDir();
    const calls = emptyCalls();
    const srv = serve(tmp, calls);
    try {
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
      const port = (srv.address() as AddressInfo).port;
      const rebound = { host: `evil.example:${port}`, origin: `http://evil.example:${port}` };
      for (const path of ["/cockpit/action", "/cockpit/registry/save", "/cockpit/queue/next", "/cockpit/layout-default"]) {
        const r = await ask(srv, path, "POST", JSON.stringify({ action: "local.off", id: "x" }), rebound);
        expect([path, r.status]).toEqual([path, 403]);
        // right name, wrong port
        const p = await ask(srv, path, "POST", "{}", { host: "127.0.0.1:1" });
        expect([path, p.status]).toEqual([path, 403]);
        // cross-origin against the loopback host
        const o = await ask(srv, path, "POST", "{}", { origin: "https://evil.example" });
        expect([path, o.status]).toEqual([path, 403]);
      }
      expect(calls.stopAll).toEqual([]);
      const ok = await ask(srv, "/cockpit/action", "POST", JSON.stringify({ action: "local.off" }), { origin: `http://127.0.0.1:${port}` });
      expect(ok.status).toBe(200);
    } finally {
      srv.close();
      setActionHooks({});
    }
  });

  it("POST /cockpit/providers/<name>/concurrency steps maxConcurrent by one inside the layout bounds and refuses cross-origin", async () => {
    const tmp = newDir();
    const srv = serve(tmp, emptyCalls());
    try {
      const { writeWorkersYamlText, starterWorkersYamlText } = await import("../workers/workers-config.js");
      const { addProvider, setProviderCap } = await import("../workers/providers.js");
      const { readWorkersSection } = await import("../workers/config.js");
      writeWorkersYamlText(process.env.PAI_WORKERS_YAML!, starterWorkersYamlText());
      addProvider({ name: "capped", baseUrl: "http://127.0.0.1:8123", model: "m" });
      addProvider({ name: "uncapped", baseUrl: "https://uncapped.example.com", model: "m" });
      setProviderCap("capped", 2);
      const post = (name: string, body: unknown, headers: Record<string, string> = {}) => ask(srv, `/cockpit/providers/${name}/concurrency`, "POST", JSON.stringify(body), headers);
      const cap = () => readWorkersSection().workers.providers.capped!.maxConcurrent;

      expect((await post("%zz", { delta: 1 })).status).toBe(400);

      const up = await post("capped", { delta: 1 });
      expect(up.status).toBe(200);
      expect(JSON.parse(up.body)).toMatchObject({ ok: true, provider: "capped", maxConcurrent: 3, min: 1, max: 16 });
      expect(cap()).toBe(3);
      expect(JSON.parse((await post("capped", { delta: -1 })).body).maxConcurrent).toBe(2);
      expect(cap()).toBe(2);

      // bounds: 1 stays 1, 16 stays 16
      setProviderCap("capped", 1);
      expect(JSON.parse((await post("capped", { delta: -1 })).body)).toMatchObject({ maxConcurrent: 1, clamped: true });
      expect(cap()).toBe(1);
      setProviderCap("capped", 16);
      expect(JSON.parse((await post("capped", { delta: 1 })).body)).toMatchObject({ maxConcurrent: 16, clamped: true });
      expect(cap()).toBe(16);
      // above max (a hand-edited config): "+" leaves it alone (clamped:true), "-" steps down by one
      const yamlPath = process.env.PAI_WORKERS_YAML!;
      const setCap = (v: number) => writeWorkersYamlText(yamlPath, readFileSync(yamlPath, "utf8").replace(/maxConcurrent: \d+/, `maxConcurrent: ${v}`));
      setCap(20);
      expect(cap()).toBe(20);
      expect(JSON.parse((await post("capped", { delta: 1 })).body)).toMatchObject({ maxConcurrent: 20, clamped: true });
      expect(cap()).toBe(20);
      expect(JSON.parse((await post("capped", { delta: -1 })).body)).toMatchObject({ maxConcurrent: 19, clamped: false });
      expect(cap()).toBe(19);
      setCap(2);

      // bad input, unknown / uncapped provider
      expect((await post("capped", { delta: 5 })).status).toBe(400);
      expect((await post("capped", {})).status).toBe(400);
      expect((await post("nope", { delta: 1 })).status).toBe(404);
      expect((await post("uncapped", { delta: 1 })).status).toBe(404);

      // content-type: only application/json; a form or text/plain POST is refused, nothing written
      const form = await ask(srv, "/cockpit/providers/capped/concurrency", "POST", JSON.stringify({ delta: 1 }), { "content-type": "application/x-www-form-urlencoded" });
      expect(form.status).toBe(415);
      expect(cap()).toBe(2);
      // no content-type at all is refused too
      const noCt = await ask(srv, "/cockpit/providers/capped/concurrency", "POST", JSON.stringify({ delta: 1 }), { "content-type": "" });
      expect(noCt.status).toBe(415);
      expect(cap()).toBe(2);

      // cross-origin and rebinding: refused, nothing written
      expect((await post("capped", { delta: 1 }, { origin: "https://evil.example" })).status).toBe(403);
      expect((await post("capped", { delta: 1 }, { host: "evil.example:1", origin: "http://evil.example:1" })).status).toBe(403);
      expect(cap()).toBe(2);
    } finally {
      srv.close();
      setActionHooks({});
    }
  });

  it("sameOriginAction: no Origin passes (curl), matching Origin passes, mismatch refuses", () => {
    const h = (o: Record<string, string>) => ({ headers: o, method: "POST" }) as never;
    expect(sameOriginAction(h({ host: "127.0.0.1:8790" }))).toBe(true);
    expect(sameOriginAction(h({ host: "127.0.0.1:8790", origin: "http://127.0.0.1:8790" }))).toBe(true);
    expect(sameOriginAction(h({ host: "127.0.0.1:8790", origin: "http://evil.example" }))).toBe(false);
    expect(sameOriginAction(h({ host: "127.0.0.1:8790", "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(sameOriginAction(h({ host: "127.0.0.1:8790", "sec-fetch-site": "same-origin" }))).toBe(true);
  });

  it("the token gate covers /cockpit/action (wrapper 401s before the handler)", async () => {
    const { withCockpitToken } = await import("./cockpit-auth.js");
    const wrapped = withCockpitToken("sekret", (() => {
      throw new Error("handler must not run without the token");
    }) as never);
    let status = 0;
    const res = { writeHead: (s: number) => (status = s), end: () => undefined, setHeader: () => undefined } as never;
    wrapped({ url: "/cockpit/action", method: "POST", headers: {} } as never, res);
    expect(status).toBe(401);
  });

  it("GET /cockpit/job answers 404 for an unknown job", async () => {
    const tmp = newDir();
    const srv = serve(tmp, emptyCalls());
    try {
      expect((await ask(srv, "/cockpit/job?id=none", "GET")).status).toBe(404);
      expect((await ask(srv, "/cockpit/job?id=../x", "GET")).status).toBe(404);
    } finally {
      srv.close();
      setActionHooks({});
    }
  });

  it("the page renders the action rows and no alert/confirm/prompt", async () => {
    const tmp = newDir();
    const srv = serve(tmp, emptyCalls());
    try {
      const page = await ask(srv, "/cockpit", "GET");
      expect(page.status).toBe(200);
      // the window runtime registers the action rows (spec 5.2); the old data-a markup is gone
      expect(page.body).toContain('<main id="win-root">');
      expect(page.body).toContain('"local.start":{');
      expect(page.body).toContain('"local.scale":{');
      expect(page.body).not.toContain('"local.switch":{');
      expect(page.body).toContain('"local.off":{');
      expect(page.body).toContain('"runtime":{fields:["target","value"]');
      expect(page.body).toContain("model.label");
      expect(page.body).toContain('class="phead"');
      expect(page.body).not.toMatch(/\balert\(/);
      expect(page.body).not.toMatch(/\bconfirm\(/);
      expect(page.body).not.toMatch(/\bprompt\(/);
    } finally {
      srv.close();
      setActionHooks({});
    }
  });
});

describe("runtime duplicate guard, progress and fresh inventory", () => {
  const sleep50 = () => new Promise((res) => setTimeout(res, 50));
  const ops = (over: Record<string, unknown> = {}) => ({
    runShell: async () => ({ code: 0 }),
    spawnDetached: () => ({ exit: new Promise<{ code: number | null }>(() => {}) }),
    getUrl: async () => false,
    runCmd: async () => 1,
    now: () => 0,
    sleep: async () => undefined,
    ...over,
  });
  const withOps = (tmp: string, calls: ReturnType<typeof emptyCalls>, o: Record<string, unknown>, hooks?: Record<string, unknown>) =>
    ({ ...(testDeps(tmp, calls) as Record<string, unknown>), runtimeOps: ops(o) }) as never;

  it("a start is refused with 'already running' while the runtime's ready answers, and spawns nothing", async () => {
    const tmp = newDir();
    const calls = emptyCalls();
    const spawned: string[] = [];
    const deps = withOps(tmp, calls, { getUrl: async () => true, spawnDetached: (c: string) => (spawned.push(c), { exit: new Promise(() => {}) }) });
    const r = await runCockpitAction({ action: "runtime", target: "ollama", value: "start" }, deps);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("already running");
    expect(r.jobId).toBeUndefined();
    expect(spawned).toEqual([]);
  });

  it("the CLI path (runtimeStartStop) shares the same guard", async () => {
    const { runtimeStartStop } = await import("./cockpit-actions.js");
    const tmp = newDir();
    const r = await runtimeStartStop("ollama", "start", withOps(tmp, emptyCalls(), { getUrl: async () => true }));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("already running");
  });

  it("a start whose command merely contains 'model' is refused when ready answers; docker-model-runner is decided by kind, not command", async () => {
    const { runtimeOpRefusal } = await import("./cockpit-actions.js");
    const tmp = newDir();
    const up = ops({ getUrl: async () => true }) as never;
    const cmds = {
      custom: { start: "serve --model qwen", ready: "http://127.0.0.1:1/ok" },
      "docker-model-runner": { start: "docker model run", ready: "http://127.0.0.1:2/ok" },
    };
    expect(await runtimeOpRefusal("custom", "start", cmds, tmp, up, "", "llama-server")).toContain("already running");
    expect(await runtimeOpRefusal("docker-model-runner", "start", cmds, tmp, up, "", "docker-model-runner")).toBeNull();
    // the same command under another kind is refused
    expect(await runtimeOpRefusal("docker-model-runner", "start", cmds, tmp, up, "", "llama-server")).toContain("already running");
  });

  it("runningRuntimeJobs lists each running runtime job with its progress; finished ones are absent", async () => {
    const { runningRuntimeJobs } = await import("./cockpit-actions.js");
    const tmp = newDir();
    const deps = withOps(tmp, emptyCalls(), {});
    const r = await runCockpitAction({ action: "runtime", target: "ollama", value: "start" }, deps, { runRuntimeJob: () => new Promise<never>(() => {}) });
    const jobs = runningRuntimeJobs(tmp);
    expect(Object.keys(jobs)).toEqual(["ollama"]);
    expect(jobs.ollama).toMatchObject({ id: r.jobId, op: "start" });
    const done = await runCockpitAction({ action: "runtime", target: "ollama", value: "stop" }, withOps(newDir(), emptyCalls(), {}), { runRuntimeJob: async () => ({ ok: true, message: "x" }) });
    await sleep50();
    expect(done.ok).toBe(true);
    expect(runningRuntimeJobs(newDir())).toEqual({});
  });

  it("a second start while a start job runs is refused with the job id; a second stop with 'already stopping'", async () => {
    const tmp = newDir();
    const calls = emptyCalls();
    const deps = withOps(tmp, calls, {});
    const hang = { runRuntimeJob: () => new Promise<never>(() => {}) };
    const first = await runCockpitAction({ action: "runtime", target: "ollama", value: "start" }, deps, hang);
    expect(first.ok).toBe(true);
    const second = await runCockpitAction({ action: "runtime", target: "ollama", value: "start" }, deps, hang);
    expect(second.ok).toBe(false);
    expect(second.message).toContain(`already starting (job ${first.jobId})`);
    const stop1 = await runCockpitAction({ action: "runtime", target: "ollama", value: "stop" }, deps, hang);
    expect(stop1.ok).toBe(true);
    const stop2 = await runCockpitAction({ action: "runtime", target: "ollama", value: "stop" }, deps, hang);
    expect(stop2.ok).toBe(false);
    expect(stop2.message).toContain("already stopping");
  });

  it("a finished start job no longer blocks a start", async () => {
    const tmp = newDir();
    const calls = emptyCalls();
    const deps = withOps(tmp, calls, {});
    const first = await runCockpitAction({ action: "runtime", target: "ollama", value: "start" }, deps, { runRuntimeJob: async () => ({ ok: true, message: "up" }) });
    await sleep50();
    expect(readCockpitJob(tmp, first.jobId!)!.state).toBe("done");
    const again = await runCockpitAction({ action: "runtime", target: "ollama", value: "start" }, deps, { runRuntimeJob: async () => ({ ok: true, message: "up" }) });
    expect(again.ok).toBe(true);
  });

  it("a fresh inventory probe of the runtime is requested when the job ends, before the job reads done", async () => {
    const tmp = newDir();
    const calls = emptyCalls();
    let stateAtRefresh = "";
    let jobId = "";
    const deps = { ...(withOps(tmp, calls, {}) as Record<string, unknown>), refreshInventory: async (rt: string) => { calls.refresh!.push(rt); const f = readdirSync(join(tmp, "cockpit-jobs"))[0]!; stateAtRefresh = readCockpitJob(tmp, f.slice(0, -5))!.state; } } as never;
    const r = await runCockpitAction({ action: "runtime", target: "ollama", value: "stop" }, deps, { runRuntimeJob: async () => ({ ok: true, message: "ollama stopped" }) });
    jobId = r.jobId!;
    await sleep50();
    expect(calls.refresh).toEqual(["ollama"]);
    expect(stateAtRefresh).toBe("running");
    expect(readCockpitJob(tmp, jobId)!.state).toBe("done");
  });

  it("logTailSince returns the last non-empty line written after the offset, one trimmed line", async () => {
    const { logTailSince } = await import("./cockpit-actions.js");
    const tmp = newDir();
    const log = join(tmp, "rt.log");
    writeFileSync(log, "old line from an earlier run\n");
    const offset = readFileSync(log).length;
    expect(logTailSince(log, offset)).toBe("");
    writeFileSync(log, "old line from an earlier run\n$ serve --port 1\n  loading   model \x1b[32mshard 2/4\x1b[0m  \n\n\n");
    expect(logTailSince(log, offset)).toBe("loading model shard 2/4");
    expect(logTailSince(join(tmp, "none.log"), 0)).toBe("");
    writeFileSync(log, "x".repeat(500) + "\n");
    expect(logTailSince(log, 0, 20).length).toBe(20);
  });

  it("a running runtime job's status carries elapsed seconds and the log tail; the job records the log offset", async () => {
    const { runtimeJobProgress } = await import("./cockpit-actions.js");
    const { runtimeLogFile } = await import("../workers/model-runtimes.js");
    const tmp = newDir();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tmp, "logs", "local"), { recursive: true });
    writeFileSync(runtimeLogFile(tmp, "ollama"), "previous run\n");
    const deps = withOps(tmp, emptyCalls(), {});
    const r = await runCockpitAction({ action: "runtime", target: "ollama", value: "start" }, deps, { runRuntimeJob: () => new Promise<never>(() => {}) });
    const job = readCockpitJob(tmp, r.jobId!)!;
    expect(job.logOffset).toBe("previous run\n".length);
    writeFileSync(runtimeLogFile(tmp, "ollama"), "previous run\nloading the model\n");
    const p = runtimeJobProgress(tmp, job, Date.parse(job.at) + 23_000)!;
    expect(p).toEqual({ elapsedSec: 23, tail: "loading the model" });
    expect(runtimeJobProgress(tmp, { ...job, state: "done" })).toBeNull();
  });

  it("GET /cockpit/job reads the job an action wrote even with PAI_HOME unset (same resolver as the actions)", async () => {
    const { paiHomeDir } = await import("../config/pai-home.js");
    const { mkdirSync } = await import("node:fs");
    const saved = process.env.PAI_HOME;
    delete process.env.PAI_HOME;
    setActionHooks({}, {});
    const home = paiHomeDir();
    expect(home.startsWith(process.env.HOME!)).toBe(true);
    mkdirSync(join(home, "cockpit-jobs"), { recursive: true });
    writeFileSync(join(home, "cockpit-jobs", "abc123.json"), JSON.stringify({ id: "abc123", kind: "runtime", tier: "", runtime: "ollama", op: "start", state: "done", message: "ollama up", at: new Date().toISOString() }));
    const srv = http.createServer((req, res) => {
      if (!handleCockpit(req, res, { get: async () => [] } as never, () => [], () => new Map())) res.end("other");
    });
    try {
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
      const port = (srv.address() as AddressInfo).port;
      const body = await new Promise<{ status: number; body: string }>((resolve) =>
        http.get({ host: "127.0.0.1", port, path: "/cockpit/job?id=abc123" }, (res) => {
          let b = "";
          res.on("data", (c) => (b += c));
          res.on("end", () => resolve({ status: res.statusCode!, body: b }));
        })
      );
      expect(body.status).toBe(200);
      expect(JSON.parse(body.body).message).toBe("ollama up");
    } finally {
      srv.close();
      setActionHooks({});
      if (saved !== undefined) process.env.PAI_HOME = saved;
    }
  });
});

describe("local.stop in-flight count from the scheduler", () => {
  it("counts the running and queued requests of one engine key", async () => {
    const { engineInflight } = await import("./cockpit-actions.js");
    const snap = {
      engines: {
        "gyro-m": { inflight: { session: "s", worker: "w", sinceMs: 1 }, queued: { a: 2, b: 1 }, counters: {} },
        "gyro-m#2": { inflight: null, queued: {}, counters: {} },
      },
    } as never;
    expect(engineInflight(snap, "gyro-m")).toBe(4);
    expect(engineInflight(snap, "gyro-m#2")).toBe(0);
    expect(engineInflight(snap, "other")).toBe(0);
  });
});

describe("memory run safety", () => {
  it("spawnMemoryRun closes the log fd when spawn throws synchronously", async () => {
    const { spawnMemoryRun } = await import("./cockpit-actions.js");
    const home = mkdtempSync(join(tmpdir(), "mem-spawn-"));
    const closed: number[] = [];
    const io = {
      spawn: (() => { throw new Error("spawn EAGAIN"); }) as never,
      openSync: (() => 77) as never,
      closeSync: ((fd: number) => { closed.push(fd); }) as never,
    };
    await expect(spawnMemoryRun("embed", "j1", home, io)).rejects.toThrow("spawn EAGAIN");
    expect(closed).toEqual([77]);
    rmSync(home, { recursive: true });
  });

  it("spawnMemoryRun gives the CLI a login identity when the router has no USER/LOGNAME/HOME", async () => {
    const { spawnMemoryRun } = await import("./cockpit-actions.js");
    const { EventEmitter } = await import("node:events");
    const home = mkdtempSync(join(tmpdir(), "mem-spawn-"));
    const saved = { ...process.env };
    delete process.env.USER; delete process.env.LOGNAME; delete process.env.HOME;
    let env: NodeJS.ProcessEnv | undefined;
    try {
      const io = {
        spawn: ((_c: string, _a: string[], o: { env: NodeJS.ProcessEnv }) => {
          env = o.env;
          const ee = new EventEmitter() as InstanceType<typeof EventEmitter> & { unref(): void };
          ee.unref = () => {};
          setImmediate(() => ee.emit("close", 0, null));
          return ee;
        }) as never,
        openSync: (() => 77) as never,
        closeSync: (() => {}) as never,
      };
      await spawnMemoryRun("index", "j1", home, io);
    } finally {
      Object.assign(process.env, saved);
    }
    expect(env?.USER).toBeTruthy();
    expect(env?.LOGNAME).toBeTruthy();
    expect(env?.HOME).toBeTruthy();
    rmSync(home, { recursive: true });
  });

  it("a failed memory run names its error line, not the trailing 'Node.js vX' of the crash", async () => {
    const { spawnMemoryRun } = await import("./cockpit-actions.js");
    const { EventEmitter } = await import("node:events");
    const { writeFileSync: wf } = await import("node:fs");
    const home = mkdtempSync(join(tmpdir(), "mem-spawn-"));
    const io = {
      spawn: (() => {
        wf(join(home, "state", "memory-run.log"), "SystemError [ERR_SYSTEM_ERROR]: uv_os_get_passwd returned ENOENT\n    at userInfo (node:os:305:11)\n\nNode.js v22.16.0\n");
        const ee = new EventEmitter() as InstanceType<typeof EventEmitter> & { unref(): void };
        ee.unref = () => {};
        setImmediate(() => ee.emit("close", 1, null));
        return ee;
      }) as never,
      openSync: (() => 77) as never,
      closeSync: (() => {}) as never,
    };
    const r = await spawnMemoryRun("index", "j1", home, io);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("index ended (1)");
    expect(r.message).toContain("uv_os_get_passwd");
    rmSync(home, { recursive: true });
  });

  it("pickFailureLine: a Node crash gives its Error line, not the version footer", async () => {
    const { pickFailureLine } = await import("./cockpit-actions.js");
    const crash = "node:internal/x:1\n  throw e;\n  ^\n\nTypeError: bad thing\n    at foo (a.js:1:1)\n    at bar (b.js:2:2)\n\nNode.js v22.16.0\n";
    expect(pickFailureLine(crash)).toBe("TypeError: bad thing");
    expect(pickFailureLine("Error: boom\n    at x (y:1:1)\n\nNode.js v22.16.0\n")).toBe("Error: boom");
  });

  it("pickFailureLine: the Ollama 500 pai line; fallback is the last non-footer line", async () => {
    const { pickFailureLine } = await import("./cockpit-actions.js");
    const ollama = "indexing...\npai: unexpected failure: Ollama /api/embed HTTP 500: model failed to load\n";
    expect(pickFailureLine(ollama)).toBe("pai: unexpected failure: Ollama /api/embed HTTP 500: model failed to load");
    expect(pickFailureLine("one\ntwo\n\nNode.js v22.16.0\n")).toBe("two");
  });

  it("a failed memory run keeps the log tail in the job record", async () => {
    const { spawnMemoryRun } = await import("./cockpit-actions.js");
    const { EventEmitter } = await import("node:events");
    const { writeFileSync: wf } = await import("node:fs");
    const home = mkdtempSync(join(tmpdir(), "mem-tail-"));
    const io = {
      spawn: (() => {
        wf(join(home, "state", "memory-run.log"), "Error: boom\n    at x (y:1:1)\n\nNode.js v22.16.0\n");
        const ee = new EventEmitter() as InstanceType<typeof EventEmitter> & { unref(): void };
        ee.unref = () => {};
        setImmediate(() => ee.emit("close", 1, null));
        return ee;
      }) as never,
      openSync: (() => 77) as never,
      closeSync: (() => {}) as never,
    };
    const r = await spawnMemoryRun("index", "j2", home, io);
    expect(r.message).toBe("index ended (1): Error: boom");
    expect(r.tail).toContain("Node.js v22.16.0");
    rmSync(home, { recursive: true });
  });

  it("memory.stop does not signal a live pid that is not the recorded run (reused pid)", async () => {
    const { runCockpitAction } = await import("./cockpit-actions.js");
    const home = mkdtempSync(join(tmpdir(), "mem-stop-"));
    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(
      join(home, "state", "memory-run.json"),
      JSON.stringify({ kind: "embed", pid: process.pid, by: "cockpit", startedAt: "", backlogStart: null, done: 0, updatedAt: "", jobId: "", pidStart: 1000 }),
    );
    const killed: number[] = [];
    const r = await runCockpitAction({ action: "memory.stop" }, { home, ledger: join(home, "ledger.log"), killRun: (pid: number) => killed.push(pid) } as never);
    expect(r.ok).toBe(false);
    expect(r.message).toBe("nothing running");
    expect(killed).toEqual([]);
    rmSync(home, { recursive: true });
  });
});
