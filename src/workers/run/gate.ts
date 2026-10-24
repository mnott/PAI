/**
 * run/gate.ts — pre-spawn admission: pool run, capacity/stagger gates, local provider guard, moved verbatim out of
 * run.ts (split plan). run.ts re-exports everything here so every
 * existing import path keeps working.
 */

import { spawn } from "node:child_process";
import { ANTHROPIC_NATIVE, isLocalProvider, readWorkersCached, resolveModelCapability, type PriorityConfig, type QueuePriority, type WorkerProvider, type WorkersConfig } from "../config.js";
import { shortText } from "../args.js";
import { isLoopbackProvider, nativeLaunchEnv } from "../run-env.js";
import {
  httpModelsCheck,
  LOCAL_MECHANISM_LINE,
  PORT_TIMEOUT_MS,
  probeLoopback,
  providerHostPort,
  type PortCheck,
} from "../local-provider.js";
import { appendLedger } from "../ledger.js";
import { ledgerPath } from "../paths.js";
import {
  type WorkerStatus,
  isTerminal,
  newWorkerId,
  loadStatus,
  saveStatus,
  markStartFailed,
  nowStamp,
  selfProcStart,
} from "../status.js";
import { resolveSession, resolveSpawnerSession } from "../scope.js";
import { paneHandles } from "./pane-handles.js";
import { committedFallThrough, fallThroughReason } from "../policy.js";
import {
  admitCap,
  capacityGate,
  capacityOf,
  queuedText,
  sessionScopeKey,
  type CapacityOpts,
  type QueuedFile,
} from "../capacity.js";
import { staggerGate } from "../stagger.js";
import { detectSessionName } from "../session-name.js";
import { getProfile, isBatchEnv, resolveWorkers, type ResolveCtx } from "../session-profile.js";
import { currentSessionName } from "../session-profile-store.js";
import { detectSessionProvider, SESSION_WORKER_PROVIDER_ENV } from "../session-provider.js";
import { escalatedLine, escalationSummary, tierAbove, tierOf } from "../escalation.js";
import { readRoutingState } from "../routing.js";
import { parseEntry } from "../route-lists.js";
import { runEscalation } from "../escalate-run.js";
import { getProviderOrNative } from "../config.js";
import { resolveLocalProvider } from "../local-provider.js";
import { routeRun } from "../policy.js";
import { runWorker } from "./worker-ref.js";
import { UNLABELED } from "../status.js";
import { followCommand, resolveHostSession } from "../pane.js";
import { commitLines, commitsSince, salvageOnExit, worktreeWanted } from "../worktree.js";
import { promptTrailer } from "../report.js";
import { extendLimit } from "../deadline.js";
import { aibrokerMessenger } from "../run-events.js";
import { ownerOf } from "../local-idle.js";
import { batteryGateRefusal, isBenchmarkLabel } from "../../daemon/battery-guard.js";
import {
  poolIneligibleReason,
  poolSettings,
  postTaskToPool,
  reloadInProgress,
  splitSharedSpec,
} from "../pool.js";
import { ensurePoolHost } from "../pool-cli.js";
import { type ExecuteArgs } from "./types.js";
import { requireVisiblePane, announcePane, spawnOwned, pooledFollowSpawn } from "./pane-handles.js";
import { SIGNAL_SALVAGE_MS, printResult } from "./finalise.js";
import { tryEscalate, rerunOnCloud } from "./escalate.js";
import { executeRun } from "./execute.js";

/** A named local provider that is disabled or whose server does not answer. */
export class LocalProviderRefusedError extends Error {}

/** The battery guard holds new local-model work (src/daemon/battery-guard.ts). */
export class BatteryGuardRefusedError extends Error {}

/**
 * The battery guard's refusal for a run resolved onto a local (loopback)
 * provider while the guard has paused new local work, or null when admission
 * is open. Cloud runs are untouched; the message names the reading and the
 * config keys that move the thresholds.
 */
export function batteryGuardRefusal(
  local: boolean,
  logDir: string,
  name: string,
  now: number = Date.now(),
  refusal?: string | null,
  benchmark = false
): string | null {
  if (refusal === undefined) refusal = batteryGateRefusal(now, benchmark);
  if (!local || !refusal) return null;
  appendLedger(ledgerPath(logDir), "BATTERY-GATE-REFUSED", { provider: name, reason: refusal });
  return (
    `provider "${name}" is a local (loopback) provider and the battery guard has ${benchmark ? "stopped benchmark runs" : "paused new local-model work"}: ` +
    `${refusal}. This run is refused instead of starting.\n` +
    `Raise power.batteryGuard.pauseBelowPct, or set power.batteryGuard.enabled: false, in config.yaml.`
  );
}

/**
 * A provider named for this run (--provider, a class pin, a profile, a
 * policy pin, a resume) that is loopback must be enabled and its server
 * must answer the HTTP models probe — the same probe resolveLocalProvider
 * uses. Refused immediately otherwise: never wait for a down local server,
 * never run on a disabled one. The message names the provider, what is
 * wrong with it, which local provider IS running (if any), and the fix.
 * Remote providers pass untouched; a run already resolved by --local passes
 * untouched (its server was probed by resolveLocalProvider itself).
 */
export async function assertLocalProviderAlive(
  config: WorkersConfig,
  logDir: string,
  name: string,
  p: WorkerProvider,
  opts: { localFlag?: boolean; _localCheck?: PortCheck } = {}
): Promise<void> {
  if (opts.localFlag || !isLoopbackProvider(p)) return;
  const check = opts._localCheck ?? httpModelsCheck;
  if (!p.enabled) {
    const running = Object.entries(await probeLoopback(config, check))
      .filter(([, up]) => up)
      .map(([n]) => n);
    throw new LocalProviderRefusedError(
      `provider "${name}" is a local (loopback) provider and is disabled — it cannot run this worker.` +
        (running.length ? `\nRunning local provider: ${running.join(", ")}.` : "\nNo local model server is running.") +
        `\n${LOCAL_MECHANISM_LINE}`
    );
  }
  const hp = providerHostPort(p);
  const up = hp ? await check(hp.host, hp.port, PORT_TIMEOUT_MS) : false;
  if (up) return;
  const running = Object.entries(await probeLoopback(config, check))
    .filter(([n, isUp]) => isUp && n !== name)
    .map(([n]) => n);
  throw new LocalProviderRefusedError(
    `provider "${name}" is a local (loopback) provider whose server does not answer on ${hp ? `${hp.host}:${hp.port}` : "its port"} — ` +
      `it is not running. This run is refused instead of waiting for it.` +
      (running.length ? `\nRunning local provider: ${running.join(", ")}.` : "\nNo local model server is running.") +
      `\n${LOCAL_MECHANISM_LINE}`
  );
}

/** A run that does not use the pool: the one place that writes its WORKER-POOL-SKIP line and the stderr line. */
export interface PoolSkipCtx {
  logDir: string;
  quiet?: boolean;
  id?: string;
  spareMiss?: string;
}

export function recordPoolSkip(
  a: PoolSkipCtx,
  providerName: string,
  reason: string,
  extra: { key?: string; grant?: string; id?: string } = {}
): void {
  appendLedger(ledgerPath(a.logDir), "WORKER-POOL-SKIP", {
    id: extra.id ?? a.id ?? "-",
    provider: providerName,
    reason,
    ...(extra.key ? { key: extra.key } : {}),
    ...(extra.grant ? { grant: extra.grant } : {}),
  });
  if (!a.quiet) process.stderr.write(`pai worker: not pooled (${reason}); running unpooled\n`);
}

const grantText = (allowedTools: string[]): string =>
  allowedTools.flatMap((e) => e.split(",")).map((x) => x.trim()).filter((x) => x && x !== "ToolSearch" && !x.startsWith("mcp__")).join(",");

/** Why this run is not pooled before any host is asked, or null when the pool may take it. */
function poolPreReason(a: ExecuteArgs): { reason: string | null; claim: boolean; cwd: string } {
  const settings = poolSettings(a.config);
  const cwd = a.cwd ?? process.cwd();
  const claim = !settings.continuation;
  if (a.opts?.noPool) return { reason: "opted-out", claim, cwd };
  if (!settings.enabled) return { reason: "pool-off", claim, cwd };
  if (a.orchestrate) return { reason: "orchestrate", claim, cwd }; // an orchestrator needs its own env and contract, not a warm slot
  // spares are the pool's default use; the multi-task continuation path only runs behind workers.pool.continuation
  if (claim && settings.spares <= 0) return { reason: "spares-off", claim, cwd };
  const reason = poolIneligibleReason({
    headless: a.parsed.headless,
    prompt: a.parsed.prompt,
    providerName: a.target.providerName,
    provider: a.target.provider,
    nativeAllowed: settings.native,
    worktreeWanted:
      a.parsed.headless && !a.printCmd && worktreeWanted(a.worktreeFlag, { cwd, allowedTools: a.parsed.allowedTools }),
    slotWorktree: claim || isLoopbackProvider(a.target.provider),
    resumeOf: a.resumeOf,
    printCmd: a.printCmd,
    parsed: a.parsed,
    mcpFlag: a.mcpFlag,
    noBrowser: a.noBrowser,
    outputFormat: a.parsed.outputFormat,
    cwd,
  });
  return { reason, claim, cwd };
}

/**
 * The worker session pool attempt (src/workers/pool.ts), behind
 * workers.pool.enabled: an eligible headless task is shipped to the pool
 * host and runs as the next user turn of a warm claude slot, so the
 * provider prompt cache carries over. Returns the exit code when the task
 * ran pooled; null sends the caller down the normal fresh-spawn path (host
 * unreachable, or the task needs a setup a slot cannot provide — worktree on a non-loopback provider,
 * own system prompt, MCP, another cwd, native Anthropic).
 */
export async function tryPoolRun(a: ExecuteArgs): Promise<number | null> {
  const settings = poolSettings(a.config);
  const { reason, claim, cwd } = poolPreReason(a);
  if (reason) {
    if (claim) a.spareMiss = reason;
    recordPoolSkip(a, a.target.providerName, reason, {
      ...(reason === "tools" ? { grant: grantText(a.parsed.allowedTools) } : {}),
    });
    return null;
  }
  const wid = a.id ?? newWorkerId();
  // same follow pane as a fresh spawn, once per run: a decline falls back to executeRun, which reuses this.
  // The pane is open (or verified) before the task is posted.
  const preparePane = async (): Promise<void> => {
    if (a.paneOpening) {
      await a.paneOpening; // gateStart already started it, beside admission; its failure is kept in paneError
      if (a.paneError) throw a.paneError;
      return;
    }
    if (a.panePrepared) return;
    const paneT0 = Date.now();
    const term = (await resolveHostSession()).term;
    const ledger = ledgerPath(a.logDir);
    const verified = await requireVisiblePane(a.logDir, a.config, wid, term, a.systemWaiver, false, ledger);
    a.panePrepared = { verified };
    a.setupPaneMs = Date.now() - paneT0;
    const status = loadStatus(a.logDir, wid);
    if (status) {
      if (verified) status.pane = { opened: true, exec: true };
      else await announcePane(a.logDir, a.config, wid, term, a.systemWaiver, ledger, status);
      saveStatus(a.logDir, status);
    } else if (!verified) {
      await announcePane(a.logDir, a.config, wid, term, a.systemWaiver, ledger);
    }
  };
  const panePending = preparePane();
  // no pane, no claim: a pooled task must never start unseen. A failed pane falls through to the fresh spawn,
  // which re-attempts it and applies the pane-failure behaviour (the run is refused).
  const paneFailed = await panePending.then(() => null, (e: unknown) => (e instanceof Error ? e.message : String(e)));
  if (paneFailed !== null) {
    a.spareMiss = "pane failed";
    recordPoolSkip(a, a.target.providerName, "pane failed", { id: wid });
    return null;
  }
  // the process lives in the pool host, so the pane that owns this run follows its transcript instead of
  // wrapping it. Started as soon as the host has bound the run (a miss keeps the pane for the fresh spawn).
  let following: Promise<void> | null = null;
  const followInPane = (): Promise<void> => {
    following ??= panePending.then(async () => {
      if (!paneHandles.has(wid)) return; // no pane owns this run (no terminal, hidden run allowed)
      const argv = [...followCommand(wid).split(" "), "--auto-exit"];
      const proc = await spawnOwned(wid, argv, pooledFollowSpawn(wid, a.label, a.logDir, cwd));
      proc.on("error", () => undefined);
      // the host owns the status file; the pane that follows this run is its registered pane
      const st = loadStatus(a.logDir, wid);
      if (st) saveStatus(a.logDir, { ...st, pane: { opened: true, exec: true } });
    });
    return following;
  };
  const poll = setInterval(() => {
    if (loadStatus(a.logDir, wid)?.pool) void followInPane().catch(() => undefined);
  }, 150);
  const limitMinutes = a.limit && a.limit.minutes > 0 ? a.limit.minutes : null;
  // the socket bounds connect+send only; the answer takes as long as the task
  const timeoutMs = limitMinutes ? limitMinutes * 2 * 60_000 + 120_000 : 7_200_000;
  const postT0 = Date.now();
  // the claim carries the provider this run actually resolved to: a spare
  // claimed on another provider would run the task on the wrong model
  const claimProvider = await resolveClaimProvider(a);
  const claimModel = claimProvider === a.target.providerName ? a.model : claimModelOf(a.config, claimProvider, a.target.modelAlias ?? null);
  const outcome = await postTaskToPool(
    settings.port,
    {
      id: wid,
      label: a.label,
      prompt: a.parsed.prompt ?? "",
      provider: claimProvider,
      model: claimModel,
      cwd,
      className: a.className,
      capability: a.capability,
      specPath: a.specPath,
      parent: a.parent,
      stage: a.stage,
      clientPid: process.pid,
      reportFormat: a.reportFormat,
      outputFormat: a.parsed.outputFormat === "json" ? "json" : "text",
      maxMinutes: limitMinutes,
      trailer: promptTrailer(a.reportFormat),
      worktree: a.parsed.headless && !a.printCmd && worktreeWanted(a.worktreeFlag, { cwd, allowedTools: a.parsed.allowedTools }),
      ...(claim ? { runStartedAt: a.runT0 ?? Date.now() } : {}),
      ...(a.admissionMs !== undefined ? { admissionMs: a.admissionMs } : {}),
    },
    timeoutMs,
    claim ? "/claim" : "/task",
    () => reloadInProgress(a.logDir)
  );
  clearInterval(poll);
  const postMs = Date.now() - postT0;
  if (!("ok" in outcome)) {
    // a claim miss is also on the ledger as WORKER-POOL-MISS (host side, spare counters); this is the run's skip line
    const why = "miss" in outcome ? outcome.miss : outcome.error;
    a.spareMiss = why;
    if (!("miss" in outcome) && outcome.error === "unreachable") void ensurePoolHost(a.logDir).catch(() => undefined);
    // the answer never arrived or broke mid-task: the task may or may not
    // have run — the host's status decides, then escalate if it died
    if (!("miss" in outcome) && outcome.error === "claim-error") {
      return escalateAfterClaimError(a, wid, outcome.detail);
    }
    // the host died mid-task or refused the task outright: the task did not
    // finish — escalate one tier up (or re-run fresh), never a silent failure
    if ("miss" in outcome && outcome.miss === "host-error") {
      return escalateAfterPoolUnreachable(a, wid, why);
    }
    // the host was busy: a local run must not fall through to a fresh spawn
    // on the same busy local server — it escalates one tier up instead. Only
    // when the run actually started in the host (a live status): a busy
    // answer with no status means the task never ran, so it takes the plain
    // skip path and the fresh spawn, gated exactly once like any other miss
    // (2026-10-23: a declined busy attempt was gated again by the respawn and
    // the escalation re-ran a task that never started)
    if ("miss" in outcome && outcome.miss === "busy" && a.spawnT0 !== undefined) {
      return escalateAfterBusy(a, wid);
    }
    recordPoolSkip(a, a.target.providerName, why, { id: wid, key: `${a.target.providerName}/${a.model ?? "-"}` });
    return null;
  }
  const resp = outcome.ok;
  await followInPane().catch(() => undefined); // a task that ended before the poll saw it still leaves its transcript in the pane
  a.onWorkerStart?.(wid);
  if (claim && a.setupPaneMs !== undefined) {
    // the pane finishes beside the claim, so the host cannot know it: the client adds the pane share of the setup
    appendLedger(ledgerPath(a.logDir), "WORKER-SETUP", { id: wid, setupPaneMs: a.setupPaneMs, admissionMs: a.admissionMs, claimMs: postMs });
  }
  const rc = resp.rc ?? 1;
  let report = resp.report ?? null;
  // the ending a fresh run has: a failed local run is kept for review when it committed, else re-run once on the cloud
  const st = resp.status ?? loadStatus(a.logDir, wid);
  if (st && a.parsed.headless) {
    // the host's slot release may already have dropped the branch and the
    // worktree fields (a stopped run with nothing committed): salvage first,
    // then read the commits — without them the loop-stop escalation has no
    // trigger and the run ends without ever going up a tier (2026-10-23)
    const commits = st.worktreeDir && st.worktreeBase ? commitLines(st.worktreeDir, st.worktreeBase) : [];
    const why = fallThroughReason(a.route, st, report) ?? (st.loopStopped ? "loop-guard stop" : st.timedOut ? "max-minutes" : null);
    // kept for review (it committed) stays: no cloud re-run, no escalation
    const reviewed = committedFallThrough(why, commits);
    const escalated = await tryEscalate(a, wid, st, report, resp.resultEvent?.result, commits, why, !!reviewed);
    if (escalated !== null) return escalated;
    if (reviewed) {
      process.stderr.write(`pai worker: ${wid} ended badly but committed — kept for review, no cloud re-run\n`);
      appendLedger(ledgerPath(a.logDir), "WORKER-FALLTHROUGH-REVIEW", { id: wid, reason: reviewed.why });
      report = { ...(report ?? {}), ...reviewed };
      st.claimsContinue = true;
      saveStatus(a.logDir, st);
    } else if (why && a.route && !st.escalated) {
      return rerunOnCloud(a, wid, why, st);
    }
  }
  if (!a.quiet) {
    printResult(a.parsed.outputFormat, resp.resultEvent ?? null, rc, a.logDir, wid, report);
  }
  return rc;
}

/** A status that still names a live process: the host's own record of the run. */
function statusIsLive(st: WorkerStatus | null): st is WorkerStatus {
  return !!st && !isTerminal(st.state);
}

/**
 * The host's slot died mid-task (crash, kill, deadline) and the client-side
 * status still names a live process: the run ended in the host's eyes but
 * `pai worker ps` would keep showing it running forever. Record the host's
 * end on the status and the ledger, and salvage the slot's worktree onto the
 * branch before the host drops it.
 */
function finaliseHostDeath(a: ExecuteArgs, wid: string, st: WorkerStatus, why: string): void {
  const logDir = a.logDir;
  const ledger = ledgerPath(logDir);
  const salvaged =
    st.worktreeDir && st.worktreeBase ? salvageOnExit(ledger, wid, st.label || wid, st.worktreeDir, SIGNAL_SALVAGE_MS) : [];
  if (salvaged.length) st.commits = commitsSince(st.worktreeDir!, st.worktreeBase!);
  st.state = "failed";
  st.rc = 1;
  st.last = shortText(`pool slot died mid-task: ${why}`, 90);
  st.updated = nowStamp();
  saveStatus(logDir, st);
  const started = Date.parse(st.started.replace(" ", "T"));
  appendLedger(ledger, "WORKER-END", {
    id: wid,
    provider: st.provider,
    mode: "pooled",
    model: st.model,
    rc: 1,
    ...(Number.isFinite(started) ? { secs: Math.max(0, Math.floor((Date.now() - started) / 1000)) } : {}),
    label: st.label,
    note: `pool slot died mid-task: ${why}`,
  });
}

/**
 * The fresh-spawn half of a pooled run that died in the host: the task was
 * never executed, so it runs again as a fresh spawn — the same path a pool
 * miss takes. The host's end is recorded first so the id is terminal and the
 * new run owns the id (a queued placeholder status is left as it is: the
 * fresh run rewrites it at its start).
 */
async function respawnAfterHostDeath(a: ExecuteArgs, wid: string, why: string): Promise<number> {
  const st = loadStatus(a.logDir, wid);
  if (statusIsLive(st)) finaliseHostDeath(a, wid, st, why);
  recordPoolSkip(a, a.target.providerName, "host-error", { id: wid });
  return executeRun(a);
}

/**
 * The cloud target an escalation would re-run on: the tier above the run's
 * tier (escalation.ts), else the escalate.cloud target. A loopback tier is
 * not an escalation target — the cloud is. null when nothing usable is
 * configured (the run then stays where it is, like an escalation with no tier
 * above).
 */
function cloudEscalationTarget(config: WorkersConfig, className: string | undefined): { provider: string; model: string } | null {
  const tiers = config.tiers ?? [];
  const tier = tierOf(tiers, className);
  const above = tier ? tierAbove(tiers, tier) : null;
  const { provider: name, model } = above && !above.session && above.models.length ? parseEntry(above.models[0]) : config.escalate.cloud;
  const p = getProviderOrNative(config, name);
  if (!p || !p.enabled || isLoopbackProvider(p)) return null;
  // the native login needs no model pin: the subscription's default answers
  if (name === ANTHROPIC_NATIVE || p.native) return { provider: name, model: model ?? "" };
  return { provider: name, model: model ?? resolveModelCapability(p, "default") };
}

/**
 * A local run the pool host could not finish (host-error: the slot died
 * mid-task, the host refused, or the answer never arrived) must not end as a
 * silent rc-1 failure: it escalates one tier up whenever escalation is
 * enabled — with or without commits and with or without a result event — and
 * otherwise re-runs fresh on the cloud once (the fall-through rule), or runs
 * the task fresh on the same local target. A killed run (rc 143) is the
 * operator's call: nothing restarts it.
 */
export async function escalateAfterHostError(a: ExecuteArgs, wid: string, why: string): Promise<number> {
  const { logDir, config } = a;
  const st = loadStatus(logDir, wid);
  if (st?.rc === 143) return 143;
  // no status at all: the host never took the task, so nothing died — the
  // task runs fresh on the same target (the plain skip path), not escalated
  if (!st) return respawnAfterHostDeath(a, wid, why);
  if (statusIsLive(st)) finaliseHostDeath(a, wid, st, why);
  const label = a.label ?? st?.label ?? UNLABELED;
  const tiers = config.tiers ?? [];
  const from = tierOf(tiers, a.className);
  const above = from ? tierAbove(tiers, from) : null;
  const already = a.escalatedFrom ?? [];
  const trigger = { kind: "repeated-failure" as const, reason: `pool host ended the run (${why})` };
  const commits = st?.worktreeDir && st?.worktreeBase ? commitLines(st.worktreeDir, st.worktreeBase) : [];
  const branch = st?.branch ?? undefined;
  const p0 = a.parsed.prompt;
  let swapped = false;
  const rerunOpts = (o: { providerFlag: string; modelFlag?: string; prompt: string; label: string; escalatedFrom: string[]; onStarted: (id: string) => void }): Promise<number> =>
    (a.runner ?? runWorker)({
      providerFlag: o.providerFlag,
      modelFlag: o.modelFlag,
      label: o.label,
      claudeArgs: a.claudeArgs.map((x) => (!swapped && x === p0 ? ((swapped = true), o.prompt) : x)),
      _escalatedFrom: o.escalatedFrom,
      _route: undefined,
      onWorkerStart: (id2) => {
        if (st) {
          st.escalatedTo = id2;
          saveStatus(logDir, st);
        }
        o.onStarted(id2);
        a.onWorkerStart?.(id2);
      },
    });
  // the task text as the host receives it: the escalation summary prepends to
  // the unit part, the shared block stays the shared block (the spare's prefix cache)
  const spec = splitSharedSpec(a.parsed.prompt ?? "").unit;
  const ledger = ledgerPath(logDir);
  const markEscalated = (line: string): void => {
    if (!st) return;
    st.escalated = line;
    st.last = line;
    saveStatus(logDir, st);
  };
  // the tier above, when escalation is on and that tier is not the session
  // and this task has not already escalated out of `from` (no ping-pong)
  // escalation and the cloud fall-through are a local run's; a cloud run re-runs on its own target
  const localRun = !!a.route?.local || isLoopbackProvider(a.target.provider);
  if (localRun && config.escalate.enabled && from && above && !above.session && above.models.length && !already.includes(from)) {
    const out = await runEscalation(
      {
        action: { action: "rerun", from, to: above },
        trigger,
        summary: escalationSummary({ id: wid, label, from, to: above.id, trigger, done: st?.last, commits, branch }),
        line: escalatedLine(from, above.id, trigger.reason),
      },
      already,
      { ledger, id: wid, label, spec, fromModel: st?.model, markEscalated, rerun: rerunOpts, notifySession: async () => undefined }
    );
    if (out.kind === "rerun") return out.rc;
  }
  const target = cloudEscalationTarget(config, a.className);
  // the fall-through rule is a local run's: a cloud run that died in the host
  // re-runs fresh on its own target, not once more on the cloud
  if (localRun && target && a.route) {
    appendLedger(ledger, "WORKER-FALLTHROUGH", { id: wid, reason: `pool host ended the run (${why})` });
    process.stderr.write(`pai worker: ${wid} on ${a.target.providerName} ended in the pool host (${why}) — re-running on the cloud\n`);
    return (a.runner ?? runWorker)({
      ...a.opts,
      id: undefined,
      // the cloud's own route: a --local run must not drag the local server onto the cloud
      localFlag: undefined,
      localName: undefined,
      providerFlag: target.provider,
      modelFlag: target.model || undefined,
      label: `${label} (fall-through)`,
      _route: { policy: a.route.policy, reason: `fall-through (pool host: ${why})`, local: false },
      _fallThroughOf: wid,
      onWorkerStart: (id2) => {
        if (st) {
          st.fallThroughTo = id2;
          saveStatus(logDir, st);
        }
        a.onWorkerStart?.(id2);
      },
    });
  }
  return respawnAfterHostDeath(a, wid, why);
}

/**
 * The pool host's answer was unreadable or never arrived: the task may or may
 * not have run, and the host's status (when it made one) is the authority.
 * A run the host finished is reported as it is; a run still marked live died
 * in the host and escalates like any host-error.
 */
export async function escalateAfterClaimError(a: ExecuteArgs, wid: string, detail: string): Promise<number | null> {
  const st = loadStatus(a.logDir, wid);
  // no status: the host never took the task — the plain skip path runs it
  // fresh, one skip line, no escalation of a run that never started
  if (!st) {
    recordPoolSkip(a, a.target.providerName, "claim-error", { id: wid, key: `${a.target.providerName}/${a.model ?? "-"}` });
    return null;
  }
  if (isTerminal(st.state)) {
    const rc = st.rc ?? 1;
    if (!a.quiet) printResult(a.parsed.outputFormat, null, rc, a.logDir, wid, null);
    return rc;
  }
  return escalateAfterHostError(a, wid, `claim-error: ${detail}`);
}

/**
 * The pool host answered "busy": the task never ran. A local run must not
 * silently fall through to a fresh spawn on the same local server (a busy
 * local machine is busy for a fresh spawn too): it escalates one tier up
 * instead. A cloud run keeps the fresh-spawn path.
 */
export async function escalateAfterBusy(a: ExecuteArgs, wid: string): Promise<number> {
  if (!a.route?.local) return respawnAfterHostDeath(a, wid, "busy");
  return escalateAfterHostError(a, wid, "busy");
}

/**
 * The host was unreachable or its socket timed out: the task never ran. A
 * local run escalates one tier up instead of spawning fresh on the same local
 * server; a cloud run keeps the fresh-spawn path.
 */
export async function escalateAfterPoolUnreachable(a: ExecuteArgs, wid: string, why: string): Promise<number> {
  if (!a.route?.local) return respawnAfterHostDeath(a, wid, why);
  return escalateAfterHostError(a, wid, why);
}

/**
 * The provider a headless run goes out on, the same resolution runWorker
 * applies (--local, the session profile, the routing policy, the class
 * tier): the pool host's claim carries a provider name, and a spare claimed
 * on the wrong provider runs the task on the wrong model (2026-10-23: a
 * --local run escalated to the cloud was claimed by a local spare and ran on
 * the local model with the cloud's label).
 */
export async function resolveClaimProvider(a: ExecuteArgs): Promise<string> {
  const config = a.config;
  const opts = a.opts ?? {};
  if (opts.localFlag) {
    const res = await resolveLocalProvider(config, a.logDir, { className: a.className, name: opts.localName });
    return res.name;
  }
  if (opts.providerFlag) return opts.providerFlag;
  if (opts._route?.local && opts._route.reason.startsWith("routing policy")) {
    const routed = await routeRun(config, a.logDir, {
      ...opts,
      className: a.className,
      urgent: opts.urgent,
      localOk: opts.localOk,
      cloud: opts.cloud,
    });
    if (routed?.providerFlag) return routed.providerFlag;
  }
  if (!opts._route && currentSessionName()) {
    const profile = getProfile(currentSessionName());
    // a launch-written pin (workers_implicit) is not a choice: it neither routes
    // here nor lets the inherited launch env decide below
    const env = nativeLaunchEnv();
    if (profile?.workers_implicit) delete env[SESSION_WORKER_PROVIDER_ENV];
    const ctx: ResolveCtx = { cfg: config, profile, env, budgets: {}, routing: readRoutingState(a.logDir) };
    const r = resolveWorkers(
      { explicit: { model: opts.modelFlag ?? (opts.modelFast ? "fast" : opts.modelDefault ? "default" : undefined) }, batch: isBatchEnv() },
      ctx
    );
    if (r.provider) return r.provider;
  }
  const env = nativeLaunchEnv();
  if (getProfile(currentSessionName())?.workers_implicit) delete env[SESSION_WORKER_PROVIDER_ENV];
  const session = detectSessionProvider(config, { env, cwd: a.cwd ?? process.cwd(), logDir: a.logDir, side: "workers" });
  if (session) return session.name;
  return a.target.providerName;
}

/** The model the claimed provider runs the task on: the run's alias, else the provider's default. */
export function claimModelOf(config: WorkersConfig, name: string, alias: string | null): string {
  const p = getProviderOrNative(config, name);
  if (!p) return alias ?? "default";
  return (alias && p.models[alias] !== undefined ? p.models[alias] : undefined) ?? resolveModelCapability(p, "default");
}

/** Priority of a run's queue ticket: the --priority flag, else its named session's workers.priority entry, else normal. */
export function queuePriorityOf(flag: QueuePriority | undefined, status: Pick<WorkerStatus, "sessionKey">, config: { priority?: PriorityConfig }): QueuePriority {
  return flag ?? (status.sessionKey ? config.priority?.sessions[status.sessionKey] : undefined) ?? "normal";
}

/** The pane's queue file content from a gate poll: the run's place in line, its label last. */
function queuedOf(q: QueuedFile, label: string | undefined): QueuedFile {
  return label ? { ...q, label } : q;
}

/**
 * Capacity gate, then stagger gate, for one headless run — the single place
 * both the pooled and the fresh-spawn path pass through. `status` is the
 * run's saved status; its capacity/warmup/last fields carry the queue line.
 */
export async function runGates(a: ExecuteArgs, wid: string, status: WorkerStatus): Promise<void> {
  const { logDir, target, config } = a;
  const saved = status.last;
  const tier = queuePriorityOf(a.queuePriority, status, config);
  // the same level orders this run's requests at a serial local engine (the router reads it from the status file)
  if (!status.priority) {
    status.priority = tier;
    saveStatus(logDir, status);
  }
  const gate: CapacityOpts = {
    logDir,
    self: { id: wid, provider: target.providerName },
    cap: admitCap(target.provider.maxConcurrent, target.provider.conversationSlots, isLocalProvider(target.provider.baseUrl)),
    // a saved config change reaches a run that is already waiting
    capOf: () => {
      try {
        const p = readWorkersCached().providers[target.providerName] ?? target.provider;
        return admitCap(p.maxConcurrent, p.conversationSlots, isLocalProvider(p.baseUrl), capacityOf(config.capacity));
      } catch {
        return undefined;
      }
    },
    // a hold queues new work; a benchmark-labelled run (the bench harness itself) passes it
    holdExempt: isBenchmarkLabel(a.label),
    holdOf: () => {
      try {
        return (readWorkersCached().providers[target.providerName] ?? target.provider).hold?.reason;
      } catch {
        return target.provider.hold?.reason;
      }
    },
    config: config.capacity,
    disabled: a.noQueue,
    priority: a.priority,
    tier,
    log: (line) => {
      process.stderr.write(`${line}\n`);
    },
    alarmMs: (config.waitAlarmMinutes ?? 120) * 60_000,
    onAlarm: (w) => {
      const text = `[pai worker] ${wid} (${status.label}) has waited ${Math.round(w.elapsedSec / 60)} min for a ${w.provider} slot (position ${w.position} of ${w.queued}). It keeps waiting; kill it or reorder with \`pai worker queue\`.`;
      process.stderr.write(`${text}\n`);
      void aibrokerMessenger(logDir).toSession(ownerOf(status), text).catch(() => false);
    },
    onWait: (w) => {
      if (w) {
        // parked at the cap: visible as "queued", never as a slot holder
        status.state = "queued";
        status.capacity = {
          provider: w.provider,
          cap: w.cap,
          total: w.total,
          position: w.position,
          elapsedSec: w.elapsedSec,
          queued: w.queued,
          ...(w.behind ? { behind: w.behind } : {}),
          sinceMs: w.sinceMs,
          ...(w.priority ? { priority: w.priority } : {}),
          ...(w.held !== undefined ? { held: w.held } : {}),
        };
        status.last = queuedText(w);
      } else {
        // slot granted: back to running, and `started` now counts from the grant
        // (spawnTimeOf documents the rewrite; wait-on's ceiling and ps ages use it)
        status.state = "running";
        status.started = nowStamp();
        delete status.capacity;
        status.last = saved;
      }
      saveStatus(logDir, status);
    },
    // the pane opened before the wait shows its place in line (pane-exec reads the file)
    onQueued: (line) => paneHandles.get(wid)?.setQueued(line === null ? null : queuedOf(line, a.label)),
  };
  // the session's own limit ("one after the other"): same gate, counted per session across providers
  const max = status.sessionKey ? getProfile(status.sessionKey)?.max_parallel : undefined;
  if (status.sessionKey && max) {
    const key = status.sessionKey;
    await capacityGate({ ...gate, capOf: undefined, holdOf: undefined, scope: { key: sessionScopeKey(key), label: `session ${key}`, holds: (s) => s.sessionKey === key }, cap: max });
  }
  await capacityGate(gate);
  await staggerGate({
    logDir,
    self: { id: wid, provider: target.providerName },
    local: isLocalProvider(target.provider.baseUrl),
    config: config.stagger,
    disabled: a.noStagger,
    log: (line) => {
      if (!a.quiet) process.stderr.write(`${line}\n`);
    },
    onWait: (w) => {
      if (w) {
        status.warmup = { for: w.predecessor, provider: w.provider, elapsedSec: w.elapsedSec, limitSec: w.limitSec };
        status.last = w.line;
      } else {
        delete status.warmup;
        status.last = saved;
      }
      saveStatus(logDir, status);
    },
  });
}

/**
 * Gate a headless run once, before the pool attempt. A placeholder status
 * (running, this process's pid) is saved first, as a fresh spawn always did,
 * so the run counts as holding a slot the moment it leaves the queue; the pool
 * host or executeRun overwrites it under the same id.
 */
export async function gateStart(a: ExecuteArgs): Promise<void> {
  if (!a.parsed.headless || a.printCmd || a.gated) return;
  const wid = a.id ?? newWorkerId();
  a.id = wid;
  const sessionKey = await detectSessionName();
  // the owning session: what the local scheduler shares slots by
  const spawner = resolveSpawnerSession(a.logDir, a.cwd ?? process.cwd(), process.env);
  const status: WorkerStatus = {
    id: wid,
    pid: process.pid,
    runPid: process.pid,
    procStart: selfProcStart(),
    label: a.label,
    cwd: a.cwd ?? process.cwd(),
    term: "",
    provider: a.target.providerName,
    model: a.model,
    state: "running",
    started: nowStamp(),
    updated: nowStamp(),
    turns: 0,
    tools: 0,
    last: "starting",
    rc: null,
    secs: null,
    origin: "spawn",
    outputFormat: a.parsed.outputFormat,
    ...(sessionKey ? { sessionKey } : {}),
    ...(spawner ? { spawnerSession: spawner } : {}),
  };
  saveStatus(a.logDir, status);
  // the follow pane opens now, not after the queue (a run parked at a cap shows
  // its place in line there, runGates onWait) — and beside admission and the
  // claim, never in front of them: whoever needs the pane settled awaits paneOpening
  const ledger = ledgerPath(a.logDir);
  const paneT0 = Date.now();
  a.paneOpening = (async () => {
    const term = (await resolveHostSession()).term;
    const hostSession = resolveSession(term);
    if (hostSession) {
      status.session = hostSession;
      saveStatus(a.logDir, status);
    }
    const verified = await requireVisiblePane(a.logDir, a.config, wid, term, a.systemWaiver, false, ledger);
    a.panePrepared = { verified };
    a.setupPaneMs = Date.now() - paneT0;
    if (verified) status.pane = { opened: true, exec: true };
    else await announcePane(a.logDir, a.config, wid, term, a.systemWaiver, ledger, status);
    saveStatus(a.logDir, status);
  })().catch((e) => {
    a.paneError = e instanceof Error ? e : new Error(String(e));
    markStartFailed(a.logDir, status, a.paneError);
  });
  const gateT0 = Date.now();
  await runGates(a, wid, status);
  a.admissionMs = Date.now() - gateT0;
  // waiting for a slot is not work: the limit counts from the grant (active time)
  const queued = Date.now() - gateT0;
  if (a.limit && queued >= 1000) {
    a.limit = extendLimit(a.limit, queued);
    a.queueWaitedMs = queued;
  }
  // a gate that never had to wait leaves the placeholder "running" with the
  // spawn stamp; one that queued already flipped back to "running" with the
  // grant stamp (runGates onWait)
  a.gated = true;
}
