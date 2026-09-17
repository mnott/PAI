/**
 * daemon-llm.ts — provider-routed LLM spawns for daemon-side background calls.
 *
 * Session summaries, context handovers and KG extraction used to spawn a bare
 * `claude --model <tier>` with the ambient environment: on a machine whose
 * only login is a worker provider that spawn either dies (no Anthropic
 * credentials) or bills Anthropic outside the provider abstraction. This
 * module routes those spawns through the same registry and env build the
 * worker runner uses (`buildRunEnv`), resolving the tier alias to the
 * provider's concrete model id. With no usable provider configured it falls
 * back to the historical behaviour: the tier alias itself, ambient env minus
 * the Anthropic API key.
 */

import { mkdirSync } from "node:fs";
import {
  readWorkersSection,
  resolveModelCapability,
  type ModelTier,
  type WorkerProvider,
  type WorkersConfig,
} from "./config.js";
import { resolveTarget } from "./routing.js";
import { workersLogDir } from "./paths.js";
import { buildRunEnv } from "./run-env.js";
import { DEFAULT_PROXY_PORT, ensureProxyRunning } from "./proxy/server.js";

export type { ModelTier } from "./config.js";

/** Timeout per tier (ms) — a class-appropriate budget, not a per-model one. */
export const LLM_TIMEOUT_MS: Record<ModelTier, number> = {
  haiku: 60_000,    // 60 seconds
  sonnet: 120_000,  // 2 minutes
  opus: 300_000,    // 5 minutes — the thorough tier
};

export interface LlmSpawnPlan {
  /** --model value: the provider's concrete model id, or the tier alias on
   *  the no-provider fallback (the CLI resolves tier aliases itself there). */
  model: string;
  /** Full headless claude args, model flag included. */
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Provider name the spawn is routed through; null on the fallback path. */
  provider: string | null;
}

/** Resolve a tier to the provider's concrete model id: the fast capability
 *  for the cheap tier, the default model for the middle and top tiers. */
function tierModel(provider: WorkerProvider, tier: ModelTier): string {
  return resolveModelCapability(provider, tier === "haiku" ? "fast" : "default");
}

/** The historical fallback: tier alias as the model id, ambient env with the
 *  Anthropic API key stripped (so the CLI uses its interactive login). */
function legacyPlan(tier: ModelTier): LlmSpawnPlan {
  const { ANTHROPIC_API_KEY: _drop, ...env } = process.env;
  return {
    model: tier,
    args: ["--model", tier, "-p", "--no-session-persistence"],
    env,
    timeoutMs: LLM_TIMEOUT_MS[tier],
    provider: null,
  };
}

/**
 * Plan a daemon-side LLM spawn for a tier. Provider resolution failures (no
 * config, workers off, no usable provider) fall back to the tier-alias path;
 * a configured-but-broken provider (unreadable key file) throws, because
 * silently degrading to Anthropic billing is worse than a failed summary.
 */
export async function planLlmSpawn(tier: ModelTier, configPath?: string): Promise<LlmSpawnPlan> {
  let provider: WorkerProvider | null = null;
  let providerName: string | null = null;
  let config: WorkersConfig | null = null;
  try {
    const { workers } = readWorkersSection(configPath);
    if (workers.enabled) {
      const target = resolveTarget(workers, workersLogDir(workers), {});
      provider = target.provider;
      providerName = target.providerName;
      config = workers;
    }
  } catch {
    // no usable provider configured — the tier-alias fallback keeps the
    // feature alive exactly as it behaved before providers existed
    provider = null;
    providerName = null;
    config = null;
  }
  if (!provider || !providerName || !config) return legacyPlan(tier);

  let proxyUrl: string | undefined;
  if (provider.protocol === "openai") {
    const logDir = workersLogDir(config);
    mkdirSync(logDir, { recursive: true });
    proxyUrl = `${await ensureProxyRunning(DEFAULT_PROXY_PORT, logDir)}/${providerName}`;
  }

  const model = tierModel(provider, tier);
  return {
    model,
    args: ["--model", model, "-p", "--no-session-persistence"],
    env: buildRunEnv(provider, true, proxyUrl),
    timeoutMs: LLM_TIMEOUT_MS[tier],
    provider: providerName,
  };
}
