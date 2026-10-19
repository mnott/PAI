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
}

export const setupsPath = () => paiHomePath("setups.json");

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

const PRIORITY = ["glm", "kimi"];

/** Built-in setups from what is configured and enabled. */
export function builtinSetups(cfg: Cfg): Setup[] {
  const enabled = (n: string) => n === ANTHROPIC_NATIVE || !!cfg.providers[n]?.enabled;
  const out: Setup[] = [{ name: "anthropic only", orchestrator: { provider: ANTHROPIC_NATIVE }, workers: ANTHROPIC_NATIVE, kind: "builtin" }];
  const names = [...PRIORITY, ...(cfg.active && cfg.active !== "auto" && !PRIORITY.includes(cfg.active) && cfg.active !== ANTHROPIC_NATIVE ? [cfg.active] : [])].filter(enabled);
  for (const n of names) {
    out.push({ name: `anthropic + ${n} workers`, orchestrator: { provider: ANTHROPIC_NATIVE }, workers: n, kind: "builtin" });
  }
  // Enabled local (loopback) providers: workers only. A local orchestrator is not a default.
  for (const [n, p] of Object.entries(cfg.providers)) {
    if (p.enabled && !names.includes(n) && isLoopbackProvider(p)) {
      out.push({ name: `anthropic + ${n} workers`, orchestrator: { provider: ANTHROPIC_NATIVE }, workers: n, kind: "builtin" });
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

/** "Last time" first, then saved, then built-in; duplicates of Last time kept (they have names). */
export function allSetups(cfg: Cfg, last: Setup | null, saved: Setup[]): Setup[] {
  return [...(last ? [last] : []), ...saved, ...builtinSetups(cfg)];
}

/** Find a setup by exact name (case-insensitive), else unique prefix. */
export function findSetup(setups: Setup[], query: string): Setup | null {
  const q = query.toLowerCase().trim();
  const exact = setups.find((s) => s.name.toLowerCase() === q);
  if (exact) return exact;
  const pre = setups.filter((s) => s.name.toLowerCase().startsWith(q));
  return pre.length === 1 ? pre[0] : null;
}
