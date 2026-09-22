/**
 * run-env.ts — the provider environment every Claude Code spawn must run with.
 *
 * Extracted from run.ts so daemon-side background spawns (session summaries,
 * context handovers, KG extraction) go through the exact same env the worker
 * runner uses, instead of importing the whole runner into the daemon.
 */

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

import { resolveModelCapability, resolveProviderKey, type WorkerProvider } from "./config.js";

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
    const resolved = resolveProviderKey(provider);
    if (resolved) token = resolved;
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

/** First-party route a native run is pinned to when caveman is off. */
export const ANTHROPIC_FIRST_PARTY_URL = "https://api.anthropic.com";

/**
 * The argv head every Claude Code spawn starts from, for an env built by
 * buildRunEnv. The user settings' env block outranks the process env
 * (measured 2026-09-22: an unreachable ANTHROPIC_BASE_URL in the process env
 * was ignored while settings.json carried a caveman proxy route, and a glm
 * worker's bearer token ended at Anthropic with a 401), so a route set in
 * `env` is not enough once a machine-wide proxy is installed — it is pinned
 * again with `--settings`, which outranks user settings. A native run goes
 * through `caveman claude` when workers.caveman is on and the CLI is on
 * PATH; off, it is pinned to api.anthropic.com so a global route cannot
 * pull it in either.
 */
export function claudeCommand(env: NodeJS.ProcessEnv, caveman: boolean): string[] {
  const route = env.ANTHROPIC_BASE_URL;
  if (!route && caveman) {
    if (onPath("caveman", env)) return ["caveman", "claude"];
    process.stderr.write("pai: workers.caveman is on but `caveman` is not on PATH; running claude directly\n");
  }
  return ["claude", "--settings", JSON.stringify({ env: { ANTHROPIC_BASE_URL: route || ANTHROPIC_FIRST_PARTY_URL } })];
}

function onPath(bin: string, env: NodeJS.ProcessEnv): boolean {
  return (env.PATH ?? "").split(delimiter).some((d) => d && existsSync(join(d, bin)));
}
