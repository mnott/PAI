/**
 * run-env.ts — the provider environment every Claude Code spawn must run with.
 *
 * Extracted from run.ts so daemon-side background spawns (session summaries,
 * context handovers, KG extraction) go through the exact same env the worker
 * runner uses, instead of importing the whole runner into the daemon.
 */

import { execFile, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { loadConfig } from "../daemon/config.js";
import { routerPort } from "../router/router.js";
import { resolveModelCapability, resolveProviderKey, type WorkerProvider, ANTHROPIC_NATIVE } from "./config.js";
import { workersYamlPath } from "./workers-config.js";
import { loopbackUrl } from "../utils/loopback.js";
import { isLoopbackHostname } from "../utils/loopback.js";

/**
 * Headless workers run their Bash tool under bash: the operator's zsh aborts a whole command on an
 * unmatched glob ("no matches found: --include=*.ts"). CLAUDE_CODE_SHELL is honoured by Claude Code
 * for its Bash tool; an explicit value already in the env wins.
 */
function workerShell(env: NodeJS.ProcessEnv): void {
  if (!env.CLAUDE_CODE_SHELL) env.CLAUDE_CODE_SHELL = "/bin/bash";
}

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

/** 30 min: above max_output_tokens at the slowest observed local rate. */
const LOCAL_API_TIMEOUT_MS = "1800000";

/**
 * Idle watchdogs Claude Code's client keeps on the response stream, both
 * `Math.max(env || 0, 300000)` — 300 s floor. The local server emits no bytes
 * while it generates a tool call's arguments, so a long tool call looks idle
 * and is dropped mid-generation, then retried from scratch (A/B run 1: a
 * ~6600-token Write at ~22 tok/s died at ~300 s; unit u2 lost 28 min).
 */
const LOCAL_STREAM_IDLE_VARS = [
  "CLAUDE_STREAM_IDLE_TIMEOUT_MS",
  "CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS",
] as const;

/** Parent of every per-worker config copy; outside ~/.pai so the worker guard treats the copy as safe. */
export const WORKER_CONFIG_COPY_ROOT = join(tmpdir(), "pai-worker-config");
const COPY_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

/**
 * Point a worker at its own copy of workers.yaml (PAI_WORKERS_YAML, 0600) so a state-changing
 * `pai worker config|providers|...` run from inside the worker cannot touch the live file
 * (2026-10-18: a worker's `inline-keys` replaced every key_file). Provider reads still work off
 * the copy. A caller-set PAI_WORKERS_YAML wins (children inherit the parent's copy); a missing
 * live file or any I/O failure leaves the env alone. Stale copies are pruned here.
 */
export function pinWorkersYamlCopy(env: NodeJS.ProcessEnv, root: string = WORKER_CONFIG_COPY_ROOT): void {
  if (env.PAI_WORKERS_YAML) return;
  try {
    const live = workersYamlPath();
    if (!existsSync(live)) return;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    for (const d of readdirSync(root)) {
      const dp = join(root, d);
      try {
        if (Date.now() - statSync(dp).mtimeMs > COPY_MAX_AGE_MS) rmSync(dp, { recursive: true, force: true });
      } catch { /* raced with another prune */ }
    }
    const dir = mkdtempSync(join(root, "w-"));
    const copy = join(dir, "workers.yaml");
    writeFileSync(copy, readFileSync(live), { mode: 0o600 });
    chmodSync(copy, 0o600);
    env.PAI_WORKERS_YAML = copy;
  } catch {
    /* no copy: the guard still denies the mutating verbs */
  }
}

/**
 * Environment for a run through `provider`. Caller's env minus the Anthropic
 * key. `routerEnabled` routes the run through the local model router instead
 * of the provider's own URL (the openai-protocol proxy route always wins);
 * unset keeps the provider-direct route. `orchestrate` marks a batch-orchestrator worker:
 * PAI_WORKER_ORCHESTRATOR=1 makes the edit gate deny code edits.
 */
export function buildRunEnv(
  provider: WorkerProvider,
  headless: boolean,
  proxyUrl?: string,
  providerName?: string,
  routerEnabled?: boolean,
  orchestrate?: boolean
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  if (headless) {
    for (const k of SESSION_IDENTITY_VARS) delete env[k];
    for (const k of HEADLESS_STRIP_VARS) delete env[k];
    // workers have no memory to recall; the auto-memory prompt only sends
    // them to read a MEMORY.md that does not exist
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
    pinWorkersYamlCopy(env);
  }

  // a child never inherits its spawner's orchestrator mode; only an explicit --orchestrate sets it
  delete env.PAI_WORKER_ORCHESTRATOR;
  // the plan-pane exemption is for the `pai worker run` the plan runner spawned, never for the model process or its children
  if (headless && orchestrate) env.PAI_WORKER_ORCHESTRATOR = "1";

  if (provider.native) {
    // Plain Claude Code on its own OAuth/Max-plan login: no base URL, no
    // token, no provider-specific model pins — and none inherited from a
    // shell that had a different provider exported into it either.
    for (const k of NATIVE_STRIP_VARS) delete env[k];
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    if (headless) {
      env.PAI_WORKER = "1";
      workerShell(env);
      env.PAI_WORKER_PROVIDER = ANTHROPIC_NATIVE;
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
    // names the provider so the router can tell apart providers that declare the same model id
    if (providerName) env.ANTHROPIC_CUSTOM_HEADERS = `x-pai-provider: ${providerName}`;
  } else {
    const resolved = resolveProviderKey(provider);
    if (resolved) token = resolved;
    env.ANTHROPIC_BASE_URL = provider.baseUrl;
  }

  env.ANTHROPIC_AUTH_TOKEN = token;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = resolveModelCapability(provider, "fast");
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = provider.models.default;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = provider.models.default;
  // Long local generations die in Claude Code's client: the stream idle
  // watchdogs above cut a request after 300 s without bytes (a tool call's
  // arguments generate silently), and API_TIMEOUT_MS — whose default in the
  // installed binary is 600000, not 60000 — would cut a 30-min request at
  // 10 min. All three go to 30 min for loopback providers.
  if (isLoopbackProvider(provider)) {
    env.API_TIMEOUT_MS = LOCAL_API_TIMEOUT_MS;
    for (const k of LOCAL_STREAM_IDLE_VARS) env[k] = LOCAL_API_TIMEOUT_MS;
  }
  for (const [k, v] of Object.entries(provider.env)) env[k] = v;
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  // The billing header Claude Code puts first in the system prompt changes on
  // every request (cch=<body hash>); a prefix cache then reuses only the tool
  // definitions in front of it (measured 2026-10-17). Only Anthropic uses it.
  env.CLAUDE_CODE_ATTRIBUTION_HEADER = "0";
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
    workerShell(env);
  } else {
    env.ENABLE_TOOL_SEARCH = "true";
  }
  return env;
}

/** First-party route a native run is pinned to when no route is set. */
export const ANTHROPIC_FIRST_PARTY_URL = "https://api.anthropic.com";

/**
 * Scheduling identity for a router run: x-pai-session names the worker's owning
 * session (what the router's fair queue shares the engine between), x-pai-worker
 * the worker (per-worker queue-wait accounting). Appended to the headers
 * buildRunEnv set; a no-op when the run does not go through the router.
 */
export function addSchedulingHeaders(env: NodeJS.ProcessEnv, ids: { session?: string | null; worker?: string | null }): void {
  const base = env.ANTHROPIC_CUSTOM_HEADERS;
  if (!base || !base.includes("x-pai-provider")) return;
  const clean = (v: string) => v.replace(/[\r\n:]+/g, " ").trim().slice(0, 80);
  const extra: string[] = [];
  if (ids.session && clean(ids.session)) extra.push(`x-pai-session: ${clean(ids.session)}`);
  if (ids.worker && clean(ids.worker)) extra.push(`x-pai-worker: ${clean(ids.worker)}`);
  if (extra.length) env.ANTHROPIC_CUSTOM_HEADERS = [base, ...extra].join("\n");
}

/** Loopback URL of the local model router — the route every accounted run takes. */
export function routerUrl(): string {
  return loopbackUrl(routerPort());
}

/**
 * The argv head every Claude Code spawn starts from, for an env built by
 * buildRunEnv. The user settings' env block outranks the process env
 * (measured 2026-09-22: an unreachable ANTHROPIC_BASE_URL in the process env
 * was ignored while settings.json carried a proxy route, and a glm
 * worker's bearer token ended at Anthropic with a 401), so a route set in
 * `env` is not enough once a machine-wide proxy is installed — it is pinned
 * again with `--settings`, which outranks user settings. A native run is
 * pinned to api.anthropic.com so a global route cannot pull it in either.
 */
export function claudeCommand(env: NodeJS.ProcessEnv, routerEnabled?: boolean): string[] {
  return ["claude", ...pinnedSettingsArgs(env, routerEnabled, claudeSettingsExtra(env))];
}

/** Settings keys beyond the route that a spawn pins: set by buildRunEnv for a headless non-anthropic worker (no operator output style). */
export function claudeSettingsExtra(env: NodeJS.ProcessEnv): Record<string, unknown> | undefined {
  return env.CLAUDE_CODE_DISABLE_CLAUDE_MDS === "1" ? { outputStyle: "default" } : undefined;
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
  return ["--settings", JSON.stringify(pinnedSettings(env, routerEnabled, extra))];
}

/**
 * The settings object behind pinnedSettingsArgs. Claude Code keeps only the
 * LAST `--settings` flag (measured 2026-10-21: a pin followed by the slim
 * profile's file sent a native worker straight to api.anthropic.com), so the
 * slim profile merges this object into its own file instead of trailing it.
 */
export function pinnedSettings(
  env: NodeJS.ProcessEnv,
  routerEnabled: boolean = loadConfig().router.enabled,
  extra?: Record<string, unknown>
): { env: Record<string, string> } & Record<string, unknown> {
  const native = routerEnabled ? routerUrl() : ANTHROPIC_FIRST_PARTY_URL;
  const pinned: Record<string, string> = { ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL || native };
  if (env.ANTHROPIC_BASE_URL) for (const k of PINNED_KEYS) if (env[k]) pinned[k] = env[k] as string;
  return { env: pinned, ...extra };
}

function onPath(bin: string, env: NodeJS.ProcessEnv): boolean {
  return (env.PATH ?? "").split(delimiter).some((d) => d && existsSync(join(d, bin)));
}

export function isLoopbackProvider(p: WorkerProvider): boolean {
  return isLoopbackUrl(p.baseUrl);
}

function isLoopbackUrl(url: string): boolean {
  try {
    return isLoopbackHostname(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Whether a run through `provider` takes the router: loopback (local model
 * server) providers do, so the router's prefix-cache fixes (billing-header
 * strip, folded trailing system messages) apply; `router: false` or a down
 * router keeps the direct URL. Native and remote providers are untouched.
 */
export function routeLoopbackViaRouter(provider: WorkerProvider, routerUp: boolean): boolean {
  if (provider.native || provider.protocol === "openai") return false;
  if (provider.router === false || !isLoopbackUrl(provider.baseUrl)) return false;
  return routerUp;
}

/**
 * The `routerEnabled` argument buildRunEnv needs for a spawn that has no
 * worker-run context (pool slots, daemon LLM calls): the global router flag,
 * or — for a loopback provider — whether the router answers a probe. Router
 * down for a loopback provider writes one line and runs direct.
 */
export async function loopbackRouterChoice(
  provider: WorkerProvider,
  providerName: string,
  globalOn: boolean | undefined,
  probe: () => Promise<boolean>
): Promise<boolean | undefined> {
  if (globalOn || provider.native || provider.protocol === "openai") return globalOn;
  if (provider.router === false || !isLoopbackProvider(provider)) return globalOn;
  const up = routeLoopbackViaRouter(provider, await probe());
  if (!up) process.stderr.write(`pai: router down, ${providerName} runs direct (no router prefix fix)\n`);
  return up;
}

/** The probe body, run in a child node so the sync launch path can wait on it. */
const PROBE_SCRIPT = `
const c = (e) => (e && (e.code || (e.errors && e.errors[0] && e.errors[0].code) || (e.cause && e.cause.code))) || (e && e.name) || "error";
const [url, model, ms] = process.argv.slice(1);
const u = new URL(url + "/v1/messages");
const body = JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "." }] });
const req = require(u.protocol === "https:" ? "node:https" : "node:http").request(u, {
  method: "POST",
  headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "content-length": Buffer.byteLength(body) },
  timeout: Number(ms),
}, (r) => {
  let t = "";
  r.on("data", (d) => { t += d; });
  r.on("end", () => {
    let m = t.slice(0, 200);
    try { m = JSON.parse(t).error.message ?? m; } catch {}
    console.log(JSON.stringify({ status: r.statusCode, message: m }));
  });
});
req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
req.on("error", (e) => console.log(JSON.stringify({ code: c(e) })));
req.end(body);
`;


const PROBE_TIMEOUT_MS = 3000;
const PROBE_MODEL = "claude-haiku-4-5";

export interface RouteProbe {
  live: boolean;
  /** Operator-facing reason when not live. */
  reason?: string;
  /** Operator-facing fix when not live. */
  fix?: string;
}

/** Interprets the probe child's output: 4xx = live (401 expected, nothing was
 *  sent that could be accepted), refused/timeout/5xx = a broken hop. */
export function interpretProbe(route: string, out: string): RouteProbe {
  let r: { status?: number; code?: string; message?: string };
  try {
    r = JSON.parse(out.trim());
  } catch {
    return { live: false, reason: `router at ${route} gave no answer`, fix: "start it with: pai router start" };
  }
  if (r.status !== undefined) {
    if (r.status < 500) return { live: true };
    return {
      live: false,
      reason: `router upstream failed (${r.status}: ${r.message ?? ""})`, fix: "check router.claudeUpstream in config.yaml",
    };
  }
  return { live: false, reason: `router at ${route} not reachable (${r.code ?? "error"})`, fix: "start it with: pai router start" };
}

/** Async probe of `route` — one unauthenticated POST /v1/messages, max_tokens 1. */
export function probeRoute(route: string, model: string = PROBE_MODEL): Promise<RouteProbe> {
  return new Promise((resolve) => {
    execFile(process.execPath, ["-e", PROBE_SCRIPT, route, model, String(PROBE_TIMEOUT_MS)], { timeout: PROBE_TIMEOUT_MS + 2000 }, (_e, out) =>
      resolve(interpretProbe(route, out ?? ""))
    );
  });
}

/** Sync probe for the interactive launch path. No credential is sent. */
export function probeRouteSync(route: string, model: string = PROBE_MODEL): RouteProbe {
  const r = spawnSync(process.execPath, ["-e", PROBE_SCRIPT, route, model, String(PROBE_TIMEOUT_MS)], {
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS + 2000,
  });
  return interpretProbe(route, r.stdout ?? "");
}

export interface NativePreflight {
  /** Whether the session may be pinned to the router. */
  routerEnabled: boolean;
  /** The probe verdict; absent when nothing was probed (router off, or a provider route). */
  probe?: RouteProbe;
}

/**
 * The one preflight for every interactive native launch that would pin the
 * router: router enabled, no provider route in `env`, and the route dead
 * (router down, or its upstream failing) = one stderr line naming the hop and
 * the fix, and the session is pinned to api.anthropic.com instead. A provider
 * route (ANTHROPIC_BASE_URL set) is never probed. Headless worker spawns do not
 * call this: they are accounted through the router by design.
 */
export function nativeRoutePreflight(
  env: NodeJS.ProcessEnv,
  model?: string,
  probe: (route: string, model?: string) => RouteProbe = probeRouteSync,
  routerEnabled: boolean = loadConfig().router.enabled
): NativePreflight {
  if (!routerEnabled || env.ANTHROPIC_BASE_URL) return { routerEnabled };
  const p = probe(routerUrl(), model);
  if (p.live) return { routerEnabled: true, probe: p };
  process.stderr.write(`pai: ${p.reason} — launching direct to ${ANTHROPIC_FIRST_PARTY_URL}; ${p.fix}\n`);
  return { routerEnabled: false, probe: p };
}

/**
 * `--settings` argv for a native interactive launch: [] when the route is
 * live (or router off), else the first-party pin from nativeRoutePreflight.
 */
export function nativeLaunchSettingsArgs(
  env: NodeJS.ProcessEnv,
  model?: string,
  probe: (route: string, model?: string) => RouteProbe = probeRouteSync,
  routerEnabled: boolean = loadConfig().router.enabled
): string[] {
  const pf = nativeRoutePreflight(env, model, probe, routerEnabled);
  return pf.probe && !pf.probe.live ? pinnedSettingsArgs(env, false) : [];
}

/** The dry-run line for a preflight verdict; null when nothing was probed. */
export function routeVerdictLine(probe: RouteProbe | undefined): string | null {
  if (!probe) return null;
  return probe.live ? "route live" : `route broken: ${probe.reason} — falls back to ${ANTHROPIC_FIRST_PARTY_URL}; ${probe.fix}`;
}
