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
  defaultWorkersConfig,
  isLocalProvider,
  readWorkersSection,
  resolveModelCapability,
  type ModelTier,
  type WorkerProvider,
  type WorkersConfig,
} from "./config.js";
import { resolveTarget } from "./routing.js";
import { resolveLocalProvider } from "./local-provider.js";
import { ensureNoMcpConfig, workersLogDir } from "./paths.js";
import { buildRunEnv, loopbackRouterChoice, withLoginIdentity } from "./run-env.js";
import { probeRouter } from "../router/supervisor.js";
import { proxyPort, ensureProxyRunning } from "./proxy/server.js";

export type { ModelTier } from "./config.js";

/**
 * Marker every daemon-spawned LLM process carries. The run is text-in/text-out
 * (prompt in, answer out) and must never be summarized itself: without this
 * marker its SessionEnd/Stop hooks enqueue a summary of the summarizer's own
 * transcript, which spawns another summarizer — an unbounded feedback loop
 * (401 runs observed on 2026-11-24). Hooks check `isDaemonLlmSession()`; the
 * session-summary worker refuses such transcripts as a backstop.
 */
export const DAEMON_LLM_ENV_MARKER = "PAI_DAEMON_LLM";

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

/**
 * Containment every daemon-side LLM spawn carries. These calls are
 * text-in/text-out: the prompt carries the context, the answer is the
 * product, and nothing about summarizing a session justifies a tool. An
 * unrestricted background summarizer was observed on 2026-09-18 (01:33-01:51)
 * rewriting the live config with a schema-shaped dump while the daemon ran;
 * with the tool grant empty and MCP strictly empty, that class of damage is
 * structurally impossible rather than merely unlikely.
 */
function containmentArgs(logDir: string): string[] {
  return [
    "--strict-mcp-config", "--mcp-config", ensureNoMcpConfig(logDir),
    // the empty grant allows no tool at all — not Read, not Bash, nothing
    "--allowedTools", "",
    // --tools "" drops the built-in tool schemas from the static prefix too:
    // 29,270 tokens with only --allowedTools "" vs 14,049 with --tools "" as well
    "--tools", "",
  ];
}

/** The historical fallback: tier alias as the model id, ambient env with the
 *  Anthropic API key stripped (so the CLI uses its interactive login). */
function legacyPlan(tier: ModelTier, config: WorkersConfig | null): LlmSpawnPlan {
  const { ANTHROPIC_API_KEY: _drop, ...rest } = process.env;
  const env = withLoginIdentity(rest);
  return {
    model: tier,
    args: [
      "--model", tier,
      ...containmentArgs(workersLogDir(config ?? defaultWorkersConfig())),
      "-p", "--no-session-persistence",
    ],
    env: { ...env, [DAEMON_LLM_ENV_MARKER]: "1" },
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
export async function planLlmSpawn(
  tier: ModelTier,
  configPath?: string,
  probe: () => Promise<boolean> = probeRouter
): Promise<LlmSpawnPlan> {
  let provider: WorkerProvider | null = null;
  let providerName: string | null = null;
  let config: WorkersConfig | null = null;
  try {
    const { workers } = readWorkersSection(configPath);
    // the section is kept even when routing is off: its logDir is where the
    // containment config lives, on every path, provider or fallback
    config = workers;
    if (workers.enabled) {
      const target = resolveTarget(workers, workersLogDir(workers), { sessionEnv: {} });
      provider = target.provider;
      providerName = target.providerName;
    }
  } catch {
    // no usable provider configured — the tier-alias fallback keeps the
    // feature alive exactly as it behaved before providers existed. The
    // section (when it parsed) is kept: its logDir still decides where the
    // containment config lives.
    provider = null;
    providerName = null;
  }
  if (!provider || !providerName || !config) return legacyPlan(tier, config);
  return providerPlan(provider, providerName, config, tier, undefined, probe);
}

/** The spawn plan of one resolved provider; `modelId` overrides the tier's model. */
async function providerPlan(
  provider: WorkerProvider,
  providerName: string,
  config: WorkersConfig,
  tier: ModelTier,
  modelId: string | undefined,
  probe: () => Promise<boolean>,
  timeoutMs: number = LLM_TIMEOUT_MS[tier]
): Promise<LlmSpawnPlan> {
  const logDir = workersLogDir(config);
  let proxyUrl: string | undefined;
  if (provider.protocol === "openai") {
    mkdirSync(logDir, { recursive: true });
    proxyUrl = `${await ensureProxyRunning(proxyPort(), logDir)}/${providerName}`;
  }

  const model = modelId ?? tierModel(provider, tier);
  // loopback providers take the router (prefix fixes); down or `router: false` stays direct
  const viaRouter = proxyUrl ? undefined : await loopbackRouterChoice(provider, providerName, undefined, probe);
  return {
    model,
    args: [
      "--model", model,
      ...containmentArgs(logDir),
      "-p", "--no-session-persistence",
    ],
    env: { ...buildRunEnv(provider, true, proxyUrl, providerName, viaRouter), [DAEMON_LLM_ENV_MARKER]: "1" },
    timeoutMs,
    provider: providerName,
  };
}

/** Default `sessionSummary.model`: the local model PAI already runs, the cloud tier only when none answers. */
export const DEFAULT_SUMMARY_MODEL = "local";
/** A local model is slower than a cloud tier: its budget is the thorough tier's. */
const LOCAL_TIMEOUT_MS = LLM_TIMEOUT_MS.opus;

export interface SummaryPlanDeps {
  configPath?: string;
  probe?: () => Promise<boolean>;
  /** Seam: the running local provider's name, or throws when none answers (default: resolveLocalProvider). */
  resolveLocal?: (workers: WorkersConfig, logDir: string) => Promise<{ name: string }>;
}

/**
 * Plan the session-summary spawn from `sessionSummary.model`:
 *   local (default)    the running local provider (what `pai worker run --local` resolves to);
 *                      the cloud `tier` when no local provider answers
 *   haiku|sonnet|opus  that cloud tier
 *   <provider>[/<model>]  that workers.yaml provider (optionally a concrete model id);
 *                      the cloud `tier` when it is not configured
 * The Anthropic API key is never passed (buildRunEnv / legacyPlan both drop it).
 */
export async function planSummarySpawn(
  spec: string | undefined,
  tier: ModelTier,
  deps: SummaryPlanDeps = {}
): Promise<LlmSpawnPlan> {
  const want = (spec ?? DEFAULT_SUMMARY_MODEL).trim() || DEFAULT_SUMMARY_MODEL;
  const probe = deps.probe ?? probeRouter;
  if (want === "haiku" || want === "sonnet" || want === "opus") return planLlmSpawn(want, deps.configPath, probe);
  let workers: WorkersConfig;
  try {
    workers = readWorkersSection(deps.configPath).workers;
  } catch {
    return planLlmSpawn(tier, deps.configPath, probe);
  }
  const logDir = workersLogDir(workers);
  let name: string;
  let modelId: string | undefined;
  let local = false;
  if (want === "local") {
    try {
      name = (await (deps.resolveLocal ?? resolveLocalProvider)(workers, logDir)).name;
    } catch {
      return planLlmSpawn(tier, deps.configPath, probe);
    }
    local = true;
  } else {
    const slash = want.indexOf("/");
    name = slash < 0 ? want : want.slice(0, slash);
    modelId = slash < 0 ? undefined : want.slice(slash + 1) || undefined;
  }
  const provider = workers.providers[name];
  if (!provider) return planLlmSpawn(tier, deps.configPath, probe);
  const isLocal = local || isLocalProvider(provider.baseUrl);
  return providerPlan(provider, name, workers, tier, modelId, probe, isLocal ? LOCAL_TIMEOUT_MS : LLM_TIMEOUT_MS[tier]);
}
