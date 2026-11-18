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
import { join } from "node:path";
import { Worker, receiveMessageOnPort, MessageChannel } from "node:worker_threads";
import { loadConfig } from "../daemon/config.js";
import { isLocalProvider, readWorkersSection } from "./config.js";
import { workersLogDir } from "./paths.js";

export interface HelperConfig {
  enabled: boolean;
  /** Ordered: a provider name served by the router ("apple-fm") or "ollama:<model>". */
  models: string[];
  timeoutMs: number;
  maxInputChars: number;
  ollamaUrl: string;
  /** Per-use switches. */
  uses: { toolErrors: boolean; tldr: boolean; gateSummary: boolean };
}

export const DEFAULT_HELPER: HelperConfig = {
  enabled: true,
  models: ["apple-fm", "ollama:qwen3:8b"],
  timeoutMs: 20_000,
  maxInputChars: 6000,
  ollamaUrl: "http://127.0.0.1:11434",
  uses: { toolErrors: true, tldr: true, gateSummary: true },
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
  const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d);
  const bool = (v: unknown, d: boolean): boolean => (typeof v === "boolean" ? v : d);
  return {
    enabled: bool(o.enabled, DEFAULT_HELPER.enabled),
    models: Array.isArray(o.models) ? o.models.filter((m): m is string => typeof m === "string" && !!m) : DEFAULT_HELPER.models,
    timeoutMs: num(o.timeoutMs, DEFAULT_HELPER.timeoutMs),
    maxInputChars: num(o.maxInputChars, DEFAULT_HELPER.maxInputChars),
    ollamaUrl: typeof o.ollamaUrl === "string" && o.ollamaUrl ? o.ollamaUrl : DEFAULT_HELPER.ollamaUrl,
    uses: {
      toolErrors: bool(u.toolErrors, true),
      tldr: bool(u.tldr, true),
      gateSummary: bool(u.gateSummary, true),
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

export interface HelperCall {
  ts: number;
  model: string;
  label: string;
  ms: number;
  /** false: the caller fell back to its rules (timeout, error, down, or an answer it could not use). */
  ok: boolean;
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

/** A caller could not use the helper's answer: counts as a fallback. */
export function helperRejected(label: string, model: string, deps: HelperDeps = {}): void {
  recordHelperCall({ ts: (deps.now ?? Date.now)(), model, label, ms: 0, ok: false }, deps);
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
  return { prompt, cfg, specs: cfg.models, start: (deps.now ?? Date.now)() };
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
    const per = attemptBudget(deadline - t0, p.specs.length - i);
    if (per < 500) break;
    try {
      const text = textOf(w.kind, fetchWireSync(w, per));
      recordHelperCall({ ts: t0, model: spec, label: req.label ?? "", ms: now() - t0, ok: !!text }, deps);
      if (text) out = text;
    } catch {
      coolUntil.set(spec, now() + COOLDOWN_MS);
      recordHelperCall({ ts: t0, model: spec, label: req.label ?? "", ms: now() - t0, ok: false }, deps);
    }
  }
  return out;
}

/** Share of the remaining budget one attempt may use: the first model of several leaves room for the next. */
function attemptBudget(remaining: number, modelsLeft: number): number {
  return modelsLeft > 1 ? Math.max(5000, Math.floor(remaining / modelsLeft)) : remaining;
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
    const per = attemptBudget(deadline - t0, p.specs.length - i);
    if (per < 500) break;
    try {
      const text = textOf(w.kind, await send(w, per));
      recordHelperCall({ ts: t0, model: spec, label: req.label ?? "", ms: now() - t0, ok: !!text }, deps);
      if (text) return text;
    } catch {
      // down, busy behind a normal-priority request (timed out) or failed: skip it for a while
      coolUntil.set(spec, now() + COOLDOWN_MS);
      recordHelperCall({ ts: t0, model: spec, label: req.label ?? "", ms: now() - t0, ok: false }, deps);
    }
  }
  return null;
}

/** Test seam: forget cool-downs. */
export function resetHelperState(): void {
  coolUntil.clear();
  inflight = Promise.resolve();
}
