/**
 * run-env.ts — the provider environment every Claude Code spawn must run with.
 *
 * Extracted from run.ts so daemon-side background spawns (session summaries,
 * context handovers, KG extraction) go through the exact same env the worker
 * runner uses, instead of importing the whole runner into the daemon.
 */

import { readFileSync as readKey } from "node:fs";
import { providerKeyPath, resolveModelCapability, type WorkerProvider } from "./config.js";

/** Environment for a run through `provider`. Caller's env minus the Anthropic key. */
export function buildRunEnv(
  provider: WorkerProvider,
  headless: boolean,
  proxyUrl?: string
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY;

  let token = "local";
  if (proxyUrl) {
    // openai-protocol provider: the proxy holds the real key; the runner only
    // needs a placeholder so Claude Code sends an auth header at all
    env.ANTHROPIC_BASE_URL = proxyUrl;
  } else {
    const keyPath = providerKeyPath(provider);
    if (keyPath) {
      try {
        token = readKey(keyPath, "utf8").trim();
      } catch {
        // the caller turns this into a clear error before spawning
        throw new Error(`key file not readable: ${keyPath}`);
      }
      if (!token) throw new Error(`key file is empty: ${keyPath}`);
    }
    env.ANTHROPIC_BASE_URL = provider.baseUrl;
  }

  env.ANTHROPIC_AUTH_TOKEN = token;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = resolveModelCapability(provider, "fast");
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = provider.models.default;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = provider.models.default;
  for (const [k, v] of Object.entries(provider.env)) env[k] = v;
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  if (headless) {
    env.PAI_WORKER = "1";
  } else {
    env.ENABLE_TOOL_SEARCH = "true";
  }
  return env;
}
