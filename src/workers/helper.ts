/**
 * helper.ts — small bounded tasks on a small local model, never the cloud.
 *
 * `helperComplete({ task, input, maxTokens, timeoutMs })` sends one short prompt
 * to the first usable model of `helper.models` (default: apple-fm on the Neural
 * Engine, then ollama qwen3:8b) and returns the text, or null on timeout, error
 * or when every model is down/busy: the caller then keeps its rule-based path.
 *
 * Low priority by construction: at most ONE helper request in flight in this
 * process, a short total timeout (default 20 s), small inputs (truncated to fit
 * the 8k window), and a router-served model is requested with
 * `x-pai-priority: low` so the router's scheduler serves any normal/high request
 * first. A model that failed or timed out is skipped for a cool-down. Nothing
 * here detects or coordinates with other users of the Neural Engine.
 *
 * Every call appends one line to <workers log dir>/helper-calls.jsonl; the
 * cockpit models card reads it (requests/hour, median latency, fallbacks).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Worker, receiveMessageOnPort, MessageChannel } from "node:worker_threads";
import { loadConfig } from "../daemon/config.js";
import { isLocalProvider, readWorkersSection } from "./config.js";
import { workersLogDir } from "./paths.js";
import { readSchedFile } from "../router/scheduler.js";

export interface HelperConfig {
  enabled: boolean;
  /** Ordered: a provider name served by the router ("apple-fm") or "ollama:<model>". */
  models: string[];
  /** Opt in: a provider that is a main worker model (no `role: helper`) may serve side jobs. Default false. */
  allowMain: boolean;
  /** Per-use model list override (`helper.uses.<use>.models`), keyed by use label or switch name. */
  useModels: Record<string, string[]>;
  timeoutMs: number;
  maxInputChars: number;
  ollamaUrl: string;
  /** Per-use switches. */
  uses: { toolErrors: boolean; tldr: boolean; gateSummary: boolean; routeClass: boolean; reportCheck: boolean };
}

/** In a models list: every enabled local provider of workers.yaml marked `role: helper`. */
export const HELPER_ROLE = "@helper";
/** In a models list: the legacy small default ollama:qwen3:8b, only when that Ollama model is installed here. */
export const HELPER_LEGACY = "@legacy";
const LEGACY_SPEC = "ollama:qwen3:8b";

function legacyInstalled(deps: HelperDeps): boolean {
  if (deps.ollamaInstalled) return deps.ollamaInstalled("qwen3:8b");
  try {
    return existsSync(join(process.env.OLLAMA_MODELS ?? join(homedir(), ".ollama", "models"), "manifests", "registry.ollama.ai", "library", "qwen3", "8b"));
  } catch {
    return false;
  }
}
/** Use label of a helper call -> its `helper.uses` switch name. */
const USE_KEY: Record<string, string> = { alert: "toolErrors", tldr: "tldr", gate: "gateSummary", route: "routeClass", report: "reportCheck", topic: "topic", "topic-shift": "topic-shift" };

export const DEFAULT_HELPER: HelperConfig = {
  enabled: true,
  models: ["apple-fm", HELPER_ROLE, HELPER_LEGACY],
  allowMain: false,
  useModels: {},
  timeoutMs: 20_000,
  maxInputChars: 6000,
  ollamaUrl: "http://127.0.0.1:11434",
  uses: { toolErrors: true, tldr: true, gateSummary: true, routeClass: true, reportCheck: true },
};

export function helperConfig(raw?: unknown): HelperConfig {
  let r = raw;
  if (r === undefined) {
    try {
      r = (loadConfig() as unknown as { helper?: unknown }).helper;
    } catch {
      r = undefined;
    }
  }
  const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
  const u = (o.uses && typeof o.uses === "object" ? o.uses : {}) as Record<string, unknown>;
  const strList = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((m): m is string => typeof m === "string" && !!m) : undefined);
  const useModels: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(u)) {
    const l = v && typeof v === "object" ? strList((v as Record<string, unknown>).models) : undefined;
    if (l) useModels[k] = l;
  }
  const useOn = (k: string): boolean => (u[k] && typeof u[k] === "object" ? bool((u[k] as Record<string, unknown>).enabled, true) : bool(u[k], true));
  const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d);
  const bool = (v: unknown, d: boolean): boolean => (typeof v === "boolean" ? v : d);
  return {
    enabled: bool(o.enabled, DEFAULT_HELPER.enabled),
    models: strList(o.models) ?? DEFAULT_HELPER.models,
    allowMain: bool(o.allowMain, false),
    useModels,
    timeoutMs: num(o.timeoutMs, DEFAULT_HELPER.timeoutMs),
    maxInputChars: num(o.maxInputChars, DEFAULT_HELPER.maxInputChars),
    ollamaUrl: typeof o.ollamaUrl === "string" && o.ollamaUrl ? o.ollamaUrl : DEFAULT_HELPER.ollamaUrl,
    uses: {
      toolErrors: useOn("toolErrors"),
      tldr: useOn("tldr"),
      gateSummary: useOn("gateSummary"),
      routeClass: useOn("routeClass"),
      reportCheck: useOn("reportCheck"),
    },
  };
}

export interface HelperRequest {
  /** What to do with the input: the instruction, one or two sentences. */
  task: string;
  input: string;
  maxTokens?: number;
  timeoutMs?: number;
  /** Which end of an over-long input survives; logs keep the tail (default), prose the head. */
  keep?: "tail" | "head";
  /** Metrics label of the use ("alert", "tldr", "gate"). */
  label?: string;
}

/** The wire request of one model attempt. */
export interface WireRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  kind: "messages" | "ollama";
}

export interface HelperDeps {
  config?: HelperConfig;
  logDir?: string;
  now?: () => number;
  /** fetch-like transport (tests mock the model here). */
  fetch?: (w: WireRequest, timeoutMs: number) => Promise<string>;
  /** Router base URL (default: loopback router port). */
  routerUrl?: string;
  /** Whether a provider name is a local one the router may serve (default: workers config). */
  routerModel?: (name: string) => string | null;
  /** Whether a router-served model is busy with a foreign request (default: the router's scheduler snapshot). */
  busy?: (name: string) => boolean;
  /** workers.yaml providers as name -> role (default: the workers config). */
  /** Whether an Ollama model tag is installed (default: its manifest exists under ~/.ollama). */
  ollamaInstalled?: (tag: string) => boolean;
  providerRoles?: () => Record<string, "main" | "helper">;
}

const SYSTEM = "You do one small bounded task. Answer exactly as instructed, plain text, no preface, no markdown.";
const COOLDOWN_MS = 60_000;
const coolUntil = new Map<string, number>();
let inflight: Promise<unknown> = Promise.resolve();

/** Keep at most `max` chars of `s`: the tail (logs) or the head, with a marker where the cut is. */
export function truncateInput(s: string, max: number, keep: "tail" | "head" = "tail"): string {
  if (s.length <= max) return s;
  const mark = "[...truncated...]";
  return keep === "tail" ? `${mark}\n${s.slice(s.length - max)}` : `${s.slice(0, max)}\n${mark}`;
}

function logDirOf(deps: HelperDeps): string | null {
  if (deps.logDir) return deps.logDir;
  try {
    return workersLogDir(readWorkersSection().workers);
  } catch {
    return null;
  }
}

export const HELPER_CALLS_FILE = "helper-calls.jsonl";

/** Why a helper call failed: the cockpit and the audit read it off the log line. */
export type HelperFailKind = "timeout" | "error" | "empty" | "rejected" | "busy-fallback" | "skipped-short";
// "skipped-short" is logged ok:true: no model call was needed (input already short).

export interface HelperCall {
  ts: number;
  model: string;
  label: string;
  ms: number;
  /** false: the caller fell back to its rules (timeout, error, down, or an answer it could not use). */
  ok: boolean;
  /** Set when ok is false: what failed (HelperFailKind). Absent on older lines. */
  kind?: HelperFailKind;
  /** Rejected calls: why the caller could not use the answer, and a short excerpt of it. */
  reason?: string;
  sample?: string;
}

export function recordHelperCall(c: HelperCall, deps: HelperDeps = {}): void {
  const dir = logDirOf(deps);
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, HELPER_CALLS_FILE), JSON.stringify(c) + "\n");
  } catch {
    /* metrics never fail a call */
  }
}

/** A caller could not use the helper's answer ("rejected"): counts as a fallback. */
export function helperRejected(label: string, model: string, deps: HelperDeps = {}, why?: { reason: string; text?: string | null }): void {
  const sample = why?.text ? why.text.replace(/\s+/g, " ").trim().slice(0, 120) : undefined;
  recordHelperCall({ ts: (deps.now ?? Date.now)(), model, label, ms: 0, ok: false, kind: "rejected", ...(why ? { reason: why.reason } : {}), ...(sample ? { sample } : {}) }, deps);
}

/** Router-served engine busy with a request that is not ours (a batch job holds every slot): helper calls skip it at once. */
function engineBusy(spec: string, deps: HelperDeps): boolean {
  if (deps.busy) return deps.busy(spec);
  try {
    const snap = readSchedFile(workersLogDir(readWorkersSection().workers));
    if (!snap) return false;
    const keys = Object.keys(snap.engines).filter((k) => k.replace(/#\d+$/, "").trim() === spec);
    if (!keys.length) return false;
    // busy only when no instance has a free slot and a foreign request holds one
    return keys.every((k) => {
      const e = snap.engines[k];
      const flights = e.flights ?? (e.inflight ? [e.inflight] : []);
      return flights.length >= (e.slots ?? 1) && flights.some((f) => f.worker !== "pai-helper");
    });
  } catch {
    return false;
  }
}

/** timeout / error from a thrown transport failure; empty when the model answered with nothing usable. */
function failKind(e: unknown): HelperFailKind {
  const m = e instanceof Error ? e.message : String(e);
  return /abort|timeout|timed[- ]out/i.test(m) ? "timeout" : "error";
}

export interface HelperStats {
  /** Per model: requests in the last hour, median latency of the answered ones (ms), fallbacks. */
  models: Record<string, { perHour: number; medianMs: number | null; fallbacks: number }>;
}

export function helperStats(deps: HelperDeps = {}): HelperStats {
  const dir = logDirOf(deps);
  const out: HelperStats = { models: {} };
  if (!dir) return out;
  const file = join(dir, HELPER_CALLS_FILE);
  try {
    if (!existsSync(file) || statSync(file).size > 20_000_000) return out;
    const since = (deps.now ?? Date.now)() - 3_600_000;
    const lat: Record<string, number[]> = {};
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      let c: HelperCall;
      try {
        c = JSON.parse(line) as HelperCall;
      } catch {
        continue;
      }
      if (c.ts < since) continue;
      const m = (out.models[c.model] ??= { perHour: 0, medianMs: null, fallbacks: 0 });
      if (c.kind === "skipped-short") continue;
      if (c.ms > 0 || c.ok) m.perHour += 1;
      if (!c.ok) m.fallbacks += 1;
      else (lat[c.model] ??= []).push(c.ms);
    }
    for (const [k, v] of Object.entries(lat)) {
      v.sort((a, b) => a - b);
      out.models[k].medianMs = v[Math.floor(v.length / 2)] ?? null;
    }
  } catch {
    /* none */
  }
  return out;
}

/** Router-served entry: the concrete model id when `name` is a local provider, else null (never cloud). */
function localRouterModel(name: string): string | null {
  try {
    const p = readWorkersSection().workers.providers[name];
    if (!p || p.enabled === false || !isLocalProvider(p.baseUrl)) return null;
    return p.models.default || null;
  } catch {
    return null;
  }
}

function wireFor(spec: string, req: HelperRequest, prompt: string, cfg: HelperConfig, deps: HelperDeps): WireRequest | null {
  const maxTokens = req.maxTokens ?? 200;
  if (spec.startsWith("ollama:")) {
    return {
      url: `${cfg.ollamaUrl.replace(/\/$/, "")}/api/chat`,
      headers: { "content-type": "application/json" },
      kind: "ollama",
      body: JSON.stringify({
        model: spec.slice("ollama:".length),
        stream: false,
        think: false,
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }],
        options: { num_predict: maxTokens, temperature: 0 },
      }),
    };
  }
  const model = (deps.routerModel ?? localRouterModel)(spec);
  if (!model) return null; // not a local provider: skipped, never cloud
  let base = deps.routerUrl;
  if (!base) {
    try {
      base = `http://127.0.0.1:${loadConfig().router.port}`;
    } catch {
      base = "http://127.0.0.1:8790";
    }
  }
  return {
    url: `${base}/v1/messages`,
    headers: { "content-type": "application/json", "x-pai-priority": "low", "x-pai-session": "pai-helper", "x-pai-worker": "pai-helper" },
    kind: "messages",
    body: JSON.stringify({ model, max_tokens: maxTokens, temperature: 0, system: SYSTEM, messages: [{ role: "user", content: prompt }] }),
  };
}

function textOf(kind: WireRequest["kind"], raw: string): string | null {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    let t = "";
    if (kind === "ollama") t = String((j.message as { content?: string } | undefined)?.content ?? "");
    else t = ((j.content as { type: string; text?: string }[] | undefined) ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    t = t.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    return t || null;
  } catch {
    return null;
  }
}

async function fetchWire(w: WireRequest, timeoutMs: number): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(w.url, { method: "POST", headers: w.headers, body: w.body, signal: ac.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

const WORKER_SRC = `
const { workerData } = require("node:worker_threads");
const { url, headers, body, timeoutMs, port, flag } = workerData;
const done = (m) => { port.postMessage(m); Atomics.store(flag, 0, 1); Atomics.notify(flag, 0); };
fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(timeoutMs) })
  .then(async (r) => { if (!r.ok) throw new Error("HTTP " + r.status); done({ ok: true, text: await r.text() }); })
  .catch((e) => done({ ok: false, error: String(e && e.message || e) }));
`;

/** Blocking transport for sync callers (merge gates): a worker thread fetches while this thread waits on a flag. */
function fetchWireSync(w: WireRequest, timeoutMs: number): string {
  const { port1, port2 } = new MessageChannel();
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(WORKER_SRC, { eval: true, workerData: { ...w, timeoutMs, port: port2, flag }, transferList: [port2] });
  try {
    if (Atomics.wait(flag, 0, 0, timeoutMs + 1000) === "timed-out") throw new Error("timeout");
    const m = receiveMessageOnPort(port1)?.message as { ok: boolean; text?: string; error?: string } | undefined;
    if (!m?.ok) throw new Error(m?.error ?? "no answer");
    return m.text ?? "";
  } finally {
    void worker.terminate();
    port1.close();
  }
}

interface Plan {
  prompt: string;
  cfg: HelperConfig;
  specs: string[];
  start: number;
}

function plan(req: HelperRequest, deps: HelperDeps): Plan | null {
  // a test run never reaches a real model unless the test hands in its own config and transport
  if (!deps.config && process.env.VITEST) return null;
  const cfg = deps.config ?? helperConfig();
  if (!cfg.enabled) return null;
  const prompt = `${req.task}\n\n---\n${truncateInput(req.input, cfg.maxInputChars, req.keep ?? "tail")}`;
  return { prompt, cfg, specs: resolveHelperSpecs(req.label ?? "", cfg, deps).specs, start: (deps.now ?? Date.now)() };
}

function providerRoles(deps: HelperDeps): Record<string, "main" | "helper"> {
  if (deps.providerRoles) return deps.providerRoles();
  try {
    const out: Record<string, "main" | "helper"> = {};
    for (const [n, p] of Object.entries(readWorkersSection().workers.providers)) {
      if (p.enabled !== false) out[n] = p.role === "helper" ? "helper" : "main";
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * The ordered model specs one use may try: the use's own list, else `helper.models`. `@helper` expands to
 * the `role: helper` providers; `ollama:<model>` is the user's explicit small model; apple-fm is the
 * built-in helper; any other provider only with `role: helper`, or when `allowMain` is set. A main
 * worker model never serves a side job by default (a context swap or slot taken just to classify).
 */
export function resolveHelperSpecs(label: string, cfg: HelperConfig, deps: HelperDeps = {}): { specs: string[]; refused: string[] } {
  const key = USE_KEY[label] ?? label;
  const list = cfg.useModels[label] ?? cfg.useModels[key] ?? cfg.models;
  const roles = providerRoles(deps);
  const specs: string[] = [];
  const refused: string[] = [];
  const add = (s: string): void => {
    if (!specs.includes(s)) specs.push(s);
  };
  for (const m of list) {
    if (m === HELPER_ROLE) {
      for (const [n, r] of Object.entries(roles)) if (r === "helper") add(n);
    } else if (m === HELPER_LEGACY) {
      if (legacyInstalled(deps)) add(LEGACY_SPEC);
    } else if (m.startsWith("ollama:") || m === "apple-fm" || roles[m] === "helper" || cfg.allowMain) add(m);
    else refused.push(m);
  }
  return { specs, refused };
}

function usable(spec: string, now: number): boolean {
  return (coolUntil.get(spec) ?? 0) <= now;
}

/** Async: waits behind this process's own earlier helper request (at most one in flight). */
export async function helperComplete(req: HelperRequest, deps: HelperDeps = {}): Promise<string | null> {
  const p = plan(req, deps);
  if (!p) return null;
  const prev = inflight;
  let release!: () => void;
  inflight = new Promise<void>((r) => (release = r));
  try {
    await prev.catch(() => undefined);
    return await run(p, req, deps, (w, t) => (deps.fetch ?? fetchWire)(w, t));
  } finally {
    release();
  }
}

/** Sync twin for callers that cannot await (merge gate); blocks at most the helper timeout. */
export function helperCompleteSync(req: HelperRequest, deps: HelperDeps = {}): string | null {
  const p = plan(req, deps);
  if (!p) return null;
  let out: string | null = null;
  const budget = p.cfg.timeoutMs;
  const deadline = p.start + budget;
  const now = deps.now ?? Date.now;
  for (let i = 0; i < p.specs.length && !out; i++) {
    const spec = p.specs[i];
    if (!usable(spec, now())) continue;
    const w = wireFor(spec, req, p.prompt, p.cfg, deps);
    if (!w) continue;
    const t0 = now();
    if (w.kind === "messages" && engineBusy(spec, deps)) {
      recordHelperCall({ ts: t0, model: spec, label: req.label ?? "", ms: 0, ok: false, kind: "busy-fallback" }, deps);
      continue;
    }
    const per = attemptBudget(deadline - t0, p.specs.length - i);
    if (per < 500) break;
    try {
      const text = textOf(w.kind, fetchWireSync(w, per));
      recordHelperCall({ ts: t0, model: spec, label: req.label ?? "", ms: now() - t0, ok: !!text, ...(text ? {} : { kind: "empty" as const }) }, deps);
      if (text) out = text;
    } catch (e) {
      coolUntil.set(spec, now() + COOLDOWN_MS);
      recordHelperCall({ ts: t0, model: spec, label: req.label ?? "", ms: now() - t0, ok: false, kind: failKind(e) }, deps);
    }
  }
  return out;
}

/**
 * Share of the remaining budget one attempt may use: the first model of several leaves room
 * for the next. The Neural Engine answers a short prompt in a median 2.5 s but p90 5.9 s
 * (measured over 200 TL;DR calls), so it gets 60% of the budget, not an even share: at an
 * even split a 8 s call gave it 5 s and cut off one answer in three that was still coming.
 */
function attemptBudget(remaining: number, modelsLeft: number): number {
  return modelsLeft > 1 ? Math.max(5000, Math.floor((remaining * 3) / 5)) : remaining;
}

async function run(p: Plan, req: HelperRequest, deps: HelperDeps, send: (w: WireRequest, t: number) => Promise<string>): Promise<string | null> {
  const now = deps.now ?? Date.now;
  const deadline = p.start + (req.timeoutMs ?? p.cfg.timeoutMs);
  for (let i = 0; i < p.specs.length; i++) {
    const spec = p.specs[i];
    if (!usable(spec, now())) continue;
    const w = wireFor(spec, req, p.prompt, p.cfg, deps);
    if (!w) continue;
    const t0 = now();
    if (w.kind === "messages" && engineBusy(spec, deps)) {
      recordHelperCall({ ts: t0, model: spec, label: req.label ?? "", ms: 0, ok: false, kind: "busy-fallback" }, deps);
      continue;
    }
    const per = attemptBudget(deadline - t0, p.specs.length - i);
    if (per < 500) break;
    try {
      const text = textOf(w.kind, await send(w, per));
      recordHelperCall({ ts: t0, model: spec, label: req.label ?? "", ms: now() - t0, ok: !!text, ...(text ? {} : { kind: "empty" as const }) }, deps);
      if (text) return text;
    } catch (e) {
      // down, busy behind a normal-priority request (timed out) or failed: skip it for a while
      coolUntil.set(spec, now() + COOLDOWN_MS);
      recordHelperCall({ ts: t0, model: spec, label: req.label ?? "", ms: now() - t0, ok: false, kind: failKind(e) }, deps);
    }
  }
  return null;
}

/** Test seam: forget cool-downs. */
export function resetHelperState(): void {
  coolUntil.clear();
  inflight = Promise.resolve();
}

/** Side-job uses (labels) that resolve a helper model. */
export const HELPER_USES = ["alert", "tldr", "gate", "route", "report", "topic", "topic-shift"] as const;

/** Specs of a use that exist here: ollama:<m> entries and providers configured in workers.yaml (apple-fm only where its bridge is configured). */
export function configuredHelperSpecs(label: string, cfg: HelperConfig, deps: HelperDeps = {}): string[] {
  const roles = providerRoles(deps);
  return resolveHelperSpecs(label, cfg, deps).specs.filter((s) => s.startsWith("ollama:") || s in roles);
}

/** Setup/doctor warning: no helper model at all (no apple-fm, no `role: helper` provider, no ollama entry). Null when fine or helpers are off. */
export function helperSetupWarning(cfg: HelperConfig = helperConfig(), deps: HelperDeps = {}): string | null {
  if (!cfg.enabled || HELPER_USES.some((u) => configuredHelperSpecs(u, cfg, deps).length)) return null;
  return "no helper model: apple-fm is absent and no provider has `role: helper` in workers.yaml, so route classifier, TL;DR, topic and alert checks run on rules only. Add a small instruct model (0.6-4B, Ollama / llama.cpp / MLX) as a provider with `role: helper`; see docs/local-models/helper-model.md";
}

/** `pai worker helper-check`: which helper model each use resolves to, and why a listed one was refused. */
export function helperReport(cfg: HelperConfig = helperConfig(), deps: HelperDeps = {}): string[] {
  if (!cfg.enabled) return ["helper: off (helper.enabled: false)"];
  const lines = [`helper models: ${cfg.models.join(", ")}${cfg.allowMain ? "  (allowMain: on)" : ""}`];
  for (const u of HELPER_USES) {
    const list = configuredHelperSpecs(u, cfg, deps);
    const refused = resolveHelperSpecs(u, cfg, deps).refused;
    lines.push(`  ${u.padEnd(7)} ${list.length ? list.join(" > ") : "none (rules only)"}${refused.length ? `   refused (main model, set role: helper or helper.allowMain): ${refused.join(", ")}` : ""}`);
  }
  const w = helperSetupWarning(cfg, deps);
  if (w) lines.push(`warning: ${w}`);
  return lines;
}
