/**
 * routing.ts — provider selection: flag > class > active (possibly "auto").
 *
 * Auto-routing walks `workers.routing.order` — or the class's own `order` —
 * and takes the first provider that is enabled, out of cooldown, (when it
 * defines a quotaProbe) under its quotaSkipAt threshold, and — when the class
 * constrains it — within `maxCostTier` and carrying all `requireTags`. A run
 * that dies of a quota/rate error puts its provider in cooldown for
 * cooldownMinutes; when that happens before the first tool call and
 * retryOnQuota is set, the runner restarts the same task on the next provider
 * (ledger: WORKER-REROUTE).
 *
 * Policy "budget" (the default) orders candidates by routing.priority —
 * falling back to routing.order, else DEFAULT_BUDGET_PRIORITY — sorted by
 * percent ascending within equal priority, and additionally skips every
 * provider whose live budget reading (budget.ts) reads at or above its wall
 * (routing.budgetWalls). A walled provider gets a cooldown until
 * max(now + BUDGET_COOLDOWN_MIN, resetAt), so it stays skipped until its
 * window resets and re-enters on its own. The chosen target carries a
 * `switchReason` ("glm: anthropic 96% until 08:02") when budget skipped a
 * higher-priority provider. A run's provider is resolved once at spawn; a
 * running worker is never switched mid-flight.
 *
 * An explicit --provider or a class mapping that pins a provider always
 * bypasses all of this.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  type WorkerEngine,
  type WorkerProvider,
  type WorkersConfig,
  type ProviderTag,
  WORKER_CLASSES,
  ANTHROPIC_NATIVE,
  DEFAULT_BUDGET_PRIORITY,
  WorkersConfigError,
  classModelCapability,
  providerCostTier,
  getProviderOrNative,
  resolveCapability,
} from "./config.js";
import {
  type BudgetMap,
  type BudgetReading,
  budgetCache,
  budgetExceeded,
  budgetFresh,
  budgetSkipReason,
  budgetWall,
} from "./budget.js";
import { routingStatePath } from "./paths.js";
import { detectSessionProvider } from "./session-provider.js";

const QUOTA_SKIP_DEFAULT = 95;
const PROBE_TIMEOUT_MS = 10_000;
/** Minimum minutes a budget-walled provider stays in cooldown, even when its reset is closer. */
export const BUDGET_COOLDOWN_MIN = 10;

export interface RoutingState {
  /** provider name → ISO timestamp when its cooldown ends */
  cooldowns: Record<string, string>;
}

export function readRoutingState(logDir: string): RoutingState {
  const path = routingStatePath(logDir);
  if (!existsSync(path)) return { cooldowns: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as RoutingState;
    return { cooldowns: parsed.cooldowns ?? {} };
  } catch {
    return { cooldowns: {} };
  }
}

export function writeRoutingState(logDir: string, state: RoutingState): void {
  const path = routingStatePath(logDir);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

export function cooldownRemaining(
  state: RoutingState,
  provider: string,
  now: Date = new Date()
): number {
  const end = state.cooldowns[provider];
  if (!end) return 0;
  const ms = Date.parse(end) - now.getTime();
  return ms > 0 ? ms : 0;
}

export function setCooldown(
  logDir: string,
  provider: string,
  minutes: number,
  now: Date = new Date()
): void {
  const state = readRoutingState(logDir);
  state.cooldowns[provider] = new Date(now.getTime() + minutes * 60_000).toISOString();
  writeRoutingState(logDir, state);
}

export function clearCooldown(logDir: string, provider: string): void {
  const state = readRoutingState(logDir);
  if (!(provider in state.cooldowns)) return;
  delete state.cooldowns[provider];
  writeRoutingState(logDir, state);
}

/**
 * The candidate order for auto-routing: the class's own order, else — policy
 * "budget" — routing.priority, falling back to routing.order, else
 * DEFAULT_BUDGET_PRIORITY. Policy "order" uses routing.order as before.
 */
export function autoOrder(config: WorkersConfig, cls?: { order?: string[] }): string[] {
  if (cls?.order?.length) return cls.order;
  if (config.routing.policy === "order") return config.routing.order;
  if (config.routing.priority.length) return config.routing.priority;
  if (config.routing.order.length) return config.routing.order;
  return [...DEFAULT_BUDGET_PRIORITY];
}

/**
 * Run a provider's quotaProbe and return its percentage (0–100), or null when
 * there is no probe or it printed nothing usable. A probe must never break
 * routing: failures read as "unknown", not as "full".
 */
export function probeQuota(provider: WorkerProvider): number | null {
  if (!provider.quotaProbe) return null;
  try {
    const out = execFileSync("/bin/sh", ["-c", provider.quotaProbe], {
      timeout: PROBE_TIMEOUT_MS,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = out.match(/(\d+(?:\.\d+)?)/);
    if (!m) return null;
    return Math.min(100, Math.max(0, Math.round(parseFloat(m[1]))));
  } catch {
    return null;
  }
}

export function quotaSkipThreshold(provider: WorkerProvider): number {
  return provider.quotaSkipAt ?? QUOTA_SKIP_DEFAULT;
}

/** Does this provider exceed its quota threshold right now? */
export function quotaExceeded(provider: WorkerProvider): boolean {
  const used = probeQuota(provider);
  return used !== null && used >= quotaSkipThreshold(provider);
}

/**
 * Put every provider whose fresh budget reading is at or above its wall into
 * a cooldown until max(now + BUDGET_COOLDOWN_MIN, resetAt), so the walk below
 * skips it until its window resets and it re-enters on its own. Never
 * shortens an existing cooldown (a quota-failure cooldown outlasting the
 * reset stays). Fresh readings only: a stale cache must not re-wall anyone.
 */
export function recordBudgetCooldowns(config: WorkersConfig, logDir: string, now: Date = new Date()): void {
  if (config.routing.policy === "order") return;
  const state = readRoutingState(logDir);
  let dirty = false;
  for (const [name, r] of Object.entries(budgetCache.snapshot()) as Array<[string, BudgetReading]>) {
    if (r.percent === null || !budgetFresh(r, now.getTime())) continue;
    if (!budgetExceeded(r, budgetWall(config.routing, name))) continue;
    const until = Math.max(now.getTime() + BUDGET_COOLDOWN_MIN * 60_000, r.resetAt ?? 0);
    const prev = state.cooldowns[name];
    if (prev && Date.parse(prev) >= until) continue;
    state.cooldowns[name] = new Date(until).toISOString();
    dirty = true;
  }
  if (dirty) writeRoutingState(logDir, state);
}

export interface ResolvedTarget {
  providerName: string;
  provider: WorkerProvider;
  /** Model alias from the class ("glm/fast" → "fast"), null = provider default. */
  modelAlias: string | null;
  /** MCP servers (or set names) from the class target, null when it sets none. */
  classMcp: string[] | null;
  /** How the provider was chosen — names the bypass rule for rerouting. */
  via: "flag" | "class" | "session" | "active" | "auto";
  /** Why this provider, for the run's one route line ("session: launched on glm"). */
  routeWhy?: string;
  /**
   * One line on why budget routing moved the run off a higher-priority
   * provider ("glm: anthropic 96% until 08:02"); absent otherwise.
   */
  switchReason?: string;
}

export class NoProviderError extends WorkersConfigError {}

function mustExist(config: WorkersConfig, name: string): WorkerProvider {
  const p = getProviderOrNative(config, name);
  if (!p) {
    throw new NoProviderError(
      `no worker provider named "${name}". Configured: ` +
        `${Object.keys(config.providers).join(", ") || "(none)"}.` +
        `\nAdd one with: pai worker providers add <name> --base-url <url> --key-file <path> --model <model>`
    );
  }
  return p;
}

function mustBeRunnable(name: string, p: WorkerProvider): WorkerProvider {
  if (!p.enabled) {
    throw new NoProviderError(
      `provider "${name}" is disabled. Enable it with: pai worker providers enable ${name}`
    );
  }
  return p;
}

/** Why one provider of a routing order did not qualify (message fragment). */
function exclusionReason(
  config: WorkersConfig,
  state: RoutingState,
  name: string,
  cls?: { maxCostTier?: number; requireTags?: string[] },
  budgets?: BudgetMap
): string | null {
  const p = getProviderOrNative(config, name);
  if (!p) return "not configured";
  if (!p.enabled) return "disabled";
  if (cooldownRemaining(state, name) > 0) return "cooldown";
  if (quotaExceeded(p)) return "quota";
  if (budgets) {
    const r = budgets[name];
    // a fresh-enough reading at or above the provider's wall means full;
    // unknown (no reading, null percent) never walls
    if (r && r.percent !== null && budgetExceeded(r, budgetWall(config.routing, name))) {
      return `budget ${r.percent}% ≥ wall ${budgetWall(config.routing, name)}`;
    }
  }
  const tier = providerCostTier(p);
  if (cls?.maxCostTier !== undefined && tier > cls.maxCostTier) {
    return `cost tier ${tier} > max ${cls.maxCostTier}`;
  }
  if (cls?.requireTags?.length) {
    const have = p.tags ?? [];
    const missing = cls.requireTags.filter((t) => !have.includes(t as ProviderTag));
    if (missing.length) return `missing tags: ${missing.join(", ")}`;
  }
  return null;
}

/**
 * Resolve which provider (and model alias) a run uses.
 *
 * @param flagProvider --provider value, highest precedence
 * @param className    --class value (the old --role), looked up in workers.classes
 */
export function resolveTarget(
  config: WorkersConfig,
  logDir: string,
  opts: {
    flagProvider?: string;
    className?: string;
    /** Environment/home/cwd the session provider is read from (tests inject these). */
    sessionEnv?: NodeJS.ProcessEnv;
    home?: string;
    cwd?: string;
  } = {}
): ResolvedTarget {
  if (opts.flagProvider) {
    return {
      providerName: opts.flagProvider,
      provider: mustBeRunnable(opts.flagProvider, mustExist(config, opts.flagProvider)),
      modelAlias: null,
      classMcp: null,
      via: "flag",
      routeWhy: "flag: --provider",
    };
  }

  // class constraints (present whether or not the target pins a provider)
  const clsTarget = opts.className ? config.classes[opts.className] : undefined;
  const cls =
    typeof clsTarget === "object" && clsTarget !== null ? clsTarget : undefined;

  if (opts.className && clsTarget === undefined) {
    // a standard class may simply be unconfigured (it then routes like a run
    // without a class); anything else is a typo and must not pass silently
    if (!(WORKER_CLASSES as readonly string[]).includes(opts.className)) {
      throw new NoProviderError(
        `no class named "${opts.className}". Standard classes: ${WORKER_CLASSES.join(", ")}.` +
          `Defined: ${Object.keys(config.classes).join(", ") || "(none)"}.` +
          `\nSet one with: pai worker classes set ${opts.className}=<provider[/alias]>`
      );
    }
  }

  // the session the run was spawned from: its provider, the model tier from
  // the class (spotcheck/simple fast, the rest default) — the class map's
  // provider is ignored. A walled (cooldown) session provider falls through
  // to the configured routing below.
  const session = detectSessionProvider(config, {
    env: opts.sessionEnv,
    home: opts.home,
    cwd: opts.cwd,
    logDir,
  });
  if (session) {
    const p = getProviderOrNative(config, session.name);
    if (p?.enabled && cooldownRemaining(readRoutingState(logDir), session.name) === 0) {
      const capability = classModelCapability(opts.className);
      return {
        providerName: session.name,
        provider: p,
        modelAlias: capability === "fast" ? "fast" : "default",
        classMcp: cls?.mcp ?? null,
        via: "session",
        routeWhy: `session: ${session.why}`,
      };
    }
  }

  if (opts.className && clsTarget !== undefined && typeof clsTarget !== "object") {
    const [name, alias] = clsTarget.split("/");
    return {
      providerName: name,
      provider: mustBeRunnable(name, mustExist(config, name)),
      modelAlias: alias ?? null,
      classMcp: null,
      via: "class",
      routeWhy: `class: ${opts.className}`,
    };
  }
  if (opts.className && cls?.provider) {
    const provider = mustBeRunnable(cls.provider, mustExist(config, cls.provider));
    return {
      providerName: cls.provider,
      provider,
      modelAlias: null,
      classMcp: cls.mcp ?? null,
      via: "class",
      routeWhy: `class: ${opts.className}`,
    };
  }
  if (config.active !== "auto") {
    // nothing active and no class entry: the built-in provider, no config written
    const name = config.active ?? ANTHROPIC_NATIVE;
    return {
      providerName: name,
      provider: mustBeRunnable(name, mustExist(config, name)),
      modelAlias: null,
      classMcp: null,
      via: "active",
      routeWhy: `config: active ${name}`,
    };
  }

  // auto: first provider in (class or global) order that is enabled,
  // cooled-down-free, under quota and within the class constraints — policy
  // "budget" additionally skips providers whose live budget is at/above
  // their wall, preferring the fullest-budget candidate within equal priority
  const state = readRoutingState(logDir);
  const useBudget = config.routing.policy !== "order";
  const order = autoOrder(config, cls);
  const budgets: BudgetMap | undefined = useBudget ? budgetCache.snapshot() : undefined;
  const candidates = useBudget
    ? order
        .map((name, idx) => ({ name, idx, percent: budgets?.[name]?.percent }))
        .sort((a, b) => a.idx - b.idx || (a.percent ?? 0) - (b.percent ?? 0))
        .map((c) => c.name)
    : order;
  const excluded: string[] = [];
  let budgetSkipped: string | null = null;
  for (const name of candidates) {
    const p = getProviderOrNative(config, name);
    const why = exclusionReason(config, state, name, cls, budgets);
    if (why) {
      excluded.push(`${name}: ${why}`);
      if (useBudget && budgetSkipped === null && why.startsWith("budget") && p) {
        budgetSkipped = budgetSkipReason(name, budgets![name]);
      }
      continue;
    }
    // exclusionReason already returned null (no exclusion) above, which is
    // only possible when getProviderOrNative found a real provider
    return {
      providerName: name,
      provider: p!,
      modelAlias: null,
      classMcp: cls?.mcp ?? null,
      via: "auto",
      routeWhy: "config: active auto",
      ...(budgetSkipped ? { switchReason: `${name}: ${budgetSkipped}` } : {}),
    };
  }
  throw new NoProviderError(
    `auto-routing found no usable provider${opts.className ? ` for class "${opts.className}"` : ""} ` +
      `(order: [${order.join(", ")}]).` +
      `${excluded.length ? `\nExcluded: ${excluded.join("; ")}.` : ""}` +
      `\nClear a cooldown with: pai worker providers enable <name>; widen the class with: pai worker classes set ${opts.className ?? "<class>"}=<target>`
  );
}

/**
 * Next provider after `from` in auto order, applying the same filters —
 * including the budget wall under policy "budget", so a reroute never moves
 * a run onto a provider with no budget left. Used by rerouting; null when
 * the order is exhausted.
 */
export function nextAutoProvider(
  config: WorkersConfig,
  logDir: string,
  from: string,
  now: Date = new Date()
): string | null {
  const state = readRoutingState(logDir);
  const useBudget = config.routing.policy !== "order";
  const order = autoOrder(config);
  const budgets: BudgetMap | undefined = useBudget ? budgetCache.snapshot() : undefined;
  const start = order.indexOf(from);
  for (let i = start + 1; i < order.length; i++) {
    const name = order[i];
    const p = getProviderOrNative(config, name);
    if (!p || !p.enabled) continue;
    const end = state.cooldowns[name];
    if (end && Date.parse(end) > now.getTime()) continue;
    if (quotaExceeded(p)) continue;
    if (budgets) {
      const r = budgets[name];
      if (r && budgetExceeded(r, budgetWall(config.routing, name))) continue;
    }
    return name;
  }
  return null;
}

/**
 * Was this failure a quota/rate failure? Detected from the result text the
 * endpoint produced (HTTP status is not visible in the stream events).
 */
export function isQuotaFailure(resultText: string): boolean {
  return /usage limit reached|rate limit|quota/i.test(resultText);
}

export interface CapabilityRunResolution {
  providerName: string;
  provider: WorkerProvider;
  model: string;
  engine: WorkerEngine;
  fellBack: boolean;
  capability: string;
}

/**
 * Whether a run should resolve through `resolveCapability` instead of
 * `resolveTarget`: an explicit `--capability` always does. A `--class`
 * whose implied capability is not "default" (e.g. `image`) does too, but
 * only when the class itself names no provider — a class already pinned to
 * one (`image: glm/image`) always wins unchanged, same as any other class.
 */
export function capabilityForRun(
  config: WorkersConfig,
  opts: { capabilityFlag?: string; className?: string }
): string | null {
  if (opts.capabilityFlag) return opts.capabilityFlag;
  if (!opts.className) return null;
  const capability = classModelCapability(opts.className);
  if (capability === "default") return null;
  const clsTarget = config.classes[opts.className];
  const namesProvider = typeof clsTarget === "string" ? true : Boolean(clsTarget?.provider);
  return namesProvider ? null : capability;
}

/**
 * resolveCapability, turned into a runnable provider (NoProviderError-shaped
 * on failure). Unlike resolveCapability itself — which falls back to the
 * active provider's default model so `describeCapabilities` has something to
 * report — an actual run refuses the fallback: silently running a normal
 * model on a prompt written for a capability it does not have (an image
 * prompt fed to a text model, say) produces a confusing non-answer instead
 * of a clear error naming the config key to set.
 */
export function resolveCapabilityRun(config: WorkersConfig, capability: string): CapabilityRunResolution {
  const r = resolveCapability(config, capability);
  if (r.fellBack) {
    throw new NoProviderError(
      `no provider declares the "${capability}" capability — configure one with: ` +
        `pai worker capability ${capability} <provider>[,<provider>…], or ` +
        `pai worker model ${capability} <model-id> --provider <name>`
    );
  }
  // "image" specifically promises real pixel output — a provider whose only
  // claim to it is a `models.image` entry from the classes-based idiom
  // (`image: glm/image`, a plain model choice on an unchanged claude/codex
  // engine) cannot deliver that through this cross-provider run path, so a
  // run refuses it rather than spawning claude on a prompt it cannot answer.
  if (capability === "image" && r.engine !== "image") {
    throw new NoProviderError(
      `provider "${r.provider}" has no image engine (it would run "${r.model}" on its normal ` +
        `${r.engine} engine, not generate an image) — configure an engine=image provider with: ` +
        `pai worker providers add <name> --engine image --url <url> --key <key> --model <id>, then ` +
        `pai worker capability image <name>`
    );
  }
  const provider = getProviderOrNative(config, r.provider);
  if (!provider) {
    throw new NoProviderError(`capability "${capability}" resolved to unknown provider "${r.provider}"`);
  }
  return {
    providerName: r.provider,
    provider,
    model: r.model,
    engine: r.engine,
    fellBack: r.fellBack,
    capability,
  };
}
