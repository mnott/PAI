/**
 * policy.ts — where workers run: one persistent policy plus per-run hints.
 *
 *   cloud-only   never local (battery, on the road)
 *   local-only   never cloud (conserve tokens); fails when no local server answers
 *   prefer-local local first, falls through to cloud on failure
 *   prefer-cloud cloud first (fast turnaround), local only when cloud is unavailable
 *   auto         prefer-local; cloud-only on battery; prefer-cloud for an --urgent run
 *
 * The policy lives in <logDir>/routing-policy.json (not workers.yaml: a runtime
 * switch with an expiry, not provider configuration). An explicit --provider
 * (or --capability) bypasses it entirely. chooseRoute and fallThroughReason
 * are pure; the I/O (battery, ping, quota) is gathered by routeRun.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ANTHROPIC_NATIVE,
  WorkersConfigError,
  getProviderOrNative,
  isLocalProvider,
  type WorkersConfig,
} from "./config.js";
import { cooldownRemaining, quotaExceeded, readRoutingState } from "./routing.js";

export const POLICY_MODES = ["cloud-only", "local-only", "prefer-local", "prefer-cloud", "auto"] as const;
export type PolicyMode = (typeof POLICY_MODES)[number];

export interface PolicyState {
  mode: PolicyMode;
  /** ISO stamp after which the policy no longer applies. */
  until?: string;
  set: string;
}

/** How a run was routed: shown by `pai worker ps`, kept in the worker status. */
export interface RouteInfo {
  policy: PolicyMode;
  reason: string;
  local: boolean;
}

export function policyPath(logDir: string): string {
  return join(logDir, "routing-policy.json");
}

/** The active policy, or null when none is set or it has expired. */
export function readPolicy(logDir: string, now: Date = new Date()): PolicyState | null {
  const path = policyPath(logDir);
  if (!existsSync(path)) return null;
  try {
    const p = JSON.parse(readFileSync(path, "utf8")) as PolicyState;
    if (!(POLICY_MODES as readonly string[]).includes(p.mode)) return null;
    if (p.until && Date.parse(p.until) <= now.getTime()) return null;
    return p;
  } catch {
    return null;
  }
}

export function writePolicy(logDir: string, mode: PolicyMode, forMs?: number, now: Date = new Date()): PolicyState {
  const state: PolicyState = {
    mode,
    ...(forMs ? { until: new Date(now.getTime() + forMs).toISOString() } : {}),
    set: now.toISOString(),
  };
  const tmp = `${policyPath(logDir)}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  renameSync(tmp, policyPath(logDir));
  return state;
}

export function clearPolicy(logDir: string): void {
  if (existsSync(policyPath(logDir))) unlinkSync(policyPath(logDir));
}

/** "30m", "2h", "1d" → milliseconds. */
export function parseDuration(s: string): number {
  const m = /^(\d+)([mhd])$/.exec(s.trim());
  if (!m) throw new WorkersConfigError(`--for: expected a duration like 30m, 2h or 1d, got "${s}"`);
  return Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"];
}

export function onBattery(): boolean {
  try {
    return /Battery Power/.test(execFileSync("pmset", ["-g", "batt"], { encoding: "utf8", timeout: 3000 }));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// route selection
// ---------------------------------------------------------------------------

export interface RouteInputs {
  mode: PolicyMode;
  urgent: boolean;
  localOk: boolean;
  cloud: boolean;
  battery: boolean;
  /** Name of an enabled local provider that answered, or null. */
  local: string | null;
  /** Why `local` is null: "no local provider" (none enabled) or "local down". */
  localWhy: string;
  /** The cloud provider is in cooldown or over its quota. */
  cloudUnavailable: boolean;
}

export type RouteChoice = { local: string; reason: string } | { local: null; reason: string };

export function chooseRoute(i: RouteInputs): RouteChoice {
  const cloud = (reason: string): RouteChoice => ({ local: null, reason });
  const useLocal = (reason: string): RouteChoice => ({ local: i.local!, reason });
  if (i.mode === "cloud-only") return cloud("policy cloud-only");
  if (i.mode === "local-only") {
    if (!i.local) {
      throw new WorkersConfigError(`policy local-only: ${i.localWhy} — start a local server or change the policy (pai worker policy)`);
    }
    return useLocal("policy local-only");
  }
  if (i.mode === "prefer-cloud") {
    if (i.localOk && i.local && !i.cloud) return useLocal("--local-ok");
    if (i.cloudUnavailable && i.local) return useLocal("cloud unavailable");
    return cloud("policy prefer-cloud");
  }
  // prefer-local and auto
  if (i.mode === "auto" && i.battery) return cloud("battery");
  if (i.urgent) return cloud("urgent");
  if (i.cloud) return cloud("--cloud");
  if (!i.local) return cloud(i.localWhy);
  return useLocal(`policy ${i.mode}`);
}

/** One cheap models request; any answer below 500 (a 401 included) means the server is up. */
export async function pingLocal(baseUrl: string, timeoutMs = 4000): Promise<boolean> {
  try {
    const r = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.status < 500;
  } catch {
    return false;
  }
}

/** First enabled, loopback, answering provider in config order. */
export async function findLocal(
  config: WorkersConfig,
  logDir: string,
  ping: (url: string) => Promise<boolean> = pingLocal
): Promise<{ name: string | null; why: string }> {
  const state = readRoutingState(logDir);
  const candidates = Object.entries(config.providers).filter(
    ([name, p]) => p.enabled && p.engine !== "image" && isLocalProvider(p.baseUrl) && cooldownRemaining(state, name) === 0
  );
  if (!candidates.length) return { name: null, why: "no local provider" };
  for (const [name, p] of candidates) if (await ping(p.baseUrl)) return { name, why: "" };
  return { name: null, why: "local down" };
}

export interface RouteFlags {
  urgent?: boolean;
  localOk?: boolean;
  cloud?: boolean;
}

/**
 * The policy decision for one run: null when no policy is set (class/active
 * routing stands), else the provider to pin (null = cloud, normal routing)
 * and the RouteInfo to record.
 */
export async function routeRun(
  config: WorkersConfig,
  logDir: string,
  flags: RouteFlags,
  deps: { ping?: (url: string) => Promise<boolean>; battery?: () => boolean } = {}
): Promise<{ providerFlag: string | null; route: RouteInfo } | null> {
  const policy = readPolicy(logDir);
  if (!policy) return null;
  const mode = policy.mode;
  const needLocal = mode !== "cloud-only";
  const found = needLocal ? await findLocal(config, logDir, deps.ping) : { name: null, why: "" };
  const native = getProviderOrNative(config, ANTHROPIC_NATIVE);
  const cloudUnavailable =
    mode === "prefer-cloud" &&
    (cooldownRemaining(readRoutingState(logDir), ANTHROPIC_NATIVE) > 0 || (native ? quotaExceeded(native) : false));
  const choice = chooseRoute({
    mode,
    urgent: flags.urgent ?? false,
    localOk: flags.localOk ?? false,
    cloud: flags.cloud ?? false,
    battery: mode === "auto" ? (deps.battery ?? onBattery)() : false,
    local: found.name,
    localWhy: found.why,
    cloudUnavailable,
  });
  return { providerFlag: choice.local, route: { policy: mode, reason: choice.reason, local: choice.local !== null } };
}

// ---------------------------------------------------------------------------
// fall-through
// ---------------------------------------------------------------------------

export interface EndedRun {
  reportValid?: boolean;
  timedOut?: boolean;
  rc?: number | null;
  state?: string;
}

/**
 * Why a finished local run should be repeated once on the cloud, or null.
 * Reads the stored result: an invalid report (reportValid false covers a
 * failed AG2 check and the proof-check downgrade), r=- or r=!, a timeout, a
 * crash with no report. A killed run (rc 143) is the operator's call, not a
 * model failure.
 */
export function fallThroughReason(
  route: RouteInfo | undefined,
  status: EndedRun,
  report: { result?: string } | null
): string | null {
  if (!route?.local || route.policy === "local-only") return null;
  if (status.timedOut) return "max-minutes";
  if (status.rc === 143) return null;
  if (status.reportValid === false) return "invalid report";
  if (report?.result === "-" || report?.result === "!") return `r=${report.result}`;
  if (!report && status.state === "failed") return "no report";
  return null;
}

/**
 * A failed local run that already committed is reviewed, not redone: the
 * cloud re-run would repeat finished work. Returns the report override
 * (r=~, commits listed) or null when there is nothing to review.
 */
export function committedFallThrough(
  why: string | null,
  commits: string[]
): { result: "~"; why: string; notes: string } | null {
  if (!why || !commits.length) return null;
  const reason = `local run committed but its report was invalid: ${why}`;
  return { result: "~", why: reason, notes: `${reason}\ncommits: ${commits.join("; ")}` };
}
