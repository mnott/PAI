/**
 * run-env.ts — the provider environment every Claude Code spawn must run with.
 *
 * Extracted from run.ts so daemon-side background spawns (session summaries,
 * context handovers, KG extraction) go through the exact same env the worker
 * runner uses, instead of importing the whole runner into the daemon.
 */

import { readFileSync as readKey } from "node:fs";
import { providerKeyPath, resolveModelCapability, type WorkerProvider } from "./config.js";

/**
 * Session-identity variables the SPAWNING session leaves in the environment.
 * Inherited, they make a headless child attach to the spawner's messaging
 * socket instead of standing on its own — and a worktree-mode child then
 * starts with its core tools (Bash/Read/…) deferred out of its reach, left
 * with nothing but the tool-registry search (2026-09-18). The child is its
 * own session, so none of these may cross the spawn boundary.
 */
const SESSION_IDENTITY_VARS = [
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_PID",
  "CLAUDECODE",
] as const;

/**
 * Harness settings the spawner's environment carries that a headless worker
 * must not keep. ENABLE_TOOL_SEARCH reaches every pai process through the
 * user settings' env block, so a pai spawned from inside a Claude session
 * passes it on to worker children; inherited, the headless child starts with
 * every core tool deferred out of reach — only ToolSearch remains callable,
 * granted tools included (2026-09-18, verified by stripping exactly this one
 * var). Interactive runs set it deliberately below.
 */
const HEADLESS_STRIP_VARS = ["ENABLE_TOOL_SEARCH"] as const;

/**
 * Provider-specific env vars a native-Anthropic run must never carry — not
 * set by this function, and stripped even when a parent shell exported them
 * (e.g. this worker was itself spawned from a GLM-configured environment).
 */
const NATIVE_STRIP_VARS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
] as const;

/** Environment for a run through `provider`. Caller's env minus the Anthropic key. */
export function buildRunEnv(
  provider: WorkerProvider,
  headless: boolean,
  proxyUrl?: string
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  if (headless) {
    for (const k of SESSION_IDENTITY_VARS) delete env[k];
    for (const k of HEADLESS_STRIP_VARS) delete env[k];
  }

  if (provider.native) {
    // Plain Claude Code on its own OAuth/Max-plan login: no base URL, no
    // token, no provider-specific model pins — and none inherited from a
    // shell that had a different provider exported into it either.
    for (const k of NATIVE_STRIP_VARS) delete env[k];
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    if (headless) {
      env.PAI_WORKER = "1";
    } else {
      env.ENABLE_TOOL_SEARCH = "true";
    }
    return env;
  }

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
