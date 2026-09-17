/**
 * routing.ts — provider selection: flag > role > active (possibly "auto").
 *
 * Auto-routing walks `workers.routing.order` and takes the first provider
 * that is enabled, out of cooldown, and (when it defines a quotaProbe) under
 * its quotaSkipAt threshold. A run that dies of a quota/rate error puts its
 * provider in cooldown for cooldownMinutes; when that happens before the
 * first tool call and retryOnQuota is set, the runner restarts the same task
 * on the next provider (ledger: WORKER-REROUTE).
 *
 * An explicit --provider or --role always bypasses all of this.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  type WorkerProvider,
  type WorkersConfig,
  WorkersConfigError,
} from "./config.js";
import { routingStatePath } from "./paths.js";

const QUOTA_SKIP_DEFAULT = 95;
const PROBE_TIMEOUT_MS = 10_000;

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

export interface ResolvedTarget {
  providerName: string;
  provider: WorkerProvider;
  /** Model alias from the role ("glm/fast" → "fast"), null = provider default. */
  modelAlias: string | null;
  /** MCP servers (or set names) from the role target, null when it sets none. */
  roleMcp: string[] | null;
  /** How the provider was chosen — names the bypass rule for rerouting. */
  via: "flag" | "role" | "active" | "auto";
}

export class NoProviderError extends WorkersConfigError {}

function mustExist(config: WorkersConfig, name: string): WorkerProvider {
  const p = config.providers[name];
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

/**
 * Resolve which provider (and model alias) a run uses.
 *
 * @param flagProvider --provider value, highest precedence
 * @param role         --role value, looked up in workers.roles
 */
export function resolveTarget(
  config: WorkersConfig,
  logDir: string,
  opts: { flagProvider?: string; role?: string } = {}
): ResolvedTarget {
  if (opts.flagProvider) {
    return {
      providerName: opts.flagProvider,
      provider: mustBeRunnable(opts.flagProvider, mustExist(config, opts.flagProvider)),
      modelAlias: null,
      roleMcp: null,
      via: "flag",
    };
  }

  if (opts.role) {
    const target = config.roles[opts.role];
    if (!target) {
      throw new NoProviderError(
        `no role named "${opts.role}". Defined: ${Object.keys(config.roles).join(", ") || "(none)"}.` +
          `\nSet one with: pai worker roles set ${opts.role}=<provider[/alias]>`
      );
    }
    const name = typeof target === "string" ? target.split("/")[0] : target.provider;
    const alias = typeof target === "string" ? target.split("/")[1] : undefined;
    const roleMcp = typeof target === "string" ? null : target.mcp ?? null;
    return {
      providerName: name,
      provider: mustBeRunnable(name, mustExist(config, name)),
      modelAlias: alias ?? null,
      roleMcp,
      via: "role",
    };
  }

  if (config.active !== "auto") {
    const name = config.active;
    if (!name) {
      throw new NoProviderError(
        `no active worker provider. Add one with: ` +
          `pai worker providers add <name> --base-url <url> --key-file <path> --model <model>` +
          `\n(or point one that exists at it: pai worker providers use <name>)`
      );
    }
    return {
      providerName: name,
      provider: mustBeRunnable(name, mustExist(config, name)),
      modelAlias: null,
      roleMcp: null,
      via: "active",
    };
  }

  // auto: first provider in order that is enabled, cooled-down-free, under quota
  const state = readRoutingState(logDir);
  const skipped: string[] = [];
  for (const name of config.routing.order) {
    const p = config.providers[name];
    if (!p || !p.enabled) continue;
    if (cooldownRemaining(state, name) > 0) {
      skipped.push(`${name}(cooldown)`);
      continue;
    }
    if (quotaExceeded(p)) {
      skipped.push(`${name}(quota)`);
      continue;
    }
    return { providerName: name, provider: p, modelAlias: null, roleMcp: null, via: "auto" };
  }
  throw new NoProviderError(
    `auto-routing found no usable provider (order: [${config.routing.order.join(", ")}]` +
      `${skipped.length ? `; skipped: ${skipped.join(", ")}` : ""}).` +
      `\nClear a cooldown with: pai worker providers enable <name>`
  );
}

/**
 * Next provider after `from` in auto order, applying the same filters.
 * Used by rerouting; null when the order is exhausted.
 */
export function nextAutoProvider(
  config: WorkersConfig,
  logDir: string,
  from: string,
  now: Date = new Date()
): string | null {
  const state = readRoutingState(logDir);
  const order = config.routing.order;
  const start = order.indexOf(from);
  for (let i = start + 1; i < order.length; i++) {
    const name = order[i];
    const p = config.providers[name];
    if (!p || !p.enabled) continue;
    const end = state.cooldowns[name];
    if (end && Date.parse(end) > now.getTime()) continue;
    if (quotaExceeded(p)) continue;
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
