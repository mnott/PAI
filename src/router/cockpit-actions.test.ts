/**
 * cockpit-actions.test.ts — the /cockpit/action endpoint. Every case runs
 * against a temp PAI_HOME/config.yaml via PAI_CONFIG_FILE (set before
 * daemon/config.ts is first imported, since CONFIG_FILE resolves once at
 * module load) — never the live config.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    localStatus: { at: new Date().toISOString(), running: { provider: "local30", model: "qwen3-coder", why: "" }, down: [], disabled: [] },
    tiers: ["small", "big"],
  } as never;
}
const emptyCalls = () => ({ startTier: [] as string[], stopAll: [] as string[], setClass: [] as string[], setLabel: [] as string[], unsetLabel: [] as string[] });

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

  it("route validates class and models, writes the list to the (temp) config, ledgers ROUTE-SET", async () => {
    const tmp = newDir();
    const deps = { ...(testDeps(tmp, emptyCalls()) as object), configPath: process.env.PAI_CONFIG_FILE } as never;
    const r = await runCockpitAction({ action: "route", class: "implement", models: ["anthropic/opus", "anthropic/haiku"] }, deps);
    expect(r.ok).toBe(true);
    const { readWorkersSection } = await import("../workers/config.js");
    const { classRoute } = await import("../workers/route-lists.js");
    expect(classRoute(readWorkersSection(process.env.PAI_CONFIG_FILE).workers.classes, "implement")).toEqual(["anthropic/opus", "anthropic/haiku"]);
    const lines = parseLedger(readFileSync(join(tmp, "ledger.log"), "utf8"));
    expect(lines.some((l) => l.event === "ROUTE-SET" && l.fields.class === "implement" && l.fields.models === "anthropic/opus>anthropic/haiku")).toBe(true);
    expect((await runCockpitAction({ action: "route", class: "boss", models: ["anthropic"] }, deps)).ok).toBe(false);
    expect((await runCockpitAction({ action: "route", class: "implement", models: [] }, deps)).ok).toBe(false);
    expect((await runCockpitAction({ action: "route", class: "implement", models: "anthropic" }, deps)).ok).toBe(false);
    expect((await runCockpitAction({ action: "route", class: "implement", models: ["nobody/x"] }, deps)).ok).toBe(false);
    expect((await runCockpitAction({ action: "route", class: "implement", models: ["anthropic/gpt9"] }, deps)).ok).toBe(false);
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
    expect(labelPath("ollama", "qwen3:8b")).toBe("models.labels.ollama.qwen3:8b");
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
    expect(calls.setLabel).toEqual(["models.labels.ollama.qwen3:8b=cheap drafts"]);
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

  it("unknown actions refuse", async () => {
    const tmp = newDir();
    const r = await runCockpitAction({ action: "wat" }, testDeps(tmp, emptyCalls()));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('unknown action "wat"');
  });

  it("role helpers: classes on a provider, the running model for the confirm text", () => {
    expect(classesOnProvider(workers, "glm")).toEqual(["implement"]);
    expect(classesOnProvider(workers, "other")).toEqual([]);
    expect(runningLocalModel({ at: "x", running: { provider: "local30", model: "qwen3-coder", why: "" }, down: [], disabled: [] })).toBe("local30 (qwen3-coder)");
    expect(runningLocalModel({ at: "x", running: null, down: [], disabled: [] })).toBeNull();
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

  it("sameOriginAction: no Origin passes (curl), matching Origin passes, mismatch refuses", () => {
    const h = (o: Record<string, string>) => ({ headers: o, method: "POST" }) as never;
    expect(sameOriginAction(h({ host: "127.0.0.1:8790" }))).toBe(true);
    expect(sameOriginAction(h({ host: "127.0.0.1:8790", origin: "http://127.0.0.1:8790" }))).toBe(true);
    expect(sameOriginAction(h({ host: "127.0.0.1:8790", origin: "http://evil.example" }))).toBe(false);
    expect(sameOriginAction(h({ host: "h", "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(sameOriginAction(h({ host: "h", "sec-fetch-site": "same-origin" }))).toBe(true);
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
      expect(page.body).toContain('data-a="local.switch"');
      expect(page.body).toContain('data-a="local.off"');
      expect(page.body).toContain('data-section="routing"');
      expect(page.body).toContain("model.label");
      expect(page.body).toContain("first, needs ~");
      expect(page.body).toContain("Local model:");
      expect(page.body).toContain('class="pgroup" data-prov=');
      expect(page.body).toContain('<div class="phead">');
      expect(page.body).toContain("tier'+(cur?' cur':'')");
      expect(page.body).toContain("running.label||running.model");
      expect(page.body).not.toMatch(/\balert\(/);
      expect(page.body).not.toMatch(/\bconfirm\(/);
      expect(page.body).not.toMatch(/\bprompt\(/);
    } finally {
      srv.close();
      setActionHooks({});
    }
  });
});
