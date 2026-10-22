/**
 * local-provider.ts — "a local worker" is resolved by PAI, never guessed by
 * a model (incident 2026-10-19: a session read `pai worker providers`, saw
 * ~15 enabled loopback providers — most with nothing listening — and picked
 * one by name). One function answers the question:
 *
 *   resolveLocalProvider()  the loopback provider to run on, or an error
 *
 * Local providers are those whose url is loopback (127.0.0.1 / localhost /
 * ::1). Each is probed on its port with the same HTTP check (GET /v1/models, 2xx with JSON) `pai setups` uses
 * to list only running local providers (cli/lib/setups.ts — one
 * implementation, imported here). Exactly one up → it. Several up → the first
 * running one in the routing tier order (the tier the worker class maps to, the
 * T2 worker tier without a class), else the one workers.yaml's top-level
 * `local:` key names (like `active:`), else the one most recently started/used
 * (its newest worker status; registry order on a tie), and the choice says
 * which. `--local <name>` picks a specific running model instead. None up → an error naming that no local model server is running.
 *
 * The value `local` is the mechanism everywhere: `pai worker run --local`,
 * the MCP delegation tools' `local: true`, and a plan's `provider: local`
 * all land here. A provider literally named "local" is NOT the mechanism —
 * resolution wins over a literal name, so the old disabled "local" entry
 * stays as it is.
 */

import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  getProviderOrNative,
  readWorkersSection,
  WorkersConfigError,
  type WorkerProvider,
  type WorkersConfig,
} from "./config.js";
import { isLoopbackProvider } from "./run-env.js";
import { readLocalConfig } from "./local-tiers.js";
import { loadStatuses } from "./status.js";
import { workersYamlPath } from "./workers-config.js";
import { workersLogDir } from "./paths.js";
import { effectiveCap } from "./capacity.js";
import { readInstances, type LocalInstance } from "./local-instances.js";
import {
  LOCAL_STATUS_REFRESH_MS,
  readLocalStatus,
  writeLocalStatus,
  type LocalStatus,
} from "./local-status.js";
import { PORT_TIMEOUT_MS, httpModelsCheck, providerModelIds, type PortCheck } from "../cli/lib/setups.js";
import { LOCAL_PROBE_TIMEOUT_MS } from "../utils/timeouts.js";

import { isLocalCandidate, tierProviderNames } from "./local-candidate.js";
import { classRoute, entryProvider, type TierDef } from "./route-lists.js";

export { PORT_TIMEOUT_MS, httpModelsCheck, type PortCheck, isLocalCandidate, tierProviderNames };

/** A busy single-slot server answers /v1/models slowly; 500 ms read it as down. */

/**
 * The one line every local-provider refusal and every provider listing
 * carries: local work goes through the mechanism (--local), never through
 * naming a loopback provider (incident 2026-10-19: a session named an
 * enabled-but-down loopback provider and the worker sat at "starting" for
 * minutes). Lives here so run.ts and providers.ts share it without a cycle.
 */
export const LOCAL_MECHANISM_LINE =
  "For local work use --local (picks the running local model); do not name a local provider.";

/** The host and port a provider's server answers on. */
export function providerHostPort(p: WorkerProvider): { host: string; port: number } | null {
  try {
    const u = new URL(p.baseUrl);
    const host = u.hostname.replace(/^\[|\]$/g, "");
    return { host, port: Number(u.port) || (u.protocol === "https:" ? 443 : 80) };
  } catch {
    return null;
  }
}

/** Probe every candidate loopback provider in parallel: name → running. */
export async function probeLoopback(
  cfg: Pick<WorkersConfig, "providers">,
  check: PortCheck = httpModelsCheck,
  tierProviders: string[] = tierProviderNames()
): Promise<Record<string, boolean>> {
  const local = Object.entries(cfg.providers).filter(([n, p]) => isLocalCandidate(p, n, tierProviders));
  const out: Record<string, boolean> = {};
  await Promise.all(
    local.map(async ([name, p]) => {
      const hp = providerHostPort(p);
      out[name] = hp ? await check(hp.host, hp.port, LOCAL_PROBE_TIMEOUT_MS, providerModelIds(p)) : false;
    })
  );
  return out;
}

/** The workers.yaml root's top-level `local:` key (like `active:`); undefined when absent or not a string. */
export function readLocalPreference(yamlPath: string = workersYamlPath()): string | undefined {
  if (!existsSync(yamlPath)) return undefined;
  try {
    const root = parseYaml(readFileSync(yamlPath, "utf8")) as unknown;
    if (typeof root !== "object" || root === null || Array.isArray(root)) return undefined;
    const v = (root as Record<string, unknown>).local;
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  } catch {
    // an unreadable or unparseable file has no preference; the config error
    // surfaces where the config is actually read
    return undefined;
  }
}

/** Stamp of the newest worker status of this provider, "" when it has none. */
function lastActivity(logDir: string, name: string): string {
  let latest = "";
  for (const s of loadStatuses(logDir)) {
    if (s.provider !== name) continue;
    const at = s.updated || s.started || "";
    if (at > latest) latest = at;
  }
  return latest;
}

export interface LocalResolution {
  name: string;
  /** One line on how it was chosen: "only local server up" / "workers.yaml local:" / "most recently started/used". */
  why: string;
}

export class NoLocalServerError extends WorkersConfigError {}

/** The tier --local without a class uses: the worker tier. */
export const DEFAULT_LOCAL_TIER = "t2";

/** The providers a tier lists, in order (the tier a class maps to; the worker tier without a class). */
export function localTierOrder(cfg: { tiers?: TierDef[] }, className?: string): string[] {
  return classRoute(cfg.tiers ?? [], className ?? DEFAULT_LOCAL_TIER).map(entryProvider);
}

export interface ResolveLocalOpts {
  /** The worker class: its tier's list orders the running local models (default: the worker tier). */
  className?: string;
  /** A specific running local model (`--local <name>`); an error listing the running ones when it is not running. */
  name?: string;
  /** Port probe seam (tests inject; default httpModelsCheck, short timeout). */
  check?: PortCheck;
  /** workers.yaml whose `local:` key decides among several up servers. */
  yamlPath?: string;
}

/**
 * The one local provider to run on. Throws NoLocalServerError when no local
 * model server answers, or when `local:` names a provider that is not a
 * running local one.
 */
export async function resolveLocalProvider(
  cfg: Pick<WorkersConfig, "providers"> & { tiers?: TierDef[] },
  logDir: string,
  opts: ResolveLocalOpts = {}
): Promise<LocalResolution> {
  // The daemon's cached answer is the authority; probe directly only when it
  // is not refreshing the cache (or a test injects its own port check).
  // A cached "none" is never trusted: only a fresh probe may say none.
  const cached = opts.check ? null : readLocalStatus(logDir);
  const tp = tierProviderNames(opts.yamlPath);
  const cachedUp = (cached?.running ?? []).filter((r) => {
    const p = cfg.providers[r.provider];
    return p && isLocalCandidate(p, r.provider, tp);
  });
  // the cache lists every running model; the pick is made here, by the tier of this run's class
  const useCache = cachedUp.length === (cached?.running.length ?? -1) && cachedUp.length > 0;
  const up = useCache
    ? cachedUp.map((r) => r.provider)
    : Object.entries(await probeLoopback(cfg, opts.check ?? httpModelsCheck, tp))
        .filter(([, running]) => running)
        .map(([name]) => name);
  if (!up.length) throw new NoLocalServerError(noServerMessage());
  if (opts.name !== undefined) {
    if (!up.includes(opts.name)) {
      throw new NoLocalServerError(`--local ${opts.name}: not a running local model (running: ${up.join(", ")})`);
    }
    return { name: opts.name, why: "--local name" };
  }
  return pickLocal(up, logDir, opts.yamlPath, localTierOrder(cfg, opts.className));
}

function noServerMessage(): string {
  return (
    "no local model server is running — local work is not available; do not start model servers " +
    "(run this on the cloud: drop --local / local: true; `pai worker local` shows the current answer)"
  );
}

/** Which of the running local providers `--local` runs on. Throws when `local:` names one that is not running. */
export function pickLocal(
  up: string[],
  logDir: string,
  yamlPath: string = workersYamlPath(),
  tierOrder: string[] = []
): LocalResolution {
  if (up.length === 1) return { name: up[0], why: "only local server up" };
  const byTier = tierOrder.find((n) => up.includes(n));
  if (byTier !== undefined) return { name: byTier, why: "first running in the routing tier order" };
  const pref = readLocalPreference(yamlPath);
  if (pref !== undefined) {
    if (!up.includes(pref)) {
      throw new NoLocalServerError(
        `workers.yaml local: names "${pref}", but it is not a running local provider (running: ${up.join(", ")})`
      );
    }
    return { name: pref, why: "workers.yaml local:" };
  }
  const best = up
    .map((name) => ({ name, at: lastActivity(logDir, name) }))
    .sort((a, b) => b.at.localeCompare(a.at))[0];
  return { name: best.name, why: "most recently started/used" };
}

/**
 * The running instances of a local model (provider): ready rows of the state
 * file, the instance-1 URL when none is recorded (a server started by hand
 * before the state file existed).
 */
export function resolveLocalInstances(
  cfg: Pick<WorkersConfig, "providers">,
  logDir: string,
  provider: string
): LocalInstance[] {
  const rows = readInstances(logDir).filter((i) => i.provider === provider && i.state === "ready");
  if (rows.length) return rows;
  const p = cfg.providers[provider];
  const hp = p ? providerHostPort(p) : null;
  if (!p || !hp) return [];
  return [{
    id: `${provider}#1`, model: provider, provider, url: p.baseUrl.replace(/\/+$/, ""), origin: "managed",
    port: hp.port, state: "ready", startedAt: 0, log: "",
  }];
}

/** Probe every local provider and decide which one `--local` runs on. */
export async function computeLocalStatus(
  cfg: Pick<WorkersConfig, "providers"> & { tiers?: TierDef[] },
  logDir: string,
  opts: { check?: PortCheck; yamlPath?: string; now?: Date } = {}
): Promise<LocalStatus> {
  const tiers = tierProviderNames(opts.yamlPath);
  const probed = await probeLoopback(cfg, opts.check ?? httpModelsCheck, tiers);
  const up = Object.entries(probed).filter(([, v]) => v).map(([n]) => n);
  const down = Object.entries(probed).filter(([, v]) => !v).map(([n]) => n);
  const disabled = Object.entries(cfg.providers)
    .filter(([n, p]) => !isLocalCandidate(p, n, tiers) && isLoopbackProvider(p))
    .map(([n]) => n);
  const running: LocalStatus["running"] = [];
  if (up.length) {
    const entry = (name: string, why: string) => ({ provider: name, model: cfg.providers[name]?.models.default ?? "?", why });
    let pick: LocalResolution;
    try {
      pick = pickLocal(up, logDir, opts.yamlPath, localTierOrder(cfg));
    } catch {
      // `local:` names a provider that is not up: the first running one leads
      pick = { name: up[0], why: "only running local server" };
    }
    // the model `--local` favours first, then the other running models
    running.push(entry(pick.name, pick.why));
    for (const n of up) if (n !== pick.name) running.push(entry(n, "also running"));
  }
  return { at: (opts.now ?? new Date()).toISOString(), running, down, disabled };
}

/**
 * Cached "running" answer, else a fresh direct probe. "None running" is only
 * ever the result of a fresh probe (missing, stale or "none" caches never
 * count). Never writes the cache.
 */
export async function currentLocalStatus(
  logDir?: string,
  opts: { check?: PortCheck; cfg?: Pick<WorkersConfig, "providers"> } = {}
): Promise<LocalStatus> {
  const workers = opts.cfg ?? readWorkersSection().workers;
  const dir = logDir ?? workersLogDir(workers as WorkersConfig);
  const cached = opts.check ? null : readLocalStatus(dir);
  const tp = tierProviderNames();
  if (cached?.running.length && cached.running.every((r) => { const cp = workers.providers[r.provider]; return cp && isLocalCandidate(cp, r.provider, tp); })) return cached;
  return computeLocalStatus(workers, dir, { check: opts.check });
}

/** Daemon side: refresh the cache now and every 30 s. Returns the stop function. */
export function startLocalStatusRefresh(): () => void {
  let busy = false;
  let lastWrite = 0;
  let lastLog = 0;
  const refresh = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      const { workers } = readWorkersSection();
      const dir = workersLogDir(workers);
      const st = await computeLocalStatus(workers, dir);
      writeLocalStatus(dir, st);
      const now = Date.now();
      if (now - lastLog >= 60_000) {
        process.stderr.write(`[local-status] wrote running=${st.running.length} after ${lastWrite ? Math.round((now - lastWrite) / 1000) : 0}s\n`);
        lastLog = now;
      }
      lastWrite = now;
    } catch (e) {
      process.stderr.write(`[pai-daemon] Local status refresh error: ${e instanceof Error ? e.message : String(e)}\n`);
    } finally {
      busy = false;
    }
  };
  void refresh();
  const timer = setInterval(() => void refresh(), LOCAL_STATUS_REFRESH_MS);
  timer.unref();
  return () => clearInterval(timer);
}


/** The provider behind a name that may be the value `local` (plan/queue runners). */
export async function resolvePlanProvider(
  workers: WorkersConfig,
  logDir: string,
  provider: string,
  opts: ResolveLocalOpts = {}
): Promise<string> {
  if (provider !== "local") return provider;
  return (await resolveLocalProvider(workers, logDir, opts)).name;
}

/**
 * The provider a delegation tool's `local: true` runs on: the resolved one,
 * with its parallel cap (the provider's own maxConcurrent, the loopback default cap
 * on loopback).
 */
export async function localProviderForDelegation(
  opts: ResolveLocalOpts = {}
): Promise<{ name: string; cap: number }> {
  const { workers } = readWorkersSection();
  const res = await resolveLocalProvider(workers, workersLogDir(workers), opts);
  const p = getProviderOrNative(workers, res.name);
  return { name: res.name, cap: effectiveCap(p?.maxConcurrent, true, p?.conversationSlots) };
}

/** The real `resolveLocal` of the plan and queue runners: reads the workers config. */
export function resolveRunnerProvider(provider: string): Promise<string> {
  const { workers } = readWorkersSection();
  return resolvePlanProvider(workers, workersLogDir(workers), provider);
}

/**
 * The providers the router routes: the configured set with every loopback
 * provider a `local:` tier launches switched on, so a model a tier started is
 * routable while its entry stays `enabled: false`. Read per request, so a tier
 * change needs no router restart.
 */
export function withTierProviders(
  providers: Record<string, WorkerProvider>,
  tierProviders: string[] = tierProviderNames()
): Record<string, WorkerProvider> {
  const out: Record<string, WorkerProvider> = {};
  for (const [name, p] of Object.entries(providers)) {
    out[name] = !p.enabled && isLocalCandidate(p, name, tierProviders) ? { ...p, enabled: true } : p;
  }
  return out;
}
