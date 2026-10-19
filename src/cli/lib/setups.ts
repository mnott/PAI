/**
 * Setups: which model orchestrates a session and which provider the worker
 * classes run on. Built-in setups are derived from the configured providers;
 * the user can save the current combination under a name.
 *
 * Pure functions here; the saved file path is a parameter so tests use a temp dir.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { paiHomePath } from "../../config/pai-home.js";
import {
  ANTHROPIC_NATIVE,
  getProviderOrNative,
  type WorkersConfig,
} from "../../workers/config.js";
import { isLoopbackProvider } from "../../workers/run-env.js";
import { stripModelVariant } from "../../utils/model-window.js";

export interface Setup {
  name: string;
  orchestrator: { provider: string; model?: string };
  /** Provider the worker classes run on. */
  workers: string;
  kind: "last" | "builtin" | "saved";
  /** The one "local workers" row: Workers column reads "<provider> (local)". */
  local?: true;
}

/** The chat on the Anthropic plan runs the operator's chat model (Opus); worker models are a separate choice. */
const NATIVE_ORCHESTRATOR = { provider: ANTHROPIC_NATIVE, model: "opus" };

export const setupsPath =() => paiHomePath("setups.json");

/** "claude-opus-5-5" -> "opus-5.5"; "glm-5.3[1m]" -> "glm-5.3". */
export function shortModel(model: string | undefined): string {
  if (!model) return "default";
  const m = stripModelVariant(model);
  const c = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(m);
  return c ? `${c[1]}-${c[2]}.${c[3]}` : m.replace(/^claude-/, "");
}

type Cfg = Pick<WorkersConfig, "providers" | "active" | "nativeModels">;

/** Display label for a provider's worker role, e.g. "glm-fast (glm)". */
export function workersLabel(cfg: Cfg, provider: string): string {
  const p = getProviderOrNative(cfg, provider);
  const fast = p?.models.fast;
  if (provider === ANTHROPIC_NATIVE) return "anthropic (haiku)";
  return fast && fast !== p?.models.default ? `${provider}-fast (${provider})` : `${provider} (${provider})`;
}

export function orchestratorLabel(cfg: Cfg, o: Setup["orchestrator"]): string {
  const model = o.model ?? getProviderOrNative(cfg, o.provider)?.models.default;
  return `${shortModel(model)} (${o.provider})`;
}

/** True when a model server answers at host:port within timeoutMs. */
export type PortCheck = (host: string, port: number, timeoutMs: number) => Promise<boolean>;

/**
 * A model server is running when GET /v1/models answers 2xx with a JSON body.
 * A bare TCP connect reported ports as running that no model server answered.
 */
export const httpModelsCheck: PortCheck = async (host, port, timeoutMs) => {
  try {
    const h = host.includes(":") ? `[${host}]` : host;
    const res = await fetch(`http://${h}:${port}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    await res.json();
    return true;
  } catch {
    return false;
  }
};

export const PORT_TIMEOUT_MS = 500;

/** Enabled loopback providers whose server does not answer now; all checked in parallel. */
export async function downLocalProviders(cfg: Cfg, check: PortCheck = httpModelsCheck): Promise<Set<string>> {
  const local = Object.entries(cfg.providers).filter(([, p]) => p.enabled && isLoopbackProvider(p));
  const down = new Set<string>();
  await Promise.all(
    local.map(async ([n, p]) => {
      let ok = false;
      try {
        const u = new URL(p.baseUrl);
        const host = u.hostname.replace(/^\[|\]$/g, "");
        ok = await check(host, Number(u.port) || (u.protocol === "https:" ? 443 : 80), PORT_TIMEOUT_MS);
      } catch {
        ok = false;
      }
      if (!ok) down.add(n);
    })
  );
  return down;
}

const PRIORITY = ["glm", "kimi"];

/**
 * Built-in setups from what is configured and enabled. Local (loopback)
 * providers answering now collapse into ONE "anthropic + local workers" row on
 * `resolved` (resolveLocalProvider's pick; the first running one when absent),
 * plus one row per further running provider on a different server URL.
 */
export function builtinSetups(cfg: Cfg, down: ReadonlySet<string> = new Set(), resolved?: string): Setup[] {
  const enabled = (n: string) => n === ANTHROPIC_NATIVE || !!cfg.providers[n]?.enabled;
  const out: Setup[] = [{ name: "anthropic only", orchestrator: NATIVE_ORCHESTRATOR, workers: ANTHROPIC_NATIVE, kind: "builtin" }];
  const names = [...PRIORITY, ...(cfg.active && cfg.active !== "auto" && !PRIORITY.includes(cfg.active) && cfg.active !== ANTHROPIC_NATIVE ? [cfg.active] : [])].filter(enabled);
  const remote = names.filter((n) => !isLoopbackProvider(cfg.providers[n]));
  for (const n of remote) {
    out.push({ name: `anthropic + ${n} workers`, orchestrator: NATIVE_ORCHESTRATOR, workers: n, kind: "builtin" });
  }
  // Running local (loopback) providers: workers only. A local orchestrator is not a default.
  const up = Object.entries(cfg.providers).filter(([n, p]) => p.enabled && isLoopbackProvider(p) && !down.has(n));
  if (up.length) {
    const pick = up.find(([n]) => n === resolved) ?? up[0];
    out.push({ name: "anthropic + local workers", orchestrator: NATIVE_ORCHESTRATOR, workers: pick[0], kind: "builtin", local: true });
    const urls = new Set([pick[1].baseUrl]);
    for (const [n, p] of up) {
      if (urls.has(p.baseUrl)) continue;
      urls.add(p.baseUrl);
      out.push({ name: `anthropic + ${n} workers`, orchestrator: NATIVE_ORCHESTRATOR, workers: n, kind: "builtin" });
    }
  }
  for (const n of names) if (!isLoopbackProvider(cfg.providers[n])) out.push({ name: `${n} only`, orchestrator: { provider: n }, workers: n, kind: "builtin" });
  return out;
}

export function loadSaved(path = setupsPath()): Setup[] {
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, Omit<Setup, "name" | "kind">>;
    return Object.entries(data).map(([name, s]) => ({ name, orchestrator: s.orchestrator, workers: s.workers, kind: "saved" as const }));
  } catch {
    return [];
  }
}

export function saveSetup(setup: Omit<Setup, "kind">, path = setupsPath()): void {
  const data: Record<string, unknown> = {};
  for (const s of loadSaved(path)) data[s.name] = { orchestrator: s.orchestrator, workers: s.workers };
  data[setup.name] = { orchestrator: setup.orchestrator, workers: setup.workers };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, path);
}

/** "Last time" first (kept even if its provider is down), then saved, then built-in; setups on a down local provider are dropped; duplicates of Last time kept (they have names). */
export function allSetups(cfg: Cfg, last: Setup | null, saved: Setup[], down: ReadonlySet<string> = new Set(), resolved?: string): Setup[] {
  return [...(last ? [last] : []), ...saved.filter((s) => !down.has(s.workers)), ...builtinSetups(cfg, down, resolved)];
}

/** Find a setup by exact name (case-insensitive), else unique prefix. */
export function findSetup(setups: Setup[], query: string): Setup | null {
  const q = query.toLowerCase().trim();
  const exact = setups.find((s) => s.name.toLowerCase() === q);
  if (exact) return exact;
  const pre = setups.filter((s) => s.name.toLowerCase().startsWith(q));
  return pre.length === 1 ? pre[0] : null;
}

export const sessionWorkersPath = () => paiHomePath("session-workers.json");

/** Worker provider a session was last started with, by session name; null when never recorded. */
export function recordedWorkers(name: string, path = sessionWorkersPath()): string | null {
  try {
    const v = (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)[name];
    return typeof v === "string" && v ? v : null;
  } catch {
    return null;
  }
}

export function recordWorkers(name: string, workers: string, path = sessionWorkersPath()): void {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    // first record
  }
  data[name] = workers;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, path);
}
