/**
 * run-env.ts — the provider environment every Claude Code spawn must run with.
 *
 * Extracted from run.ts so daemon-side background spawns (session summaries,
 * context handovers, KG extraction) go through the exact same env the worker
 * runner uses, instead of importing the whole runner into the daemon.
 */

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

import { loadConfig } from "../daemon/config.js";
import { ROUTER_PORT } from "../router/router.js";
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
 *
 * PAI_WORKER_ALLOW_HIDDEN is the operator's own consent to run a worker with
 * no pane. It must die at the spawn boundary like the session identities
 * above: a worker (or a daemon born of an operator shell) never passes the
 * consent on, so "allowed hidden" applies only to the process it was set for.
 */
const HEADLESS_STRIP_VARS = ["ENABLE_TOOL_SEARCH", "PAI_WORKER_ALLOW_HIDDEN"] as const;

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

/**
 * Environment for a run through `provider`. Caller's env minus the Anthropic
 * key. `routerEnabled` routes the run through the local model router instead
 * of the provider's own URL (the openai-protocol proxy route always wins);
 * unset keeps the provider-direct route.
 */
export function buildRunEnv(
  provider: WorkerProvider,
  headless: boolean,
  proxyUrl?: string,
  providerName?: string,
  routerEnabled?: boolean
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  if (headless) {
    for (const k of SESSION_IDENTITY_VARS) delete env[k];
    for (const k of HEADLESS_STRIP_VARS) delete env[k];
    // workers have no memory to recall; the auto-memory prompt only sends
    // them to read a MEMORY.md that does not exist
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  }

  if (provider.native) {
    // Plain Claude Code on its own OAuth/Max-plan login: no base URL, no
    // token, no provider-specific model pins — and none inherited from a
    // shell that had a different provider exported into it either.
    for (const k of NATIVE_STRIP_VARS) delete env[k];
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    if (headless) {
      env.PAI_WORKER = "1";
      env.PAI_WORKER_PROVIDER = "anthropic";
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
  } else if (routerEnabled) {
    // Router on: the run goes through the local model router, which resolves
    // the requested model to this provider, injects the key itself and logs
    // usage+cache per session — the same settings.json pin an interactive
    // session uses (5f870a4). A provider-direct route would send the same
    // traffic past that accounting entirely (measured 2026-10-17: pooled
    // slots carried 87% cache while the router log had zero rows for them),
    // so there is no provider-direct fallback while the router is enabled.
    env.ANTHROPIC_BASE_URL = routerUrl();
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
    // read by the whisper-rules hook: a non-anthropic worker gets no operator rules
    if (providerName) env.PAI_WORKER_PROVIDER = providerName;
    // A local model gets the task, not the operator's interactive-session
    // overhead (user+project CLAUDE.md, memory index): it echoed that text
    // instead of working (2026-10-15). The two switches cannot separate user
    // from project CLAUDE.md, so both go. The output style is dropped in
    // claudeCommand via --settings.
    env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = "1";
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  } else {
    env.ENABLE_TOOL_SEARCH = "true";
  }
  return env;
}

/** First-party route a native run is pinned to when caveman is off. */
export const ANTHROPIC_FIRST_PARTY_URL = "https://api.anthropic.com";

/** Loopback URL of the local model router — the route every accounted run takes. */
export function routerUrl(): string {
  return `http://127.0.0.1:${ROUTER_PORT}`;
}

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
export function claudeCommand(env: NodeJS.ProcessEnv, caveman: boolean, routerEnabled?: boolean): string[] {
  const route = env.ANTHROPIC_BASE_URL;
  if (!route && caveman) {
    if (onPath("caveman", env)) return ["caveman", "claude"];
    process.stderr.write("pai: workers.caveman is on but `caveman` is not on PATH; running claude directly\n");
  }
  // set by buildRunEnv for a headless non-anthropic worker: no operator output style
  const extra = env.CLAUDE_CODE_DISABLE_CLAUDE_MDS === "1" ? { outputStyle: "default" } : undefined;
  return ["claude", ...pinnedSettingsArgs(env, routerEnabled, extra)];
}

const PINNED_KEYS = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
];

/**
 * `--settings` argv pinning the provider's route, token and tier models: the
 * user settings' env outranks the process env, so a provider launch would
 * otherwise authenticate its token against the user's proxy (401). Shared by
 * workers and interactive `pai launch`. A native run (no provider route) is
 * pinned to the local model router when router.enabled, so `/model` can switch
 * provider and every request is accounted; else to api.anthropic.com.
 * `extra` spreads over the settings object (claudeCommand uses it to drop the
 * operator output style for a headless non-anthropic worker).
 */
export function pinnedSettingsArgs(
  env: NodeJS.ProcessEnv,
  routerEnabled: boolean = loadConfig().router.enabled,
  extra?: Record<string, unknown>
): string[] {
  const native = routerEnabled ? routerUrl() : ANTHROPIC_FIRST_PARTY_URL;
  const pinned: Record<string, string> = { ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL || native };
  if (env.ANTHROPIC_BASE_URL) for (const k of PINNED_KEYS) if (env[k]) pinned[k] = env[k] as string;
  return ["--settings", JSON.stringify({ env: pinned, ...extra })];
}

function onPath(bin: string, env: NodeJS.ProcessEnv): boolean {
  return (env.PATH ?? "").split(delimiter).some((d) => d && existsSync(join(d, bin)));
}
