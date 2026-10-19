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
 * implementation, imported here). Exactly one up → it. Several up → the one
 * workers.yaml's top-level `local:` key names (like `active:`), else the one
 * most recently started/used (its newest worker status), and the choice says
 * which. None up → an error naming that no local model server is running.
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
import { loadStatuses } from "./status.js";
import { workersYamlPath } from "./workers-config.js";
import { workersLogDir } from "./paths.js";
import { resolveCap } from "./capacity.js";
import {
  LOCAL_STATUS_REFRESH_MS,
  readLocalStatus,
  writeLocalStatus,
  type LocalStatus,
} from "./local-status.js";
import { PORT_TIMEOUT_MS, httpModelsCheck, type PortCheck } from "../cli/lib/setups.js";

export { PORT_TIMEOUT_MS, httpModelsCheck, type PortCheck };

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

/** Probe every enabled loopback provider in parallel: name → running. */
export async function probeLoopback(
  cfg: Pick<WorkersConfig, "providers">,
  check: PortCheck = httpModelsCheck
): Promise<Record<string, boolean>> {
  const local = Object.entries(cfg.providers).filter(([, p]) => p.enabled && isLoopbackProvider(p));
  const out: Record<string, boolean> = {};
  await Promise.all(
    local.map(async ([name, p]) => {
      const hp = providerHostPort(p);
      out[name] = hp ? await check(hp.host, hp.port, PORT_TIMEOUT_MS) : false;
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

export interface ResolveLocalOpts {
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
  cfg: Pick<WorkersConfig, "providers">,
  logDir: string,
  opts: ResolveLocalOpts = {}
): Promise<LocalResolution> {
  // The daemon's cached answer is the authority; probe directly only when it
  // is not refreshing the cache (or a test injects its own port check).
  const cached = opts.check ? null : readLocalStatus(logDir);
  if (cached) {
    const r = cached.running;
    if (r && cfg.providers[r.provider]?.enabled) return { name: r.provider, why: `daemon: ${r.why}` };
    throw new NoLocalServerError(noServerMessage());
  }
  const up = Object.entries(await probeLoopback(cfg, opts.check ?? httpModelsCheck))
    .filter(([, running]) => running)
    .map(([name]) => name);
  if (!up.length) throw new NoLocalServerError(noServerMessage());
  return pickLocal(up, logDir, opts.yamlPath);
}

function noServerMessage(): string {
  return (
    "no local model server is running — local work is not available; do not start model servers " +
    "(run this on the cloud: drop --local / local: true; `pai worker local` shows the current answer)"
  );
}

/** Which of the running local providers `--local` runs on. Throws when `local:` names one that is not running. */
export function pickLocal(up: string[], logDir: string, yamlPath: string = workersYamlPath()): LocalResolution {
  if (up.length === 1) return { name: up[0], why: "only local server up" };
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

/** Probe every local provider and decide which one `--local` runs on. */
export async function computeLocalStatus(
  cfg: Pick<WorkersConfig, "providers">,
  logDir: string,
  opts: { check?: PortCheck; yamlPath?: string; now?: Date } = {}
): Promise<LocalStatus> {
  const probed = await probeLoopback(cfg, opts.check ?? httpModelsCheck);
  const up = Object.entries(probed).filter(([, v]) => v).map(([n]) => n);
  const down = Object.entries(probed).filter(([, v]) => !v).map(([n]) => n);
  const disabled = Object.entries(cfg.providers)
    .filter(([, p]) => !p.enabled && isLoopbackProvider(p))
    .map(([n]) => n);
  let running: LocalStatus["running"] = null;
  if (up.length) {
    try {
      const pick = pickLocal(up, logDir, opts.yamlPath);
      running = { provider: pick.name, model: cfg.providers[pick.name]?.models.default ?? "?", why: pick.why };
    } catch {
      // `local:` names a provider that is not up: report the first running one
      running = { provider: up[0], model: cfg.providers[up[0]]?.models.default ?? "?", why: "only running local server" };
    }
  }
  return { at: (opts.now ?? new Date()).toISOString(), running, down, disabled };
}

/** Cached answer, else a direct probe (daemon unreachable). Never writes the cache. */
export async function currentLocalStatus(logDir?: string): Promise<LocalStatus> {
  const { workers } = readWorkersSection();
  const dir = logDir ?? workersLogDir(workers);
  return readLocalStatus(dir) ?? (await computeLocalStatus(workers, dir));
}

/** Daemon side: refresh the cache now and every 30 s. Returns the stop function. */
export function startLocalStatusRefresh(): () => void {
  const refresh = async (): Promise<void> => {
    try {
      const { workers } = readWorkersSection();
      const dir = workersLogDir(workers);
      writeLocalStatus(dir, await computeLocalStatus(workers, dir));
    } catch (e) {
      process.stderr.write(`[pai-daemon] Local status refresh error: ${e instanceof Error ? e.message : String(e)}\n`);
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
 * with its parallel cap (the provider's own maxConcurrent, 3 default on
 * loopback).
 */
export async function localProviderForDelegation(
  opts: ResolveLocalOpts = {}
): Promise<{ name: string; cap: number }> {
  const { workers } = readWorkersSection();
  const res = await resolveLocalProvider(workers, workersLogDir(workers), opts);
  const p = getProviderOrNative(workers, res.name);
  return { name: res.name, cap: resolveCap(p?.maxConcurrent, true) ?? 3 };
}

/** The real `resolveLocal` of the plan and queue runners: reads the workers config. */
export function resolveRunnerProvider(provider: string): Promise<string> {
  const { workers } = readWorkersSection();
  return resolvePlanProvider(workers, workersLogDir(workers), provider);
}
