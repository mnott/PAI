/**
 * cockpit-actions.ts — the cockpit's POST /cockpit/action endpoint.
 *
 * Every action goes through the code path the CLI command already implements
 * (injected here so tests can mock it and the router process never spawns a
 * model server on its own): `pai worker local <tier>` (startTier / stopAll),
 * `pai worker classes set` (setClass), `pai config set` (setConfigValueOp /
 * unsetConfigValueOp). Each action appends one COCKPIT-ACTION line to the
 * routing ledger (who=cockpit, action, target, result) and answers
 * {ok, message}. local.switch / local.off run detached and answer at once
 * with a job id; the card shows progress from the inventory refresh.
 * local.start {model} / local.stop {model|id} / local.scale {model, count}
 * work on instances (startInstance / stopInstance); an immediate refusal
 * (memory, maxInstances, requests in flight) answers {ok:false,message}.
 * local.switch / local.off stay one release as wrappers.
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { withLoginIdentity } from "../workers/run-env.js";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { parseEnginePriority, setWorkerPaused, setWorkerPriority } from "../workers/engine-control.js";
import { appendLedger, parseLedger } from "../workers/ledger.js";
import { ledgerPath, workersLogDir } from "../workers/paths.js";
import { readWorkersCached, readWorkersSection, ANTHROPIC_NATIVE } from "../workers/config.js";
import { readMainConfigRaw, writeMainConfigRaw } from "../daemon/config.js";
import { readInventory } from "../workers/model-inventory.js";
import { setClass } from "../workers/providers.js";
import { setConfigValueOp, unsetConfigValueOp } from "../config/main-config-ops.js";
import { readLocalConfig } from "../workers/local-tiers.js";
import { workersYamlPath } from "../workers/workers-config.js";
import { instanceEngineKey } from "../workers/local-instances.js";
import { syncRuntimeInstance, type RuntimeInstanceDeps } from "../workers/runtime-instances.js";
import { sharedScheduler, type SchedSnapshot } from "./scheduler.js";
import { primaryLocal, readLocalStatus } from "../workers/local-status.js";
import { paiHomeDir } from "../config/pai-home.js";
import { readRun, type RunKind, type RunState } from "../memory/run-state.js";
import type { JobRunProgress } from "../memory/job-progress.js";
import { memoryRunLog, runningMemoryJob } from "./cockpit-memory.js";
import { cockpitLayout } from "./cockpit-layout.js";
import { RUNTIME_READY_TIMEOUT_MS, foreignPortHolder, liveRuntimeOpDeps, readRuntimeCommands, readyIsUrl, runRuntimeOp, runtimeLogFile, type RuntimeCommands, type RuntimeOpDeps } from "../workers/model-runtimes.js";

export const COCKPIT_ACTION_EVENT = "COCKPIT-ACTION";
export const RUNTIME_START_EVENT = "RUNTIME-START";
export const RUNTIME_STOP_EVENT = "RUNTIME-STOP";

export interface ActionDeps {
  /** `pai worker local <tier>`: stop every local server, start this tier. */
  startTier: (tierName: string) => Promise<void>;
  /** `pai worker local off`: stop every local server. */
  stopAll: () => Promise<void>;
  /** `pai worker local start <model>`: one more instance (refuses on short memory / maxInstances). */
  startModel?: (model: string) => Promise<void>;
  /** `pai worker local stop <model|id>`: `count` instances (default one) or `all`; refuses with requests in flight unless `confirm`. */
  stopModel?: (target: string, opts: { count?: number; all?: boolean; confirm?: boolean }) => Promise<void>;
  /** Running (non-failed) instances of a model, for local.scale. */
  runningCount?: (model: string) => number | Promise<number>;
  /** Ms to wait for an immediate refusal (memory, maxInstances, in flight) before answering with the job id; default 1500. */
  earlyMs?: number;
  /** `pai worker classes set <class> <provider>`. */
  setClass: (cls: string, target: string) => void;
  /** `pai config set models.labels.<runtime>[/<model>] <label>`. */
  setLabel: (path: string, value: string, opts?: { force?: boolean; asString?: boolean }) => void;
  /** `pai config unset <path>`. */
  unsetLabel: (path: string) => void;
  /** The ledger file; default <logDir>/ledger.log. */
  ledger: string;
  /** workers.yaml path for tier lookup; default workersYamlPath(). */
  workersYaml: string;
  /** Tier names override (tests without a workers.yaml); default reads workersYaml. */
  tiers?: string[];
  /** PAI_HOME for job files; default process.env.PAI_HOME. */
  home: string;
  /** The worker config (providers/classes) for validation and role mapping. */
  workers: ReturnType<typeof readWorkersSection>["workers"];
  /** The daemon's local-status cache (the "stops X first" confirm text). */
  localStatus: ReturnType<typeof readLocalStatus>;
  /** Main config path override (tests); default the live config. */
  configPath?: string;
  /** The configured runtime commands (models.runtimes); default read from the config. */
  runtimeCommands?: Record<string, RuntimeCommands>;
  /** The runtime start/stop runner (dry-run seam for tests); default the live shell run. */
  runtimeOps?: RuntimeOpDeps;
  /** Runtime name → inventory kind (docker-model-runner needs no ready check); default read from the inventory cache. */
  runtimeKinds?: Record<string, string>;
  /** Overrides of the managed-instance registry sync after a runtime op (tests); default lsof and the live log dir. */
  runtimeInstance?: Partial<RuntimeInstanceDeps>;
  /** Fresh model-inventory probe written over the 30 s cache; called when a runtime job ends. Default: compute + write. */
  refreshInventory?: (runtime: string) => Promise<void>;
  /** Called when a local start/stop/scale/switch/off ends: the router drops its cached server probe. */
  onLocalChange?: () => void;
  /** The running index/embed run (memory-run.json); default read from PAI home. */
  readRun?: () => RunState | null;
  /** Why the daemon's own index/embed pass blocks a start, else null; default asks the daemon over IPC. */
  daemonMemoryBusy?: () => Promise<string | null>;
  /** Chunks without vectors (null = unknown); default asks the daemon. memory.embed answers at once when it is 0. */
  embedBacklog?: () => Promise<number | null>;
  /** Signal a run's process (stop); default process.kill. */
  killRun?: (pid: number) => void;
}

/** Everything the handler wires in production; tests replace the whole object. */
export interface ActionHooks {
  /** local.switch / local.off run through this (the router command wires the
   *  real spawn); tests inject a fake. */
  runLocalJob?: (kind: "switch" | "off", tier: string) => Promise<void>;
  /** runtime start/stop run through this (the CLI `pai models start|stop` and
   *  the cockpit share it); tests inject a fake. */
  runRuntimeJob?: (runtime: string, op: "start" | "stop") => Promise<void | { ok: boolean; message: string }>;
  /** memory.embed / memory.index run through this (default: the detached CLI, see spawnMemoryRun); tests inject a fake. */
  runMemoryJob?: (kind: RunKind, jobId: string) => Promise<{ ok: boolean; message: string; tail?: string }>;
}

export interface ActionResult {
  ok: boolean;
  message: string;
  jobId?: string;
}

/** The classes `pai worker classes` knows; the worker role maps all of them. */
export const WORKER_ROLE_CLASSES = ["draft", "plan", "implement", "review", "research", "spotcheck", "simple", "complex", "image"] as const;

/** The ledger line every action writes. */
export function writeLedgerLine(deps: ActionDeps, action: string, target: string, result: string): void {
  // `who=cockpit` first, so `tail` reads as a table (same shape as the WORKER-* lines)
  appendLedger(deps.ledger, COCKPIT_ACTION_EVENT, { who: "cockpit", action, target, result: result.replace(/\s+/g, "_") });
}

/** The job file of a local switch: <PAI_HOME>/cockpit-jobs/<id>.json. */
export function cockpitJobFile(home: string, id: string): string {
  return `${home}/cockpit-jobs/${id}.json`;
}

export interface LocalJobState {
  id: string;
  kind: "switch" | "off" | "start" | "stop" | "scale" | "runtime" | "memory";
  tier: string;
  /** the runtime of a "runtime" job (tier stays "") */
  runtime?: string;
  op?: "start" | "stop";
  /** a "memory" job: which run it started */
  what?: RunKind;
  state: "running" | "done" | "failed" | "interrupted";
  message: string;
  /** a failed job: the last ~40 lines of its log, for the details view */
  tail?: string;
  at: string;
  /** a running job: the process that runs it (cut off by its restart = interrupted, see cockpit-job-recovery.ts) */
  pid?: number;
  /** a runtime job: when it began (ISO) and the size of the runtime log then, so progress shows only its own lines */
  startedAt?: string;
  logOffset?: number;
  /** a running index/embed job: live counters written by the run itself (memory/job-progress.ts); the final write drops it */
  progress?: JobRunProgress;
}

/** What /cockpit/job adds for a running runtime job: seconds since it began and the last log line it wrote. */
export interface JobProgress {
  elapsedSec: number;
  tail: string;
}

/** The last non-empty line the log gained after `offset`, ANSI-stripped and trimmed to one line; "" when none. */
export function logTailSince(logPath: string, offset: number, max = 160): string {
  try {
    const size = statSync(logPath).size;
    const from = offset > size ? 0 : Math.max(offset, size - 8192);
    const buf = Buffer.alloc(size - from);
    const fd = openSync(logPath, "r");
    try {
      readSync(fd, buf, 0, buf.length, from);
    } finally {
      closeSync(fd);
    }
    const lines = buf.toString("utf8").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split(/[\r\n]+/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i]!.trim().replace(/\s+/g, " ");
      // the "$ cmd" echo is the runner's own header, not progress
      if (l && !l.startsWith("$ ")) return l.length > max ? l.slice(0, max - 1) + "…" : l;
    }
  } catch {
    /* no log yet */
  }
  return "";
}

/** Progress of a running runtime job for the card; null for any other job. */
export function runtimeJobProgress(home: string, j: LocalJobState, nowMs = Date.now()): JobProgress | null {
  if (j.kind !== "runtime" || j.state !== "running" || !j.runtime) return null;
  const started = Date.parse(j.startedAt ?? j.at);
  return { elapsedSec: Math.max(0, Math.round((nowMs - (Number.isNaN(started) ? nowMs : started)) / 1000)), tail: logTailSince(runtimeLogFile(home, j.runtime), j.logOffset ?? 0) };
}

/** A running runtime job of this runtime and op (stale ones, older than a start's ready deadline, are ignored). */
export function runningRuntimeJob(home: string, runtime: string, op: "start" | "stop", exceptId = "", nowMs = Date.now()): LocalJobState | null {
  let files: string[] = [];
  try {
    files = readdirSync(`${home}/cockpit-jobs`);
  } catch {
    return null;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const j = readCockpitJob(home, f.slice(0, -5));
    if (!j || j.id === exceptId || j.kind !== "runtime" || j.state !== "running" || j.runtime !== runtime || j.op !== op) continue;
    if (nowMs - Date.parse(j.at) > RUNTIME_READY_TIMEOUT_MS + 60_000) continue;
    return j;
  }
  return null;
}

/** Every running runtime job by runtime (stale ones ignored), with its progress: what the page needs to show a busy card after a reload. */
export function runningRuntimeJobs(home: string, nowMs = Date.now()): Record<string, { id: string; op: "start" | "stop" } & JobProgress> {
  const out: Record<string, { id: string; op: "start" | "stop" } & JobProgress> = {};
  let files: string[] = [];
  try {
    files = readdirSync(`${home}/cockpit-jobs`);
  } catch {
    return out;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const j = readCockpitJob(home, f.slice(0, -5));
    if (!j || j.kind !== "runtime" || j.state !== "running" || !j.runtime || (j.op !== "start" && j.op !== "stop")) continue;
    if (nowMs - Date.parse(j.at) > RUNTIME_READY_TIMEOUT_MS + 60_000) continue;
    const p = runtimeJobProgress(home, j, nowMs);
    if (p) out[j.runtime] = { id: j.id, op: j.op, ...p };
  }
  return out;
}

/** The inventory kind of each runtime (cached inventory); {} when there is none. */
function inventoryKinds(logDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of readInventory(logDir)?.runtimes ?? []) out[r.name] = r.kind;
  return out;
}

/** The one duplicate guard, used by the cockpit action and `pai models start|stop`: why this op must not run now, else null.
 *  start: refused when the runtime's `ready` answers (not for docker-model-runner, whose ready only says the runner
 *  is up, not that the model is loaded) or a start job runs; stop: refused while a stop job runs. */
export async function runtimeOpRefusal(
  runtime: string,
  op: "start" | "stop",
  commands: Record<string, RuntimeCommands>,
  home: string,
  ops: RuntimeOpDeps = liveRuntimeOpDeps,
  exceptJobId = "",
  kind = "",
  /** another runtime's server holds this runtime's shared port: the ready URL answers for it, not for this one */
  portHeldByOther = false
): Promise<string | null> {
  const running = runningRuntimeJob(home, runtime, op, exceptJobId);
  if (running) return op === "start" ? `${runtime} is already starting (job ${running.id})` : `${runtime} is already stopping (job ${running.id})`;
  const c = commands[runtime];
  if (op === "start" && c?.ready && kind !== "docker-model-runner" && !portHeldByOther) {
    const up = readyIsUrl(c.ready) ? await ops.getUrl(c.ready) : (await ops.runCmd(c.ready)) === 0;
    if (up) return `${runtime} is already running (${c.ready})`;
  }
  return null;
}

/** The job's current state; null when the file is absent or unreadable. */
export function readCockpitJob(home: string, id: string): LocalJobState | null {
  if (!/^[a-z0-9]+$/i.test(id)) return null;
  try {
    const j = JSON.parse(readFileSync(cockpitJobFile(home, id), "utf8")) as LocalJobState;
    return j && typeof j.id === "string" ? j : null;
  } catch {
    return null;
  }
}

export function writeCockpitJob(home: string, j: LocalJobState): void {
  const path = cockpitJobFile(home, j.id);
  try {
    mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    writeFileSync(path, JSON.stringify(j.state === "running" ? { pid: process.pid, ...j } : j) + "\n", "utf8");
  } catch {
    /* the job answer already went out; the card just shows no progress */
  }
}

/** The running local model's name, for the "stops X first" confirm text. */
export function runningLocalModel(st: ReturnType<typeof readLocalStatus>): string | null {
  const r = primaryLocal(st);
  return r ? `${r.provider} (${r.model})` : null;
}

/** The catalogue model a name stands for: a model name as is, a provider name (the Local servers card) resolved to the model that serves it. */
export function resolveTierName(name: string, models: string[], yamlPath: string): string {
  if (models.includes(name)) return name;
  try {
    return Object.values(readLocalConfig(yamlPath).tiers).find((t) => t.provider === name)?.tier ?? name;
  } catch {
    return name;
  }
}

/** The tier names in workers.yaml (same reader `pai worker local` uses). */
export function tierNames(yamlPath: string): string[] {
  try {
    return Object.keys(readLocalConfig(yamlPath).tiers);
  } catch {
    return [];
  }
}

/** The config path a label write goes to: models.labels.<runtime>. A model's label lives in
 *  that runtime's {model → label} map (written whole, so ids with "." stay one key). */
export function labelPath(runtime: string, _model?: string): string {
  return `models.labels.${runtime}`;
}

/** The labels config block (runtime → {model → label} or a plain runtime label). */
export function readLabels(): Record<string, unknown> {
  try {
    const l = (readMainConfigRaw() as { models?: { labels?: unknown } }).models?.labels;
    return l && typeof l === "object" && !Array.isArray(l) ? (l as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The label of a runtime (or one of its models), "" when none is set. */
export function labelFor(runtime: string, model?: string): string {
  const block = readLabels()[runtime];
  if (model) {
    if (block && typeof block === "object" && !Array.isArray(block)) {
      const v = (block as Record<string, unknown>)[model];
      return typeof v === "string" ? v : "";
    }
    return "";
  }
  return typeof block === "string" ? block : "";
}

/** Which classes currently pin this provider (the "workers" toggle state). */
export function classesOnProvider(workers: ActionDeps["workers"], provider: string): string[] {
  return Object.entries(workers.classes)
    .filter(([, t]) => (typeof t === "string" ? t.split("/")[0] : t.provider) === provider)
    .map(([c]) => c);
}

/** The provider the orchestrate/chat side runs on: the session profile's chat
 *  provider when set, else the active provider ("" = the built-in anthropic). */
export function orchestratorProvider(workers: ActionDeps["workers"]): string {
  try {
    const p = (readWorkersSection().raw as { session?: { profile?: { chat?: { provider?: unknown } } } }).session?.profile?.chat?.provider;
    if (typeof p === "string" && p) return p;
  } catch {
    /* no profile: the active provider answers */
  }
  return workers.active && workers.active !== "auto" ? workers.active : "";
}

/** Requests running or waiting on one engine key in a scheduler snapshot. */
export function engineInflight(snap: SchedSnapshot, key: string): number {
  const e = snap.engines[key];
  return e ? (e.inflight ? 1 : 0) + Object.values(e.queued).reduce((a, n) => a + n, 0) : 0;
}

export function defaultDeps(): ActionDeps {
  const { workers } = readWorkersSection();
  const logDir = workersLogDir(workers);
  return {
    startTier: async (tierName) => {
      const { startTier } = await import("../cli/commands/worker-config.js");
      const cfg = readLocalConfig(workersYamlPath());
      const tier = cfg.tiers[tierName];
      if (!tier) throw new Error(`no tier "${tierName}" (configured: ${Object.keys(cfg.tiers).join(", ") || "none"})`);
      await startTier(cfg, tierName, tier);
    },
    stopAll: async () => {
      const { stopAll } = await import("../cli/commands/worker-config.js");
      await stopAll(readLocalConfig(workersYamlPath()));
    },
    startModel: async (model) => {
      const { startInstance } = await import("../cli/commands/worker-config.js");
      await startInstance(readLocalConfig(workersYamlPath()), model);
    },
    stopModel: async (target, opts) => {
      const { stopInstance } = await import("../cli/commands/worker-config.js");
      const { currentInstances } = await import("../cli/commands/worker-config.js");
      const cfg = readLocalConfig(workersYamlPath());
      const keys = new Map(currentInstances(cfg).map((r) => [r.id, instanceEngineKey(r)]));
      await stopInstance(cfg, target, opts, { confirm: opts.confirm, inflight: (id) => engineInflight(sharedScheduler().snapshot(), keys.get(id) ?? id) });
    },
    runningCount: async (model) => {
      const { currentInstances } = await import("../cli/commands/worker-config.js");
      return currentInstances(readLocalConfig(workersYamlPath())).filter((r) => r.model === model && r.state !== "failed").length;
    },
    setClass: (cls, target) => void setClass(cls, target),
    setLabel: (path, value, opts) => void setConfigValueOp(path, value, opts),
    unsetLabel: (path) => void unsetConfigValueOp(path),
    ledger: ledgerPath(logDir),
    workersYaml: workersYamlPath(),
    home: paiHomeDir(),
    workers,
    localStatus: readLocalStatus(logDir),
    runtimeCommands: readRuntimeCommands(),
    runtimeKinds: inventoryKinds(logDir),
  };
}

/** The runtime start/stop through the configured commands: the shell run, the ledger line, the job file.
 *  Shared by the cockpit action and `pai models start|stop`. */
export async function runtimeStartStop(
  runtime: string,
  op: "start" | "stop",
  deps: ActionDeps,
  opts: { model?: string; jobId?: string; force?: boolean } = {}
): Promise<{ ok: boolean; message: string }> {
  const commands = deps.runtimeCommands ?? readRuntimeCommands(deps.configPath);
  const ops = deps.runtimeOps ?? liveRuntimeOpDeps;
  // runtimes sharing a port: the server there belongs to the one whose model it reports
  const holder = await foreignPortHolder(runtime, commands, ops.servedModels);
  if (holder && op === "stop" && !opts.force) {
    return { ok: false, message: `${runtime} is not running: the server on its port belongs to ${holder}; pai models stop ${holder} (or --force to run ${runtime}'s stop command anyway)` };
  }
  const refused = await runtimeOpRefusal(runtime, op, commands, deps.home, deps.runtimeOps, opts.jobId, deps.runtimeKinds?.[runtime], !!holder);
  if (refused) return { ok: false, message: refused };
  let note = "";
  if (holder && op === "start") {
    const stopped = await runRuntimeOp(holder, "stop", commands, ops, deps.home);
    if (!stopped.ok) return { ok: false, message: `stopping ${holder} (holds the port of ${runtime}) failed: ${stopped.message}` };
    note = `stopped ${holder} first (it held the port of ${runtime}); `;
  }
  const r0 = await runRuntimeOp(runtime, op, commands, ops, deps.home, opts);
  const r = note ? { ...r0, message: note + r0.message } : r0;
  appendLedger(deps.ledger, op === "start" ? RUNTIME_START_EVENT : RUNTIME_STOP_EVENT, {
    who: "cockpit",
    runtime,
    result: r.ok ? "ok" : `error: ${r.message}`,
    log: runtimeLogFile(deps.home, runtime),
  });
  const providerUrl = deps.workers.providers?.[runtime]?.baseUrl;
  if (providerUrl) syncRuntimeInstance(runtime, op, r.ok, { logDir: workersLogDir(deps.workers), home: deps.home, providerUrl, ...deps.runtimeInstance });
  return r;
}

/**
 * Validate and run one action. Returns {ok, message}; local.switch / local.off
 * answer at once with a jobId and run through hooks.runLocalJob.
 */
/** Actions between their refusal check and the job write: a second call for the same key is refused, not started twice. */
const inFlightActions = new Set<string>();
function claimAction(key: string): boolean {
  if (inFlightActions.has(key)) return false;
  inFlightActions.add(key);
  return true;
}

export async function runCockpitAction(
  body: { action?: unknown; target?: unknown; value?: unknown; count?: unknown; all?: unknown; class?: unknown; models?: unknown; session?: unknown; clear?: unknown },
  deps: ActionDeps,
  hooks: ActionHooks = {}
): Promise<ActionResult> {
  const action = typeof body.action === "string" ? body.action : "";
  let target = typeof body.target === "string" ? body.target : "";
  const value = typeof body.value === "string" ? body.value : undefined;
  const fail = (message: string): ActionResult => {
    writeLedgerLine(deps, action || "?", target, `error: ${message}`);
    return { ok: false, message };
  };

  if (action === "local.switch") {
    const tiers = deps.tiers ?? tierNames(deps.workersYaml);
    if (!target || !tiers.includes(target)) return fail(`no tier "${target}" (configured: ${tiers.join(", ") || "none"})`);
    const id = randomBytes(6).toString("hex");
    writeCockpitJob(deps.home, { id, kind: "switch", tier: target, state: "running", message: `starting ${target}`, at: new Date().toISOString() });
    writeLedgerLine(deps, action, target, `job ${id}: started`);
    void finishLocalJob(deps, hooks, id, "switch", target);
    return { ok: true, message: `switching to ${target}`, jobId: id };
  }
  if (action === "local.start" || action === "local.stop" || action === "local.scale") {
    const kind = action === "local.start" ? "start" : action === "local.stop" ? "stop" : "scale";
    const models = deps.tiers ?? tierNames(deps.workersYaml);
    target = target && resolveTierName(target, models, deps.workersYaml);
    if (!target) return fail(kind === "stop" ? "target (model or instance id) required" : "target (model) required");
    if (kind !== "stop" && !models.includes(target)) return fail(`no model "${target}" (configured: ${models.join(", ") || "none"})`);
    let count = 0;
    if (kind === "scale") {
      count = Number(body.count ?? value);
      if (!Number.isInteger(count) || count < 0) return fail(`count must be a whole number, got "${String(body.count ?? value ?? "")}"`);
    }
    const id = randomBytes(6).toString("hex");
    const verb = kind === "start" ? `starting ${target}` : kind === "stop" ? `stopping ${target}` : `scaling ${target} to ${count}`;
    writeCockpitJob(deps.home, { id, kind, tier: target, state: "running", message: verb, at: new Date().toISOString() });
    writeLedgerLine(deps, action, target, `job ${id}: started`);
    const job = finishLocalJob(deps, hooks, id, kind, target, { count, confirm: value === "confirm", all: body.all === true });
    // a refusal (short memory, maxInstances, requests in flight) comes back at once, not as a job to poll
    const early = await Promise.race([job, new Promise<null>((res) => setTimeout(() => res(null), deps.earlyMs ?? 1500))]);
    if (early && !early.ok) return { ok: false, message: early.message };
    return { ok: true, message: verb, jobId: id };
  }
  if (action === "runtime") {
    const runtime = target;
    const op = value === "start" || value === "stop" ? value : "";
    if (!runtime) return fail("target (runtime) required");
    if (op !== "start" && op !== "stop") return fail(`op must be start or stop, got "${value ?? ""}"`);
    const commands = deps.runtimeCommands ?? readRuntimeCommands(deps.configPath);
    if (!commands[runtime]?.[op]) return fail(`no ${op} command configured for ${runtime} (models.runtimes.${runtime}.${op})`);
    const claim = `runtime:${runtime}`;
    if (!claimAction(claim)) return fail(`a ${runtime} start/stop is already being set up`);
    let id: string;
    let logOffset = 0;
    try {
      const refused = await runtimeOpRefusal(runtime, op, commands, deps.home, deps.runtimeOps, "", deps.runtimeKinds?.[runtime]);
      if (refused) return fail(refused);
      id = randomBytes(6).toString("hex");
      try {
        logOffset = statSync(runtimeLogFile(deps.home, runtime)).size;
      } catch {
        /* no log yet */
      }
      const at = new Date().toISOString();
      writeCockpitJob(deps.home, { id, kind: "runtime", tier: "", runtime, op, state: "running", message: `${op} ${runtime}`, at, startedAt: at, logOffset });
    } finally {
      inFlightActions.delete(claim);
    }
    writeLedgerLine(deps, action, `${runtime}:${op}`, `job ${id}: started`);
    void finishRuntimeJob(deps, hooks, id, runtime, op);
    return { ok: true, message: `${op === "start" ? "starting" : "stopping"} ${runtime}`, jobId: id };
  }
  if (action === "memory.embed" || action === "memory.index") {
    const kind: RunKind = action === "memory.embed" ? "embed" : "index";
    if (!claimAction("memory")) return fail("a memory run is already being set up");
    let id: string;
    try {
      const refused = await memoryRunRefusal(deps);
      if (refused) return fail(refused);
      if (kind === "embed" && (await (deps.embedBacklog ?? daemonEmbedBacklog)()) === 0) return { ok: true, message: "nothing to embed (backlog 0)" };
      id = randomBytes(6).toString("hex");
      const at = new Date().toISOString();
      writeCockpitJob(deps.home, { id, kind: "memory", tier: "", what: kind, state: "running", message: kind === "embed" ? "embed backlog" : "index now", at, startedAt: at });
    } finally {
      inFlightActions.delete("memory");
    }
    writeLedgerLine(deps, action, kind, `job ${id}: started`);
    void finishMemoryJob(deps, hooks, id, kind);
    return { ok: true, message: kind === "embed" ? "embedding the backlog" : "indexing", jobId: id };
  }
  if (action === "memory.stop") {
    const r = stopMemoryRun(deps);
    return r.ok ? r : fail(r.message);
  }
  if (action === "local.off") {
    const id = randomBytes(6).toString("hex");
    writeCockpitJob(deps.home, { id, kind: "off", tier: "", state: "running", message: "stopping local servers", at: new Date().toISOString() });
    writeLedgerLine(deps, action, target || "-", `job ${id}: started`);
    void finishLocalJob(deps, hooks, id, "off", "");
    return { ok: true, message: "stopping local model servers", jobId: id };
  }
  if (action === "model.label") {
    if (!target) return fail("target (runtime) required");
    const runtime = target;
    // value "model:<id>=<label>" labels one model; a plain value labels the runtime;
    // an empty (or label-less model:) value removes the entry
    let model: string | undefined;
    let label = value ?? "";
    if (value !== undefined && value.startsWith("model:")) {
      const rest = value.slice(6);
      const eq = rest.indexOf("=");
      if (eq >= 0) {
        model = rest.slice(0, eq);
        label = rest.slice(eq + 1);
      } else {
        model = rest;
        label = "";
      }
    }
    const path = labelPath(runtime, model);
    // the config writer validates against the shipped defaults; models.* is not a known
    // top-level key there, so this label block writes with force (same as
    // `pai config set models.labels.<rt> <label> --force`)
    try {
      if (model) {
        // a model id may hold "." (huggingface.co/org/name), which a dotted path would split
        // into nested keys: the runtime's whole {model → label} map is written as one object
        const prev = readLabels()[runtime];
        const map: Record<string, unknown> = prev && typeof prev === "object" && !Array.isArray(prev) ? { ...(prev as Record<string, unknown>) } : {};
        if (label.trim()) map[model] = label;
        else delete map[model];
        if (Object.keys(map).length === 0) {
          deps.unsetLabel(path);
          writeLedgerLine(deps, action, path, "removed");
          return { ok: true, message: `label removed (${runtime}/${model})` };
        }
        deps.setLabel(path, JSON.stringify(map), { force: true });
        writeLedgerLine(deps, action, path, label.trim() ? `set:${label}` : "removed");
        return { ok: true, message: label.trim() ? `labelled ${runtime}/${model}: ${label}` : `label removed (${runtime}/${model})` };
      }
      if (!label.trim()) {
        deps.unsetLabel(path);
        writeLedgerLine(deps, action, path, "removed");
        return { ok: true, message: `label removed (${runtime})` };
      }
      deps.setLabel(path, label, { force: true, asString: true });
      writeLedgerLine(deps, action, path, `set:${label}`);
      return { ok: true, message: `labelled ${runtime}${model ? "/" + model : ""}: ${label}` };
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  }
  if (action === "route.set") {
    // a tier row takes a list of entries: provider names or selectors (local, model:, tag:, class:); same writer as `pai worker route set`
    if (!target) return fail("target (tier) required");
    try {
      const { setRoute } = await import("../workers/route-table.js");
      const models = Array.isArray(body.models) ? body.models : value !== undefined ? value.split(",") : body.models;
      const change = setRoute(target, models, deps.configPath);
      writeLedgerLine(deps, action, change.id, `set:${change.entries.join(">")}`);
      return { ok: true, message: `${change.id} → ${change.entries.join(" → ")}` };
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  }
  if (action === "endpoint.enable") {
    // registered endpoints only: routing on/off, PAI never starts or stops them
    if (!target) return fail("target (endpoint) required");
    if (value !== "on" && value !== "off") return fail(`value must be on or off, got "${value ?? ""}"`);
    if (!deps.workers.providers[target]?.characteristics) return fail(`"${target}" is not a registered endpoint (providers.${target}.characteristics)`);
    try {
      const { setProviderEnabled } = await import("../workers/providers.js");
      setProviderEnabled(target, value === "on", deps.configPath);
      writeLedgerLine(deps, action, target, `routing ${value}`);
      return { ok: true, message: `${target} routing ${value}` };
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  }
  if (action === "cloud.role") {
    const role = value;
    if (!target) return fail("target (provider) required");
    if (role !== "worker" && role !== "orchestrator") return fail(`role must be worker or orchestrator, got "${role ?? ""}"`);
    const provider = target;
    if (provider !== ANTHROPIC_NATIVE && !deps.workers.providers[provider]) {
      return fail(`no provider named "${provider}"`);
    }
    try {
      if (role === "worker") {
        for (const cls of WORKER_ROLE_CLASSES) deps.setClass(cls, provider);
        writeLedgerLine(deps, action, provider, "role=worker: classes → " + provider);
        return { ok: true, message: `worker classes → ${provider}` };
      }
      // orchestrator: the chat side runs on this provider — the active provider
      // (the same code path `pai providers use` takes) plus the main config's
      // session.profile.chat, so the next session orchestrates on it.
      const { useProvider } = await import("../workers/providers.js");
      useProvider(provider);
      try {
        const raw = readMainConfigRaw();
        const session = (raw.session ?? {}) as Record<string, unknown>;
        const profile = (session.profile ?? {}) as Record<string, unknown>;
        const chat = (profile.chat ?? {}) as Record<string, unknown>;
        chat.provider = provider;
        profile.chat = chat;
        session.profile = profile;
        raw.session = session;
        writeMainConfigRaw(raw);
      } catch {
        /* the active provider alone still answers the toggle */
      }
      writeLedgerLine(deps, action, provider, "role=orchestrator: active → " + provider);
      return { ok: true, message: `orchestrator → ${provider}` };
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  }
  if (action === "worker.priority" || action === "worker.pause" || action === "worker.resume") {
    // engine priority / pause of a running worker (status file; the router reads it at the next request)
    if (!target) return fail("target (worker id) required");
    const dir = dirname(deps.ledger);
    try {
      if (action === "worker.priority") {
        const level = parseEnginePriority(value);
        const from = setWorkerPriority(dir, target, level, "cockpit");
        writeLedgerLine(deps, action, target, `${from}->${level}`);
        return { ok: true, message: `${target}: ${level} priority (next engine request)` };
      }
      const changed = setWorkerPaused(dir, target, action === "worker.pause", "cockpit");
      writeLedgerLine(deps, action, target, changed ? "done" : "unchanged");
      return { ok: true, message: `${target}: ${action === "worker.pause" ? (changed ? "paused" : "already paused") : changed ? "resumed" : "was not paused"}` };
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  }
  return fail(`unknown action "${action}"`);
}

/** Ends the cockpit- or CLI-started memory run (SIGTERM, resumable); the daemon's own pass ends at its budget. Shared by memory.stop and the memory_run MCP tool. */
export function stopMemoryRun(deps: ActionDeps): { ok: boolean; message: string } {
  const run = (deps.readRun ?? (() => readRun(deps.home)))();
  if (!run) return { ok: false, message: "nothing running" };
  if (run.by === "daemon") return { ok: false, message: `the ${run.kind} run belongs to the daemon's pass (pid ${run.pid}); it ends at its own budget` };
  try {
    (deps.killRun ?? ((pid) => process.kill(pid, "SIGTERM")))(run.pid);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  writeLedgerLine(deps, "memory.stop", run.kind, `pid ${run.pid}: stopping`);
  return { ok: true, message: `stopping ${run.kind} (re-run to continue)` };
}

/** Why an index/embed run must not start now (the duplicate guard), else null: a run's marker (any starter),
 *  a cockpit job still starting, or the daemon's own pass. */
export async function memoryRunRefusal(deps: ActionDeps, nowMs = Date.now()): Promise<string | null> {
  const run = (deps.readRun ?? (() => readRun(deps.home)))();
  if (run) return `${run.kind} already running (started by ${run.by}, pid ${run.pid})`;
  const starting = runningMemoryJob(deps.home, nowMs, cockpitLayout().memoryStartGraceSecs * 1000);
  if (starting) return `${starting.what ?? "run"} is already starting (job ${starting.id})`;
  const busy = await (deps.daemonMemoryBusy ?? daemonMemoryBusy)();
  return busy;
}

/** The daemon's count of chunks without vectors; null when it does not answer. */
async function daemonEmbedBacklog(): Promise<number | null> {
  const { fetchDaemonMemory } = await import("./cockpit-memory.js");
  return (await fetchDaemonMemory())?.embedBacklog ?? null;
}

/** The daemon's in-process passes (no child, so no marker): its status says whether one runs. */
async function daemonMemoryBusy(): Promise<string | null> {
  try {
    const { PaiClient } = await import("../daemon/ipc-client.js");
    const { loadConfig } = await import("../daemon/config.js");
    const s = await new PaiClient(loadConfig().socketPath).call("status", {}, 5000) as { indexInProgress?: boolean; embedInProgress?: boolean };
    if (s.embedInProgress) return "embed already running (started by daemon)";
    if (s.indexInProgress) return "index already running (started by daemon)";
  } catch {
    /* daemon down: nothing of its own can be running */
  }
  return null;
}

/** `pai memory embed --all --background` / `pai memory index --direct --background`, detached, output to the run log;
 *  resolves when it exits. The run marks itself in memory-run.json (by=cockpit through PAI_RUN_BY). */
export function spawnMemoryRun(
  kind: RunKind,
  jobId: string,
  home: string,
  io: { spawn: typeof spawn; openSync: typeof openSync; closeSync: typeof closeSync } = { spawn, openSync, closeSync },
  cliEntry: string = process.argv[1] ?? "",
): Promise<{ ok: boolean; message: string; tail?: string }> {
  const args = kind === "embed" ? ["memory", "embed", "--all", "--background"] : ["memory", "index", "--direct", "--background"];
  const log = memoryRunLog(home);
  mkdirSync(`${home}/state`, { recursive: true });
  const fd = io.openSync(log, "w");
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = io.spawn(process.execPath, [cliEntry, ...args], {
        detached: true,
        stdio: ["ignore", fd, fd],
        // the router may run without USER/LOGNAME/HOME; the CLI then dies in os.userInfo() while loading its config
        env: withLoginIdentity({ ...process.env, PAI_RUN_BY: "cockpit", PAI_COCKPIT_JOB: jobId }),
      });
    } finally {
      io.closeSync(fd);
    }
    child.on("error", (e) => resolve({ ok: false, message: `cannot start: ${e.message}` }));
    child.on("close", (code, signal) => {
      const line = code === 0 ? logTailSince(log, 0) : failureLine(log);
      resolve({ ok: code === 0, message: code === 0 ? line || `${kind} finished` : `${kind} ended (${code ?? signal})${line ? ": " + line : ""}`, ...(code === 0 ? {} : { tail: failureTail(log) }) });
    });
    child.unref();
  });
}

/** Lines of the log's tail kept in the job record for the details view. */
const JOB_TAIL_LINES = 40;

/** The line that says why a run died, from its stderr text: the first line that looks like the error
 *  ("Error: …", "TypeError: …", "pai: …", "error: …"), else the last meaningful line. Skips Node's
 *  "Node.js vX" footer, stack frames, "^" markers and blank lines. */
export function pickFailureLine(text: string): string {
  const lines = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split(/[\r\n]+/).map((l) => l.trim().replace(/\s+/g, " "))
    .filter((l) => l && !/^at /.test(l) && !/^Node\.js v/.test(l) && !/^[\^~\s]+$/.test(l));
  const hit = lines.find((l) => /^(?:Uncaught |Unhandled )?(?:\w*Error\b|\w*Error \[|pai:|error:|fatal:)/i.test(l)) ?? lines[lines.length - 1] ?? "";
  return hit.length > 160 ? hit.slice(0, 159) + "…" : hit;
}

/** The last lines of a run's log, for the job record. */
function failureTail(log: string): string {
  try {
    return readFileSync(log, "utf8").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split(/\r?\n/).slice(-JOB_TAIL_LINES - 1).join("\n").trim();
  } catch {
    return "";
  }
}

function failureLine(log: string): string {
  try {
    return pickFailureLine(readFileSync(log, "utf8").slice(-8192));
  } catch {
    return "";
  }
}

/** Runs the memory job (hook or the detached CLI), records its outcome in the job file. */
async function finishMemoryJob(deps: ActionDeps, hooks: ActionHooks, id: string, kind: RunKind): Promise<void> {
  const run = hooks.runMemoryJob ?? ((k, j) => spawnMemoryRun(k, j, deps.home));
  let r: { ok: boolean; message: string; tail?: string };
  try {
    r = await run(kind, id);
  } catch (e) {
    r = { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  writeCockpitJob(deps.home, { id, kind: "memory", tier: "", what: kind, state: r.ok ? "done" : "failed", message: r.message, ...(r.tail ? { tail: r.tail } : {}), at: new Date().toISOString() });
  writeLedgerLine(deps, kind === "embed" ? "memory.embed" : "memory.index", kind, `job ${id}: ${r.ok ? "done" : "failed: " + r.message}`);
}

/** Runs the runtime job (hook or configured commands), records its outcome in the job file;
 *  runtimeStartStop already wrote the RUNTIME-START/STOP line. */
async function finishRuntimeJob(deps: ActionDeps, hooks: ActionHooks, id: string, runtime: string, op: "start" | "stop"): Promise<void> {
  const run = hooks.runRuntimeJob ?? (() => runtimeStartStop(runtime, op, deps, { jobId: id }));
  const end = (state: "done" | "failed", message: string): void =>
    writeCockpitJob(deps.home, { id, kind: "runtime", tier: "", runtime, op, state, message, at: new Date().toISOString() });
  let state: "done" | "failed" = "done";
  let message = `${runtime} ${op === "start" ? "up" : "stopped"}`;
  try {
    const r = await run(runtime, op);
    if (r && !r.ok) state = "failed";
    if (r) message = r.message;
  } catch (e) {
    state = "failed";
    message = e instanceof Error ? e.message : String(e);
  }
  // the card flips right after the job ends: a fresh probe over the 30 s cached inventory, before the job reads done
  try {
    await (deps.refreshInventory ?? defaultRefreshInventory)(runtime);
  } catch {
    /* the daemon's next 30 s refresh still corrects the card */
  }
  end(state, message);
}

async function defaultRefreshInventory(): Promise<void> {
  const { computeInventory, readInventoryInput, writeInventory } = await import("../workers/model-inventory.js");
  writeInventory(workersLogDir(readWorkersCached()), await computeInventory(readInventoryInput()));
}

/** Runs the injected local job, records its outcome in the job file and ledger. */
async function finishLocalJob(
  deps: ActionDeps,
  hooks: ActionHooks,
  id: string,
  kind: "switch" | "off" | "start" | "stop" | "scale",
  tier: string,
  opts: { count?: number; confirm?: boolean; all?: boolean } = {}
): Promise<{ ok: boolean; message: string }> {
  const action = `local.${kind}`;
  const legacy = hooks.runLocalJob ?? (kind === "switch" ? () => deps.startTier(tier) : () => deps.stopAll());
  const run =
    kind === "start"
      ? () => needDep(deps.startModel)(tier)
      : kind === "stop"
        ? () => needDep(deps.stopModel)(tier, { confirm: opts.confirm, ...(opts.all ? { all: true } : {}) })
        : kind === "scale"
          ? () => scaleModel(deps, tier, opts.count ?? 0)
          : () => legacy(kind, tier);
  try {
    try {
      await run();
    } finally {
      // the server list changed (or the attempt did): the next limits/models read probes afresh, not the cached reading
      deps.onLocalChange?.();
    }
    const message = kind === "off" ? "local servers stopped" : kind === "stop" ? `${tier} stopped` : kind === "scale" ? `${tier} at ${opts.count}` : `${tier} up`;
    writeCockpitJob(deps.home, { id, kind, tier, state: "done", message, at: new Date().toISOString() });
    writeLedgerLine(deps, action, tier || "-", `job ${id}: done`);
    return { ok: true, message };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    writeCockpitJob(deps.home, { id, kind, tier, state: "failed", message: msg, at: new Date().toISOString() });
    writeLedgerLine(deps, action, tier || "-", `job ${id}: failed: ${msg}`);
    return { ok: false, message: msg };
  }
}

function needDep<T>(f: T | undefined): T {
  if (!f) throw new Error("local model control is not wired in this process");
  return f;
}

/** Bring a model to `count` running instances: start the missing ones one by one, or stop the highest-numbered extras. */
async function scaleModel(deps: ActionDeps, model: string, count: number): Promise<void> {
  const have = await needDep(deps.runningCount)(model);
  if (count === have) return;
  if (count > have) {
    for (let i = have; i < count; i++) await needDep(deps.startModel)(model);
    return;
  }
  await needDep(deps.stopModel)(model, count === 0 ? { all: true } : { count: have - count });
}

/** The ledger lines of cockpit actions (for the card's result text / history). */
export function cockpitActionLedger(ledgerFile: string, lastN = 10): string[] {
  if (!existsSync(ledgerFile)) return [];
  return parseLedger(readFileSync(ledgerFile, "utf8"))
    .filter((l) => l.event === COCKPIT_ACTION_EVENT)
    .slice(-lastN)
    .map((l) => `${l.stamp} ${l.fields.action ?? "?"} ${l.fields.target ?? "-"} ${l.fields.result ?? ""}`);
}
