/**
 * session-profile.ts — one store, one resolver for "which models does this
 * session use". A profile is kept per NAMED session (the persistent name:
 * AIBroker name / custom title) in session-profiles.yaml under the PAI home:
 *
 *   job-search:
 *     chat:     { provider: anthropic, model: opus }
 *     workers:  { provider: kimi, model: fast }
 *     fallback: [ { provider: glm, model: fast }, { provider: local } ]
 *     parallel_min: 2
 *
 * resolveWorkers is the single function every worker spawn path asks (pai
 * worker run, MCP handoff/queue/plan tools). Precedence:
 *
 *   explicit target > session profile workers > env from a setup launch > global routing
 *
 * When the chosen provider is exhausted (a fresh budget reading at or above
 * its wall, default 95% of any window, or a recorded quota/429 cooldown) the
 * profile's fallback list is walked in order, else the global auto order.
 * In a batch (queue run, plan run with parallel > 1, explicit flag) fallback
 * targets whose concurrency cap is below parallel_min are skipped: a cap-1
 * server must not serialise a fan-out. Nothing left reads as `none`, with the
 * reasons, rather than a silent slow path.
 */

import { resolveCap } from "./capacity.js";
import type { BudgetMap } from "./budget.js";
import { budgetFull } from "./budget.js";
import { getProviderOrNative, type WorkersConfig } from "./config.js";
import { isLoopbackProvider } from "./run-env.js";
import { cooldownRemaining, autoOrder, type RoutingState } from "./routing.js";
import { SESSION_WORKER_PROVIDER_ENV } from "./session-provider.js";
import { detectSessionName } from "./session-name.js";
import { BATCH_ENV, currentSessionName, getProfile, type ProfileTarget, type SessionProfile } from "./session-profile-store.js";

export * from "./session-profile-store.js";

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ResolveArgs {
  /** Explicit target: wins over everything, never falls back. */
  explicit?: { provider?: string; model?: string };
  /** This spawn is part of a fan-out. */
  batch?: boolean;
  /** Parallelism of the fan-out (plan parallel); informational. */
  parallel?: number;
}

export interface ResolveCtx {
  cfg: Pick<WorkersConfig, "providers" | "routing" | "active" | "nativeModels">;
  profile: SessionProfile | null;
  env: NodeJS.ProcessEnv;
  budgets: BudgetMap;
  routing: RoutingState;
  now?: Date;
}

export type WorkersSource = "explicit" | "profile" | "env" | "fallback" | "global" | "none";

export interface WorkersResolution {
  source: WorkersSource;
  provider?: string;
  /** Alias default|fast or a model id; undefined = the provider's own choice. */
  model?: string;
  /** One line, with the reason: "glm fast (fallback: kimi 5h at 100%)". */
  description: string;
}

const label = (provider: string, model?: string): string => `${provider}${model && model !== "default" ? ` ${model}` : ""}`;

/** Why a provider cannot take work right now; null when it can. */
export function exhaustion(ctx: ResolveCtx, name: string): string | null {
  const p = getProviderOrNative(ctx.cfg, name);
  if (!p) return `${name} not configured`;
  if (!p.enabled) return `${name} disabled`;
  const left = cooldownRemaining(ctx.routing, name, ctx.now);
  if (left > 0) return `${name} out of quota, ${Math.ceil(left / 60_000)}m cooldown`;
  const hit = budgetFull(ctx.cfg.routing, name, ctx.budgets[name]);
  if (hit) return `${name} ${hit.window ? `${hit.window} ` : ""}at ${hit.percent}%`;
  return null;
}

/** Concurrency cap of a provider; Infinity when uncapped. */
export function capOf(cfg: ResolveCtx["cfg"], name: string): number {
  const p = getProviderOrNative(cfg, name);
  if (!p) return Infinity;
  return resolveCap(p.maxConcurrent, isLoopbackProvider(p)) ?? Infinity;
}

export function resolveWorkers(args: ResolveArgs, ctx: ResolveCtx): WorkersResolution {
  const ex = args.explicit;
  if (ex?.provider) return { source: "explicit", provider: ex.provider, model: ex.model, description: `${label(ex.provider, ex.model)} (explicit)` };

  const profile = ctx.profile;
  const envProvider = ctx.env[SESSION_WORKER_PROVIDER_ENV]?.trim();
  let chosen: ProfileTarget | undefined = profile?.workers;
  let source: WorkersSource = "profile";
  if (!chosen && envProvider) {
    chosen = { provider: envProvider };
    source = "env";
  }
  // an explicit model alone (no provider) still applies to the chosen provider
  if (chosen && ex?.model) chosen = { ...chosen, model: ex.model };
  if (!chosen) return { source: "global", model: ex?.model, description: "global routing" };

  const why = exhaustion(ctx, chosen.provider);
  if (!why) return { source, provider: chosen.provider, model: chosen.model, description: `${label(chosen.provider, chosen.model)} (${source === "env" ? "setup launch" : "session profile"})` };

  const model = chosen.model;
  const skipped: string[] = [];
  const min = args.batch ? profile?.parallel_min : undefined;
  const list: ProfileTarget[] = profile?.fallback?.length
    ? profile.fallback
    : autoOrder(ctx.cfg as WorkersConfig).map((provider) => ({ provider }));
  for (const t of list) {
    if (t.provider === chosen.provider) continue;
    const why2 = exhaustion(ctx, t.provider);
    if (why2) {
      skipped.push(why2);
      continue;
    }
    const cap = capOf(ctx.cfg, t.provider);
    if (min !== undefined && cap < min) {
      skipped.push(`${t.provider} cap ${cap} < parallel_min ${min}`);
      continue;
    }
    const m = t.model ?? model;
    return { source: "fallback", provider: t.provider, model: m, description: `${label(t.provider, m)} (fallback: ${why})` };
  }
  return {
    source: "none",
    description: `no worker target available: ${why}${skipped.length ? `; skipped ${skipped.join(", ")}` : ""}`,
  };
}

/** The live context: config, this session's profile, fresh budget readings (warmed best effort) and recorded cooldowns. */
export async function liveResolveCtx(env: NodeJS.ProcessEnv = process.env): Promise<ResolveCtx> {
  const [{ readWorkersSection }, { budgetCache }, { readRoutingState }, { workersLogDir }] = await Promise.all([
    import("./config.js"),
    import("./budget.js"),
    import("./routing.js"),
    import("./paths.js"),
  ]);
  const { workers } = readWorkersSection();
  const profile = getProfile(await detectSessionName(env));
  if (profile && workers.routing.policy !== "order") {
    try {
      await budgetCache.warm(workers);
    } catch {
      // unknown readings never read as full
    }
  }
  return { cfg: workers, profile, env, budgets: budgetCache.snapshot(), routing: readRoutingState(workersLogDir(workers)) };
}

export const isBatchEnv = (env: NodeJS.ProcessEnv = process.env): boolean => env[BATCH_ENV] === "1";
