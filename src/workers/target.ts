/**
 * target.ts — where delegated work runs, said in plain words. Every delegation
 * entry point (MCP worker_handoff, queue_add/queue_run, plan_save/plan_run,
 * `pai worker run`) takes the same three optional arguments and resolves them
 * here, once:
 *
 *   where  "local" | "cloud" | <provider name>   (omitted: today's routing)
 *   model  "default" | "fast" | <model id>
 *   now    true: front of the provider's waiting order
 *
 * "local" is resolveLocalProvider(); "cloud" is the session's cloud provider
 * (PAI_SESSION_PROVIDER, else workers.yaml `active`, each only when not
 * loopback, else anthropic). The description is the line a tool result starts
 * with, so the session can tell the operator where the work runs.
 */

import { CliError } from "../cli/define.js";
import { ANTHROPIC_NATIVE, getProviderOrNative, readWorkersSection, type WorkersConfig } from "./config.js";
import { probeLoopback, resolveLocalProvider, type ResolveLocalOpts } from "./local-provider.js";
import { isLoopbackProvider } from "./run-env.js";
import { SESSION_PROVIDER_ENV } from "./session-provider.js";
import { workersLogDir } from "./paths.js";

export interface TargetArgs {
  where?: string;
  model?: string;
  now?: boolean;
}

export interface Target {
  /** Provider to run on; undefined when `where` was omitted (today's routing decides). */
  provider?: string;
  /** Concrete model id, or the alias "fast" when no provider is fixed; undefined = the provider's/class default. */
  model?: string;
  /** `fast` asked with no provider fixed: the routed provider's fast model (RunOptions.modelFast). */
  modelFast?: boolean;
  /** "front": goes ahead of the provider's waiting runs. */
  priority?: "front";
  /** One plain line: "local: flashnext-iq3", "cloud: anthropic sonnet", "kimi k3". */
  description: string;
}

export interface TargetDeps extends ResolveLocalOpts {
  workers: Pick<WorkersConfig, "providers" | "nativeModels"> & { active?: string | null };
  logDir: string;
  env?: NodeJS.ProcessEnv;
}

/** The deps for the live config. */
export function liveTargetDeps(): TargetDeps {
  const { workers } = readWorkersSection();
  return { workers, logDir: workersLogDir(workers) };
}

type ProviderTable = TargetDeps["workers"];

function modelFor(cfg: ProviderTable, provider: string, model: string | undefined): string {
  const p = getProviderOrNative(cfg, provider);
  const m = model?.trim();
  if (m && m !== "default" && m !== "fast") return m;
  if (m === "fast") return p?.models.fast ?? p?.models.default ?? "";
  return p?.models.default ?? "";
}

/** The provider "the cloud" means for this session. */
function cloudProvider(cfg: ProviderTable, env: NodeJS.ProcessEnv): string {
  const usable = (n: string | null | undefined): n is string => {
    if (!n || n === "auto") return false;
    const p = getProviderOrNative(cfg, n);
    return !!p && p.enabled && !isLoopbackProvider(p);
  };
  const session = env[SESSION_PROVIDER_ENV]?.trim();
  if (usable(session)) return session;
  if (usable(cfg.active)) return cfg.active;
  return ANTHROPIC_NATIVE;
}

async function unknownProvider(cfg: ProviderTable, name: string, why: string, opts: ResolveLocalOpts): Promise<CliError> {
  const running = await probeLoopback(cfg, opts.check);
  const names = [ANTHROPIC_NATIVE, ...Object.entries(cfg.providers).filter(([, p]) => p.enabled).map(([n]) => n)];
  const list = names.map((n) => (n in running ? `${n} (${running[n] ? "running" : "not running"})` : n)).join(", ");
  return new CliError(`no usable provider "${name}": ${why}`, `valid: ${list}; or where local / cloud`);
}

/** Resolve where/model/now into a provider, model and priority. */
export async function resolveTarget(args: TargetArgs, deps: TargetDeps = liveTargetDeps()): Promise<Target> {
  const where = args.where?.trim() || undefined;
  const modelArg = args.model?.trim() || undefined;
  const priority = args.now === true ? ("front" as const) : undefined;
  const cfg = deps.workers;

  if (!where) {
    const fast = modelArg === "fast";
    const id = modelArg && modelArg !== "default" && !fast ? modelArg : undefined;
    return { model: id, modelFast: fast || undefined, priority, description: `default routing${id ? ` ${id}` : fast ? " fast model" : ""}${priority ? ", first in line" : ""}` };
  }

  let provider: string;
  let label: string;
  if (where === "local") {
    provider = (await resolveLocalProvider(cfg, deps.logDir, deps)).name;
    label = "local: ";
  } else if (where === "cloud") {
    provider = cloudProvider(cfg, deps.env ?? process.env);
    label = "cloud: ";
  } else {
    const p = getProviderOrNative(cfg, where);
    if (!p) throw await unknownProvider(cfg, where, "not configured", deps);
    if (!p.enabled) throw await unknownProvider(cfg, where, "disabled", deps);
    provider = where;
    label = "";
  }
  const model = modelFor(cfg, provider, modelArg);
  const named = label === "local: " ? provider : `${provider}${model ? ` ${model}` : ""}`;
  return { provider, model: model || undefined, priority, description: `${label}${named}${priority ? ", first in line" : ""}` };
}

/** Resolver seam the entry points take, so tests inject. */
export type TargetResolver = (args: TargetArgs) => Promise<Target>;

/** Lead line of a tool result: where it runs, when the caller said anything. */
export function withTarget(t: Target | undefined, body: string): string {
  return t ? `Runs on ${t.description}.\n${body}` : body;
}
