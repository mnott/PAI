/**
 * local-only.ts — the machine-wide local-only window (`pai budget local-only`).
 *
 * While a weekly cloud budget runs down, the operator closes the window:
 * `pai budget local-only --until "YYYY-MM-DD HH:MM"`. Every automatic cloud
 * start and every session's own cloud request is refused until that time —
 * judged on the run's RESOLVED provider (a class whose chain contains a cloud
 * entry still runs local while a local server answers);
 * only the gatekeeper session (config key `budget.gatekeeper`, default
 * "PAI") can open a one-time exception with `pai budget approve`, and an
 * operator acting directly (`pai worker reroute`, the cockpit) always passes:
 * the window blocks automatic moves and sessions' own cloud starts, never
 * the operator.
 *
 * The state is one small file, <PAI_HOME>/state/local-only.json
 * {untilMs, label, by} — read fresh on every admission (a hook process, a
 * worker CLI start and the daemon each see a window set moments ago).
 * Refusals and approvals land in the routing ledger:
 *
 *   LOCAL-ONLY-REFUSED  kind=<start|reroute> target=<p> reason=<...> session=<s> [id=<worker>]
 *   LOCAL-ONLY-APPROVED worker=<id-or-label> by=<session> until=<ISO>
 *
 * The message is always the same line, so a refused start reads the same from
 * every entry point: "local-only window until <time> (budget): ask the PAI
 * session to approve a cloud run".
 */

import { existsSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { writeJsonAtomic } from "../config/json-store.js";
import { paiHomePath } from "../config/pai-home.js";
import { ANTHROPIC_NATIVE, getProviderOrNative, readWorkersCached, type WorkersConfig } from "./config.js";
import { isLoopbackProvider } from "./run-env.js";
import { appendLedger } from "./ledger.js";
import { ledgerPath } from "./paths.js";
import { detectSessionName } from "./session-name.js";
import { localOnlyMessage, localOnlyPath, readLocalOnly, stampLabel, type LocalOnlyState } from "./local-only-state.js";

export { localOnlyMessage, localOnlyPath, readLocalOnly, type LocalOnlyState };

/** The approval-token file beside it: written by `pai budget approve`, consumed by the next matching cloud start. */
export const approvalsPath = (): string => process.env.PAI_LOCAL_ONLY_FILE ? `${process.env.PAI_LOCAL_ONLY_FILE}.approvals` : paiHomePath("state", "local-only-approvals.json");

/** The config key naming the session allowed to approve cloud runs. */
export const GATEKEEPER_KEY = "budget.gatekeeper";
export const DEFAULT_GATEKEEPER = "PAI";

/** "YYYY-MM-DD HH:MM" as machine-local wall time; null when it does not parse. */
export function parseLocalStamp(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s.trim());
  if (!m) return null;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), m[6] ? Number(m[6]) : 0).getTime();
  return Number.isFinite(t) ? t : null;
}

/** "2h", "90m", "1d" → ms (same shapes as `pai freeze --for`). */
export function parseWindowDuration(s: string): number {
  const m = /^(\d+)([mhd])$/.exec(s.trim().toLowerCase());
  if (!m) throw new Error(`--for: expected a duration like 30m, 2h or 1d, got "${s}"`);
  return Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"];
}

export function setLocalOnly(untilMs: number, by?: string): LocalOnlyState {
  writeJsonAtomic(localOnlyPath(), { untilMs, label: stampLabel(untilMs), ...(by ? { by } : {}) }, { label: "local-only.json" });
  return readLocalOnly(untilMs - 1)!;
}

/** `pai budget local-only off`: the window is gone; a leftover approval file goes with it. */
export function clearLocalOnly(): void {
  try {
    unlinkSync(localOnlyPath());
  } catch {
    /* nothing to clear */
  }
  try {
    rmSync(approvalsPath(), { force: true });
  } catch {
    /* best effort */
  }
}

/** The gatekeeper session name from the main config (default "PAI"). A hook must never fail over an unreadable config. */
export function gatekeeperSession(): string {
  try {
    // lazy: this module is read by hooks and gates that must not pull the daemon config in eagerly
    const { paiConfigFilePath, readMainConfigRaw } = require("../daemon/config.js") as { paiConfigFilePath: () => string; readMainConfigRaw: (p?: string) => Record<string, unknown> };
    const root = readMainConfigRaw(paiConfigFilePath());
    const budget = root.budget as { gatekeeper?: unknown } | undefined;
    const g = budget?.gatekeeper;
    return typeof g === "string" && g.trim() ? g.trim() : DEFAULT_GATEKEEPER;
  } catch {
    return DEFAULT_GATEKEEPER;
  }
}

/** This process's session name (env, registry, project), or undefined. */
export async function currentSession(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  try {
    return await detectSessionName(env);
  } catch {
    return undefined;
  }
}

/** True when this process runs as the gatekeeper session itself. */
export async function isGatekeeperSession(now: number = Date.now(), env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const name = await currentSession(env);
  return !!name && name === gatekeeperSession();
}

// ---------------------------------------------------------------------------
// one-time approvals (written only by the gatekeeper session's `pai budget approve`)
// ---------------------------------------------------------------------------

interface ApprovalFile {
  approvals: Array<{ match: string; expiresAt: number }>;
}

function readApprovals(): ApprovalFile {
  try {
    const j = JSON.parse(readFileSync(approvalsPath(), "utf8")) as ApprovalFile;
    return Array.isArray(j?.approvals) ? { approvals: j.approvals.filter((a) => a && typeof a.match === "string" && typeof a.expiresAt === "number") } : { approvals: [] };
  } catch {
    return { approvals: [] };
  }
}

/** Record an approval for one worker id or label, valid `ttlMs`. */
export function addApproval(match: string, ttlMs: number, now: number = Date.now()): void {
  const f = readApprovals();
  f.approvals.push({ match, expiresAt: now + ttlMs });
  writeJsonAtomic(approvalsPath(), f as unknown as Record<string, unknown>, { label: "local-only-approvals.json" });
}

/**
 * Consume the one-time approval matching `id` or `label`, if any. True only for
 * the first matching cloud start; the token (and every expired one) is dropped.
 */
export function consumeApproval(id: string | undefined, label: string | undefined, now: number = Date.now()): boolean {
  const f = readApprovals();
  const live = f.approvals.filter((a) => a.expiresAt > now);
  const i = live.findIndex((a) => (id && a.match === id) || (!!label && a.match === label));
  if (i < 0) {
    if (live.length !== f.approvals.length) writeJsonAtomic(approvalsPath(), { approvals: live } as unknown as Record<string, unknown>, { label: "local-only-approvals.json" });
    return false;
  }
  live.splice(i, 1);
  writeJsonAtomic(approvalsPath(), { approvals: live } as unknown as Record<string, unknown>, { label: "local-only-approvals.json" });
  return true;
}

// ---------------------------------------------------------------------------
// what counts as a cloud target, and the admission checks
// ---------------------------------------------------------------------------

/** A provider name PAI reads as "the cloud": not configured is remote too (never let an unknown name slip through). */
export function isCloudProviderName(config: WorkersConfig, name: string): boolean {
  if (name === ANTHROPIC_NATIVE) return true;
  const p = getProviderOrNative(config, name);
  return !p || !isLoopbackProvider(p);
}

/**
 * Where a cloud start was asked for: --cloud, --where cloud / a cloud provider
 * name, --provider <cloud>. Deliberately no class-chain check: a class whose
 * route list merely CONTAINS a cloud entry is not a cloud ask — the routing
 * walk (routeRun) picks the running local server first, and this run's RESOLVED
 * provider decides in localOnlyStartCheck. A run that resolves to a local
 * provider always starts (2026-11-19: the chain check refused every start of a
 * cloud-chain class, local ones included).
 */
export interface CloudAsk {
  target: string;
  reason: string;
}

export function detectCloudAsk(
  config: WorkersConfig,
  f: { cloud?: boolean; whereFlag?: string; providerFlag?: string }
): CloudAsk | null {
  if (f.cloud) return { target: "cloud", reason: "--cloud" };
  if (f.whereFlag === "cloud") return { target: "cloud", reason: "--where cloud" };
  if (f.whereFlag && f.whereFlag !== "local" && isCloudProviderName(config, f.whereFlag)) return { target: f.whereFlag, reason: `--where ${f.whereFlag}` };
  if (f.providerFlag && isCloudProviderName(config, f.providerFlag)) return { target: f.providerFlag, reason: `--provider ${f.providerFlag}` };
  return null;
}

export interface LocalOnlyCheck {
  config?: WorkersConfig;
  cloud?: boolean;
  whereFlag?: string;
  providerFlag?: string;
  /** This run's resolved provider (runWorker resolves first): a local one always starts. */
  resolvedProvider?: string;
  id?: string;
  label?: string;
  /** --approved-by <session>: the gatekeeper's standing approval, valid only when it names the configured gatekeeper. */
  approvedBy?: string;
  /** An operator action (reroute from the CLI or the cockpit): always allowed through. */
  byOperator?: boolean;
  logDir?: string;
  now?: number;
}

/**
 * The start-time gate: null lets the run go, a message refuses it. Judged on
 * this run alone — its flags and its RESOLVED provider (runWorker resolves
 * first; the local provider wins when one is up), never on what the class's
 * route chain could contain. A resolved local provider always starts; a cloud
 * ask passes on `--approved-by <gatekeeper>` or on a one-time approval token
 * (written by the gatekeeper session's `pai budget approve`); every refusal is
 * ledgered.
 */
export async function localOnlyStartCheck(o: LocalOnlyCheck): Promise<string | null> {
  const now = o.now ?? Date.now();
  const w = readLocalOnly(now);
  if (!w) return null;
  if (o.byOperator) return null;
  // --approved-by names the gatekeeper session: a standing pass for this start
  if (o.approvedBy && o.approvedBy === gatekeeperSession()) {
    if (o.logDir) appendLedger(ledgerPath(o.logDir), "LOCAL-ONLY-APPROVED", { kind: "flag", target: "cloud", worker: o.id ?? "-", label: o.label ?? "-", by: o.approvedBy });
    return null;
  }
  let config = o.config;
  try {
    config ??= readWorkersCached();
  } catch {
    /* no readable config: only the explicit cloud asks below can be judged */
  }
  // the resolved provider decides first: a run that lands on a local (loopback)
  // provider always starts; one that lands remote is a cloud start even with no flag.
  if (o.resolvedProvider && config) {
    const rp = getProviderOrNative(config, o.resolvedProvider);
    if (rp && isLoopbackProvider(rp)) return null;
  }
  const ask: CloudAsk | null = o.resolvedProvider
    ? // resolved already (runWorker): only a remote provider is this window's cloud
      o.resolvedProvider === ANTHROPIC_NATIVE || !config
      ? { target: o.resolvedProvider, reason: `resolved ${o.resolvedProvider}` }
      : isCloudProviderName(config, o.resolvedProvider)
        ? { target: o.resolvedProvider, reason: `resolved ${o.resolvedProvider}` }
        : null
    : config
      ? detectCloudAsk(config, o)
      : o.cloud
        ? { target: "cloud", reason: "--cloud" }
        : o.whereFlag === "cloud"
          ? { target: "cloud", reason: "--where cloud" }
          : o.whereFlag && o.whereFlag !== "local"
            ? { target: o.whereFlag, reason: `--where ${o.whereFlag}` }
            : o.providerFlag === ANTHROPIC_NATIVE
              ? { target: o.providerFlag, reason: `--provider ${o.providerFlag}` }
              : null;
  if (!ask) return null;
  if (consumeApproval(o.id, o.label, now)) {
    if (o.logDir) appendLedger(ledgerPath(o.logDir), "LOCAL-ONLY-APPROVED", { kind: "consumed", target: ask.target, worker: o.id ?? "-", label: o.label ?? "-" });
    return null;
  }
  const msg = localOnlyMessage(w.label);
  if (o.logDir) {
    const session = (await currentSession()) ?? "-";
    appendLedger(ledgerPath(o.logDir), "LOCAL-ONLY-REFUSED", { kind: "start", target: ask.target, reason: ask.reason.replace(/\s+/g, " "), session });
  }
  return msg;
}

/** A reroute's cloud refusal (automatic moves only); an operator's `by` passes. */
export async function localOnlyRerouteCheck(where: string, d: { logDir: string; by?: string; now?: number }): Promise<string | null> {
  const w = readLocalOnly(d.now ?? Date.now());
  if (!w) return null;
  // an operator action (the CLI, the cockpit) always passes; escalations name themselves
  if (d.by === "cli" || d.by === "cockpit") return null;
  let cloud = where === "cloud";
  if (!cloud) {
    try {
      // a provider name PAI cannot read is treated as remote, never as local: an unreadable config must not slip a cloud move through
      const config = readWorkersCached();
      cloud = isCloudProviderName(config, where);
    } catch {
      cloud = true;
    }
  }
  if (!cloud) return null;
  const session = (await currentSession()) ?? "-";
  appendLedger(ledgerPath(d.logDir), "LOCAL-ONLY-REFUSED", { kind: "reroute", target: where, reason: `where=${where}`.replace(/\s+/g, " "), by: d.by ?? "-", session });
  return localOnlyMessage(w.label);
}

/** The ps/cockpit banner line, or null outside the window. */
export function localOnlyBanner(now: number = Date.now()): string | null {
  const w = readLocalOnly(now);
  return w ? `local only until ${w.label}` : null;
}

/**
 * Where an automatic continuation (fall-through, escalation) may go: the cloud
 * while no window is open and the session's escalate switch stands; during the
 * window, or when the run's session has `escalate off`, the continuation stays
 * local. Pure except for the window file.
 */
export function continuationTarget(
  o: { escalationOff?: boolean; now?: number },
  w: LocalOnlyState | null = readLocalOnly(o.now ?? Date.now())
): "cloud" | "local" {
  if (w) return "local";
  if (o.escalationOff) return "local";
  return "cloud";
}

/** The reason line a locally-continued fall-through carries. */
export const CONTINUED_LOCALLY = "continued locally (local-only)";
