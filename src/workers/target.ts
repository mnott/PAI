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
 * (the provider normal routing follows: detectSessionProvider, else workers.yaml
 * `active`, each only when not loopback, else anthropic). The description is the line a tool result starts
 * with, so the session can tell the operator where the work runs.
 */

import { CliError } from "../cli/define.js";
import { ANTHROPIC_NATIVE, getProviderOrNative, readWorkersSection, type WorkersConfig } from "./config.js";
import { isLocalCandidate, probeLoopback, resolveLocalProvider, tierProviderNames, type ResolveLocalOpts } from "./local-provider.js";
import { isLoopbackProvider } from "./run-env.js";
import { detectSessionProvider } from "./session-provider.js";
import { workersLogDir } from "./paths.js";
import { classifyRoute, localFailures, routeLine } from "./route-classifier.js";
import { ledgerPath } from "./paths.js";
import { detectSessionName } from "./session-name.js";
import { liveResolveCtx, resolveWorkers, type ResolveCtx } from "./session-profile.js";

export interface TargetArgs {
  where?: string;
  model?: string;
  now?: boolean;
  /** The spawn is part of a fan-out (queue run, plan run with parallel > 1): session-profile fallback honours parallel_min. */
  batch?: boolean;
  /** Task text, worker label, plan part kind and tags: the route classifier's input when the target is local. */
  task?: string;
  label?: string;
  kind?: string;
  tags?: string[];
  /** --force-local: keep a local target local whatever the classifier says. */
  forceLocal?: boolean;
}

export interface Target {
  /** Provider to run on; undefined when `where` was omitted (today's routing decides). */
  provider?: string;
  /** Concrete model id, or the alias "fast" when no provider is fixed; undefined = the provider's/class default. */
  model?: string;
  /** `fast` asked with no provider fixed: the routed provider's fast model (RunOptions.modelFast). */
  modelFast?: boolean;
  /** `default` asked with no provider fixed: the routed provider's default model, whatever its worker_model (RunOptions.modelDefault). */
  modelDefault?: boolean;
  /** "front": goes ahead of the provider's waiting runs. */
  priority?: "front";
  /** One plain line: "local: flashnext-iq3", "cloud: anthropic sonnet", "kimi k3". */
  description: string;
}

export interface TargetDeps extends ResolveLocalOpts {
  workers: Pick<WorkersConfig, "providers" | "nativeModels"> & { active?: string | null };
  logDir: string;
  env?: NodeJS.ProcessEnv;
  /** Session-profile resolution context (session-profile.ts); default: the live one. */
  profileCtx?: () => Promise<ResolveCtx>;
  /** Failed local attempts of a label (default: counted from the routing ledger). */
  localFailures?: (label: string) => number;
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
  if (m === "fast" || (m !== "default" && p?.workerModel === "fast")) return p?.models.fast ?? p?.models.default ?? "";
  return p?.models.default ?? "";
}

/** The provider "the cloud" means for this session. */
function cloudProvider(cfg: ProviderTable, env: NodeJS.ProcessEnv, logDir: string): string {
  const usable = (n: string | null | undefined): n is string => {
    if (!n || n === "auto") return false;
    const p = getProviderOrNative(cfg, n);
    return !!p && p.enabled && !isLoopbackProvider(p);
  };
  const session = detectSessionProvider(cfg, { env, logDir })?.name;
  if (usable(session)) return session;
  if (usable(cfg.active)) return cfg.active;
  return ANTHROPIC_NATIVE;
}

async function unknownProvider(cfg: ProviderTable, name: string, why: string, opts: ResolveLocalOpts): Promise<CliError> {
  const running = await probeLoopback(cfg, opts.check);
  const tiers = tierProviderNames();
  const names = [ANTHROPIC_NATIVE, ...Object.entries(cfg.providers).filter(([n, p]) => p.enabled || isLocalCandidate(p, n, tiers)).map(([n]) => n)];
  const list = names.map((n) => (n in running ? `${n} (${running[n] ? "running" : "not running"})` : n)).join(", ");
  return new CliError(`no usable provider "${name}": ${why}`, `valid: ${list}; or where local / cloud`);
}

/** Route classifier for a local target: the cloud provider it reroutes to, with the reason, or undefined to stay local. */
function reroute(args: TargetArgs, deps: TargetDeps): { reason: string } | undefined {
  if (args.task === undefined && !args.label && !args.kind && !args.tags) return undefined;
  const failures = args.label
    ? (deps.localFailures ?? ((l) => localFailures(ledgerPath(deps.logDir), l, (p) => { const c = getProviderOrNative(deps.workers, p); return !!c && isLoopbackProvider(c); })))(args.label)
    : 0;
  const d = classifyRoute({ kind: args.kind, label: args.label, tags: args.tags, text: args.task, failures, forceLocal: args.forceLocal });
  return d.where === "cloud" ? { reason: routeLine(d) } : undefined;
}

/** Resolve where/model/now into a provider, model and priority. */
export async function resolveTarget(args: TargetArgs, deps: TargetDeps = liveTargetDeps()): Promise<Target> {
  const where = args.where?.trim() || undefined;
  const modelArg = args.model?.trim() || undefined;
  const priority = args.now === true ? ("front" as const) : undefined;
  const cfg = deps.workers;

  if (!where) {
    // the session's own profile (or its fallback) decides before today's routing does
    const env = deps.env ?? process.env;
    const r = deps.profileCtx || (await detectSessionName(env))
      ? resolveWorkers({ explicit: { model: modelArg }, batch: args.batch }, await (deps.profileCtx ?? (() => liveResolveCtx(env)))())
      : undefined;
    if (r?.source === "none") throw new CliError(r.description, "pai session profile: session_profile_set fallback / parallel_min");
    if (r?.provider && (r.source === "profile" || r.source === "fallback")) {
      const pc = getProviderOrNative(cfg, r.provider);
      const rr2 = pc && isLoopbackProvider(pc) ? reroute(args, deps) : undefined;
      if (rr2) {
        const cloud = cloudProvider(cfg, env, deps.logDir);
        const cm = modelFor(cfg, cloud, modelArg);
        return { provider: cloud, model: cm || undefined, priority, description: `cloud: ${cloud}${cm ? ` ${cm}` : ""} (${rr2.reason})${priority ? ", first in line" : ""}` };
      }
      const model = modelFor(cfg, r.provider, r.model);
      return { provider: r.provider, model: model || undefined, priority, description: `${r.description}${priority ? ", first in line" : ""}` };
    }
    const fast = modelArg === "fast";
    const dflt = modelArg === "default";
    const id = modelArg && modelArg !== "default" && !fast ? modelArg : undefined;
    return { model: id, modelFast: fast || undefined, modelDefault: dflt || undefined, priority, description: `default routing${id ? ` ${id}` : fast ? " fast model" : ""}${priority ? ", first in line" : ""}` };
  }

  let provider: string;
  let label: string;
  let routed = "";
  const rr = where === "local" ? reroute(args, deps) : undefined;
  if (rr) {
    provider = cloudProvider(cfg, deps.env ?? process.env, deps.logDir);
    label = "cloud: ";
    routed = ` (${rr.reason})`;
  } else if (where === "local") {
    provider = (await resolveLocalProvider(cfg, deps.logDir, deps)).name;
    label = "local: ";
  } else if (where === "cloud") {
    provider = cloudProvider(cfg, deps.env ?? process.env, deps.logDir);
    label = "cloud: ";
  } else {
    const p = getProviderOrNative(cfg, where);
    if (!p) throw await unknownProvider(cfg, where, "not configured", deps);
    if (!p.enabled && !isLocalCandidate(p, where, tierProviderNames())) throw await unknownProvider(cfg, where, "disabled", deps);
    provider = where;
    label = "";
  }
  const model = modelFor(cfg, provider, modelArg);
  const named = label === "local: " ? provider : `${provider}${model ? ` ${model}` : ""}`;
  return { provider, model: model || undefined, priority, description: `${label}${named}${routed}${priority ? ", first in line" : ""}` };
}

/** Resolver seam the entry points take, so tests inject. */
export type TargetResolver = (args: TargetArgs) => Promise<Target>;

/** Lead line of a tool result: where it runs, when the caller said anything. */
export function withTarget(t: Target | undefined, body: string): string {
  return t ? `Runs on ${t.description}.\n${body}` : body;
}
