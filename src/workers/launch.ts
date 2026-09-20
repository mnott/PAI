/**
 * launch.ts — start the Claude Code harness directly on any provider/model
 * configured in workers.yaml, for an interactive session (`pai launch`).
 *
 * A running claude process cannot switch provider: base URL and auth are
 * fixed at start, so "switch provider" always means "start a new session".
 * Provider/model resolution and the spawn environment are NOT re-derived
 * here — this reuses getProviderOrNative (config.ts, the same lookup
 * routing.ts's resolveTarget uses) and buildRunEnv (run-env.ts, the exact
 * env every worker spawns with). Adding a provider to workers.yaml therefore
 * makes it appear here with no code change.
 */

import {
  ANTHROPIC_NATIVE,
  MODEL_CAPABILITIES,
  WorkersConfigError,
  getProviderOrNative,
  maskKey,
  nativeAnthropicProvider,
  type ModelCapability,
  type WorkerProvider,
  type WorkersConfig,
} from "./config.js";
import { buildRunEnv } from "./run-env.js";
import { DEFAULT_PROXY_PORT, ensureProxyRunning } from "./proxy/server.js";

export class LaunchError extends WorkersConfigError {}

export interface LaunchRow {
  index: number;
  provider: string;
  model: string;
  capability: ModelCapability;
  native: boolean;
  /** This is workers.yaml's configured `active:` provider (not the running
   *  session's actual provider — see detectCurrentProviderName for that). */
  configActive: boolean;
}

/** Providers `pai launch` will start a session on: the built-in anthropic
 *  provider plus every ENABLED configured provider — same population
 *  auto-routing considers (routing.ts), disabled providers excluded. */
export function launchableProviderNames(workers: Pick<WorkersConfig, "providers">): string[] {
  return [
    ANTHROPIC_NATIVE,
    ...Object.entries(workers.providers)
      .filter(([, p]) => p.enabled)
      .map(([name]) => name),
  ];
}

function configActiveName(active: string | null): string {
  return active ?? ANTHROPIC_NATIVE;
}

/**
 * One row per provider x configured model capability (default/fast/image),
 * built-in anthropic first, in workers.yaml provider order. Disabled
 * providers are skipped entirely — this is the sole source `--list` prints
 * and `--provider`/interactive selection accept.
 */
export function buildLaunchRows(
  workers: Pick<WorkersConfig, "active" | "providers" | "nativeModels">
): LaunchRow[] {
  const rows: LaunchRow[] = [];
  let i = 1;
  const activeName = configActiveName(workers.active);
  const native = nativeAnthropicProvider(workers.nativeModels);
  for (const cap of MODEL_CAPABILITIES) {
    const id = native.models[cap];
    if (!id) continue;
    rows.push({
      index: i++,
      provider: ANTHROPIC_NATIVE,
      model: id,
      capability: cap,
      native: true,
      configActive: activeName === ANTHROPIC_NATIVE,
    });
  }
  for (const [name, p] of Object.entries(workers.providers)) {
    if (!p.enabled) continue;
    for (const cap of MODEL_CAPABILITIES) {
      const id = p.models[cap];
      if (!id) continue;
      rows.push({
        index: i++,
        provider: name,
        model: id,
        capability: cap,
        native: false,
        configActive: activeName === name,
      });
    }
  }
  return rows;
}

/**
 * Which configured provider a running claude process's ANTHROPIC_BASE_URL
 * belongs to. No base URL at all is the plain Anthropic login; a base URL
 * that matches no configured provider is treated the same way rather than
 * guessed at. Anthropic-protocol providers match by exact base URL;
 * openai-protocol providers run through the local PAI proxy, whose URL ends
 * in "/<providerName>" (see buildLaunchPlan).
 */
export function detectCurrentProviderName(
  workers: Pick<WorkersConfig, "providers">,
  env: NodeJS.ProcessEnv = process.env
): string {
  const base = env.ANTHROPIC_BASE_URL;
  if (!base) return ANTHROPIC_NATIVE;
  for (const [name, p] of Object.entries(workers.providers)) {
    if (p.protocol === "anthropic" && p.baseUrl && p.baseUrl === base) return name;
  }
  for (const [name, p] of Object.entries(workers.providers)) {
    if (p.protocol === "openai" && base.endsWith(`/${name}`)) return name;
  }
  return ANTHROPIC_NATIVE;
}

/**
 * Best-effort current model id from the environment a `pai launch` session
 * carries. ANTHROPIC_DEFAULT_SONNET_MODEL is set (to the provider's default
 * model id) for every non-native provider by buildRunEnv, but NOT to
 * whichever capability (default/fast/image) was actually chosen — so this
 * is only ever the provider's default model id, never a positive
 * confirmation of the exact running model. Returns null (not a guess) when
 * nothing was set, e.g. the native anthropic provider, which sets no
 * DEFAULT_*_MODEL vars at all.
 */
export function detectCurrentModel(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.ANTHROPIC_DEFAULT_SONNET_MODEL || null;
}

/** Provider by name, or a LaunchError naming the launchable ones. */
export function resolveLaunchProvider(
  workers: Pick<WorkersConfig, "providers" | "nativeModels">,
  name: string
): WorkerProvider {
  const valid = launchableProviderNames(workers);
  const p = getProviderOrNative(workers, name);
  if (!p) {
    throw new LaunchError(`no provider named "${name}". Configured: ${valid.join(", ")}`);
  }
  if (!p.enabled) {
    throw new LaunchError(`provider "${name}" is disabled. Configured: ${valid.join(", ")}`);
  }
  return p;
}

/** The model for a launch: `modelName` if given (must be one of this
 *  provider's configured model ids), else the provider's default. */
export function resolveLaunchModel(provider: WorkerProvider, modelName?: string): string {
  if (!modelName) return provider.models.default;
  const valid = Object.values(provider.models);
  if (!valid.includes(modelName)) {
    throw new LaunchError(`model "${modelName}" is not configured for this provider. Configured: ${valid.join(", ")}`);
  }
  return modelName;
}

export interface LaunchPlan {
  providerName: string;
  provider: WorkerProvider;
  model: string;
  /** Full claude argv (argv[0] "claude" excluded). */
  argv: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * Resolve provider + model and build the exact argv/env `pai launch` execs
 * claude with. Starts the PAI proxy on demand for an openai-protocol
 * provider — the same on-demand start the worker runner uses
 * (run.ts's executeRun).
 */
export async function buildLaunchPlan(
  workers: Pick<WorkersConfig, "providers" | "nativeModels">,
  providerName: string,
  modelName: string | undefined,
  extraArgs: string[],
  logDir: string
): Promise<LaunchPlan> {
  const provider = resolveLaunchProvider(workers, providerName);
  if (provider.engine === "codex") {
    throw new LaunchError(
      `provider "${providerName}" runs through the Codex CLI (engine: codex) — pai launch starts the Claude Code harness only`
    );
  }
  const model = resolveLaunchModel(provider, modelName);

  let proxyUrl: string | undefined;
  if (provider.protocol === "openai") {
    const base = await ensureProxyRunning(DEFAULT_PROXY_PORT, logDir);
    proxyUrl = `${base}/${providerName}`;
  }
  const env = buildRunEnv(provider, false, proxyUrl);
  // buildRunEnv only strips worker identity when headless — an interactive
  // launch is never headless, so a `pai launch` run FROM inside an existing
  // worker (PAI_WORKER=1 already in this process's own environment) would
  // otherwise hand its child that ancestor's marker. PAI_WORKER=1 gates every
  // per-session hook (autosave, stop bookkeeping, the edit-delegation guard —
  // isWorkerSession(), src/hooks/ts/lib/worker-session.ts) into treating a
  // brand-new interactive session as a disposable worker, and PAI_WORKER_ID
  // would misattribute it as a sub-worker of whatever spawned `pai launch`
  // (scope.ts's parent-chain lookup). This IS a new session, not a worker.
  delete env.PAI_WORKER;
  delete env.PAI_WORKER_ID;
  const argv = ["--model", model, ...extraArgs];
  return { providerName, provider, model, argv, env };
}

/** `****abcd`-style masking for `--dry-run` env printing — never the full
 *  token, even the placeholder-free ones ("local" is left as-is: it is not
 *  a secret). */
export function maskLaunchEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    masked[k] = k === "ANTHROPIC_AUTH_TOKEN" && v !== "local" ? maskKey(v) : v;
  }
  return masked;
}
