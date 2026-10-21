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
  nativeOrchestratorModel,
} from "../../workers/config.js";
import { isLoopbackProvider } from "../../workers/run-env.js";
import { probeServedModels, serves } from "../../workers/served-models.js";
import { stripModelVariant } from "../../utils/model-window.js";

export interface Setup {
  name: string;
  orchestrator: { provider: string; model?: string };
  /** Provider the worker classes run on. */
  workers: string;
  /** Worker model: "fast" or a model id. Absent = what workersModel() derives for the provider; the Workers column and the written profile both read it. */
  workersModel?: string;
  kind: "last" | "builtin" | "saved";
  /** The one "local workers" row: Workers column reads "<provider> (local)". */
  local?: true;
}

/** The chat on the Anthropic plan runs the login's chat model (models.orchestrator of the built-in provider); worker models are a separate choice. */
const nativeOrchestrator = () => ({ provider: ANTHROPIC_NATIVE, model: nativeOrchestratorModel() });

export const setupsPath =() => paiHomePath("setups.json");

/** "claude-opus-5-5" -> "opus-5.5"; "glm-5.3[1m]" -> "glm-5.3". */
export function shortModel(model: string | undefined): string {
  if (!model) return "default";
  const m = stripModelVariant(model);
  const c = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(m);
  return c ? `${c[1]}-${c[2]}.${c[3]}` : m.replace(/^claude-/, "");
}

type Cfg = Pick<WorkersConfig, "providers" | "active" | "nativeModels">;

/** The worker model a provider's setup row shows (and writes): "fast" when the provider has a distinct fast model, else the provider default (undefined). An explicit row model (workersModel on the Setup) overrides this. */
export function workersModel(cfg: Cfg, provider: string): string | undefined {
  if (provider === ANTHROPIC_NATIVE) return undefined;
  const m = getProviderOrNative(cfg, provider)?.models;
  return m?.fast && m.fast !== m.default ? "fast" : undefined;
}

/**
 * Display label for a provider's worker role: the model the resolver will
 * actually use, named — "sonnet (anthropic)" / "haiku (anthropic)" for the
 * native tiers, "glm-fast (glm)" for a provider's fast model, "<model>
 * (<provider>)" for a written model.
 */
export function workersLabel(cfg: Cfg, provider: string, model?: string): string {
  const p = getProviderOrNative(cfg, provider);
  const tier = model === "fast" ? "fast" : model ? undefined : workersModel(cfg, provider);
  const named = tier ? p?.models[tier] : p?.models.default;
  if (named) return `${named} (${provider})`;
  return model ? `${model} (${provider})` : `${provider} (${provider})`;
}

/** The Workers column of a setup row. */
export function setupWorkersLabel(cfg: Cfg, s: Setup): string {
  return s.local ? `${s.workers} (local)` : workersLabel(cfg, s.workers, s.workersModel);
}

/** The profile a chosen setup writes: exactly the provider and model its row displays, for chat and workers. */
export function setupProfile(cfg: Cfg, s: Setup): { chat: { provider: string; model?: string }; workers: { provider: string; model?: string } } {
  const chatModel = s.orchestrator.model ?? getProviderOrNative(cfg, s.orchestrator.provider)?.models.default;
  const wModel = s.workersModel ?? workersModel(cfg, s.workers);
  return {
    chat: { provider: s.orchestrator.provider, ...(chatModel ? { model: chatModel } : {}) },
    workers: { provider: s.workers, ...(wModel ? { model: wModel } : {}) },
  };
}

export function orchestratorLabel(cfg: Cfg, o: Setup["orchestrator"]): string {
  const model = o.model ?? getProviderOrNative(cfg, o.provider)?.models.default;
  return `${shortModel(model)} (${o.provider})`;
}

/**
 * True when a model server answers at host:port within timeoutMs. With `models`, it must also serve
 * one of them: several providers can share one endpoint, and only the one whose model is loaded is up.
 */
export type PortCheck = (host: string, port: number, timeoutMs: number, models?: string[]) => Promise<boolean>;

/** Every model id a provider is configured with. */
export function providerModelIds(p: { models: Record<string, unknown> }): string[] {
  return [...new Set(Object.values(p.models).filter((m): m is string => typeof m === "string" && m !== ""))];
}

/**
 * A model server is running when GET /v1/models answers 2xx with a JSON body.
 * A bare TCP connect reported ports as running that no model server answered.
 * Thin wrapper over the one probe (workers/served-models.ts) the cockpit shares.
 */
export const httpModelsCheck: PortCheck = async (host, port, timeoutMs, models) => {
  const probe = await probeServedModels(host, port, timeoutMs);
  // a server that lists no models cannot say what it serves: the endpoint decides
  return probe.alive && serves(probe.ids, models ?? []);
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
        ok = await check(host, Number(u.port) || (u.protocol === "https:" ? 443 : 80), PORT_TIMEOUT_MS, providerModelIds(p));
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
  const out: Setup[] = [
    // anthropic workers run the anthropic default (sonnet); the haiku row is the explicit cheap choice
    { name: `${ANTHROPIC_NATIVE} only`, orchestrator: nativeOrchestrator(), workers: ANTHROPIC_NATIVE, kind: "builtin" },
    { name: `${ANTHROPIC_NATIVE} + ${getProviderOrNative(cfg, ANTHROPIC_NATIVE)?.models.fast ?? "fast"} workers`, orchestrator: nativeOrchestrator(), workers: ANTHROPIC_NATIVE, workersModel: "fast", kind: "builtin" },
  ];
  const names = [...PRIORITY, ...(cfg.active && cfg.active !== "auto" && !PRIORITY.includes(cfg.active) && cfg.active !== ANTHROPIC_NATIVE ? [cfg.active] : [])].filter(enabled);
  const remote = names.filter((n) => !isLoopbackProvider(cfg.providers[n]));
  for (const n of remote) {
    out.push({ name: `anthropic + ${n} workers`, orchestrator: nativeOrchestrator(), workers: n, kind: "builtin" });
  }
  // Running local (loopback) providers: workers only. A local orchestrator is not a default.
  const up = Object.entries(cfg.providers).filter(([n, p]) => p.enabled && isLoopbackProvider(p) && !down.has(n));
  if (up.length) {
    const pick = up.find(([n]) => n === resolved) ?? up[0];
    out.push({ name: "anthropic + local workers", orchestrator: nativeOrchestrator(), workers: pick[0], kind: "builtin", local: true });
    const urls = new Set([pick[1].baseUrl]);
    for (const [n, p] of up) {
      if (urls.has(p.baseUrl)) continue;
      urls.add(p.baseUrl);
      out.push({ name: `anthropic + ${n} workers`, orchestrator: nativeOrchestrator(), workers: n, kind: "builtin" });
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
