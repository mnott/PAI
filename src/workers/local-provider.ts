/**
 * local-provider.ts — "a local worker" is resolved by PAI, never guessed by
 * a model (incident 2026-10-19: a session read `pai worker providers`, saw
 * ~15 enabled loopback providers — most with nothing listening — and picked
 * one by name). One function answers the question:
 *
 *   resolveLocalProvider()  the loopback provider to run on, or an error
 *
 * Local providers are those whose url is loopback (127.0.0.1 / localhost /
 * ::1). Each is probed on its port with the same TCP check `pai setups` uses
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
import { PORT_TIMEOUT_MS, tcpPortCheck, type PortCheck } from "../cli/lib/setups.js";

export { PORT_TIMEOUT_MS, tcpPortCheck, type PortCheck };

/**
 * The value `local` in a plan/queue run means resolveLocalProvider() at run
 * start. A test harness with fake deps and no real server sets
 * PAI_LOCAL_PROVIDER_RESOLVE=off: the value then reaches the worker spawn
 * unchanged, exactly as before this feature.
 */
function resolutionDisabled(): boolean {
  return process.env.PAI_LOCAL_PROVIDER_RESOLVE === "off";
}

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
  check: PortCheck = tcpPortCheck
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
  /** Port probe seam (tests inject; default tcpPortCheck, short timeout). */
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
  const up = Object.entries(await probeLoopback(cfg, opts.check ?? tcpPortCheck))
    .filter(([, running]) => running)
    .map(([name]) => name);
  if (!up.length) {
    throw new NoLocalServerError(
      "no local model server is running — start one, or run this on the cloud " +
        "(drop --local / local: true; `pai worker providers` shows which local providers are running)"
    );
  }
  if (up.length === 1) return { name: up[0], why: "only local server up" };
  const pref = readLocalPreference(opts.yamlPath ?? workersYamlPath());
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

/** The provider behind a name that may be the value `local` (plan/queue runners). */
export async function resolvePlanProvider(
  workers: WorkersConfig,
  logDir: string,
  provider: string,
  opts: ResolveLocalOpts = {}
): Promise<string> {
  if (provider !== "local" || resolutionDisabled()) return provider;
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
