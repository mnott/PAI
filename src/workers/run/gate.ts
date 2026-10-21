/**
 * run/gate.ts — pre-spawn admission: pool run, capacity/stagger gates, local provider guard, moved verbatim out of
 * run.ts (split plan). run.ts re-exports everything here so every
 * existing import path keeps working.
 */

import { spawn } from "node:child_process";
import { isLocalProvider, type WorkerProvider, type WorkersConfig } from "../config.js";
import { isLoopbackProvider } from "../run-env.js";
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
  newWorkerId,
  loadStatus,
  saveStatus,
  markStartFailed,
  nowStamp,
} from "../status.js";
import { resolveSession, resolveSpawnerSession } from "../scope.js";
import { committedFallThrough, fallThroughReason } from "../policy.js";
import {
  admitCap,
  capacityGate,
  queuedText,
  sessionScopeKey,
  type CapacityOpts,
} from "../capacity.js";
import { staggerGate } from "../stagger.js";
import { detectSessionName } from "../session-name.js";
import { getProfile } from "../session-profile.js";
import { followCommand, resolveHostSession } from "../pane.js";
import { commitLines, worktreeWanted } from "../worktree.js";
import { promptTrailer } from "../report.js";
import { extendLimit } from "../deadline.js";
import { aibrokerMessenger } from "../run-events.js";
import { ownerOf } from "../local-idle.js";
import {
  poolIneligibleReason,
  poolSettings,
  postTaskToPool,
  type PoolTaskResponse,
} from "../pool.js";
import { type ExecuteArgs } from "./types.js";
import { requireVisiblePane, announcePane, paneHandles, spawnOwned } from "./pane-handles.js";
import { printResult } from "./finalise.js";
import { tryEscalate, rerunOnCloud } from "./escalate.js";

/** A named local provider that is disabled or whose server does not answer. */
export class LocalProviderRefusedError extends Error {}

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
  if (!settings.enabled || a.orchestrate) return null; // an orchestrator needs its own env and contract, not a warm slot
  const cwd = a.cwd ?? process.cwd();
  // spares are the pool's default use; the multi-task continuation path only runs behind workers.pool.continuation
  const claim = !settings.continuation;
  if (claim && settings.spares <= 0) return null;
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
  if (reason) {
    if (claim) a.spareMiss = reason;
    appendLedger(ledgerPath(a.logDir), "WORKER-POOL-SKIP", {
      id: a.id ?? "-",
      provider: a.target.providerName,
      reason,
    });
    if (!a.quiet) process.stderr.write(`[pai worker] pool: not pooled (${reason}) — spawning fresh\n`);
    return null;
  }
  const wid = a.id ?? newWorkerId();
  // same follow pane as a fresh spawn, once per run: a decline falls back to executeRun, which reuses this.
  // The pane is open (or verified) before the task is posted.
  const preparePane = async (): Promise<void> => {
    if (a.paneOpening) return a.paneOpening; // gateStart already started it, beside admission
    if (a.panePrepared) return;
    const paneT0 = Date.now();
    const term = (await resolveHostSession()).term;
    const ledger = ledgerPath(a.logDir);
    const verified = await requireVisiblePane(a.logDir, a.config, wid, term, a.noPane, false, ledger);
    a.panePrepared = { verified };
    a.setupPaneMs = Date.now() - paneT0;
    const status = loadStatus(a.logDir, wid);
    if (status) {
      if (verified) status.pane = { opened: true, exec: true };
      else await announcePane(a.logDir, a.config, wid, term, a.noPane, ledger, status);
      saveStatus(a.logDir, status);
    } else if (!verified) {
      await announcePane(a.logDir, a.config, wid, term, a.noPane, ledger);
    }
  };
  const panePending = preparePane();
  // no pane, no claim: a pooled task must never start unseen. A failed pane falls through to the fresh spawn,
  // which re-attempts it and applies the pane-failure behaviour (the run is refused).
  const paneFailed = await panePending.then(() => null, (e: unknown) => (e instanceof Error ? e.message : String(e)));
  if (paneFailed !== null) {
    a.spareMiss = "pane failed";
    appendLedger(ledgerPath(a.logDir), "WORKER-POOL-SKIP", { id: wid, provider: a.target.providerName, reason: "pane failed" });
    if (!a.quiet) process.stderr.write(`[pai worker] pool: not pooled (pane failed) — spawning fresh\n`);
    return null;
  }
  // the process lives in the pool host, so the pane that owns this run follows its transcript instead of
  // wrapping it. Started as soon as the host has bound the run (a miss keeps the pane for the fresh spawn).
  let following: Promise<void> | null = null;
  const followInPane = (): Promise<void> => {
    following ??= panePending.then(async () => {
      if (!paneHandles.has(wid)) return; // no pane owns this run (no terminal, hidden run allowed)
      const argv = [...followCommand(wid).split(" "), "--auto-exit"];
      const proc = await spawnOwned(wid, argv, { env: process.env, cwd, stdio: ["ignore", "pipe", "pipe"], title: `${a.label ?? wid} (pooled)` });
      proc.on("error", () => undefined);
    });
    return following;
  };
  const poll = setInterval(() => {
    if (loadStatus(a.logDir, wid)?.pool) void followInPane().catch(() => undefined);
  }, 150);
  const limitMinutes = a.limit && a.limit.minutes > 0 ? a.limit.minutes : null;
  // the socket bounds connect+send only; the answer takes as long as the task
  const timeoutMs = limitMinutes ? limitMinutes * 2 * 60_000 + 120_000 : 7_200_000;
  let resp: PoolTaskResponse | null;
  const postT0 = Date.now();
  try {
    resp = await postTaskToPool(
      settings.port,
      {
        id: wid,
        label: a.label,
        prompt: a.parsed.prompt ?? "",
        provider: a.target.providerName,
        model: a.model,
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
      claim ? "/claim" : "/task"
    );
  } catch {
    resp = null;
  }
  clearInterval(poll);
  const postMs = Date.now() - postT0;
  if (resp === null) {
    a.spareMiss = "host-unreachable";
    process.stderr.write(`[pai worker] pool: host unreachable on port ${settings.port} — spawning fresh\n`);
    return null;
  }
  if (!resp.pooled) {
    a.spareMiss = resp.reason ?? "refused";
    // a claim miss is already on the ledger as WORKER-POOL-MISS (host side)
    if (!claim) {
      appendLedger(ledgerPath(a.logDir), "WORKER-POOL-SKIP", {
        id: a.id ?? "-",
        provider: a.target.providerName,
        reason: resp.reason ?? "refused",
      });
    }
    if (!a.quiet) process.stderr.write(`[pai worker] pool: not pooled (${resp.reason ?? "refused"}) — spawning fresh\n`);
    return null;
  }
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
    const why = fallThroughReason(a.route, st, report);
    const commits =
      st.worktreeDir && st.worktreeBase
        ? commitLines(st.worktreeDir, st.worktreeBase)
        : st.branch && st.commits ? [`${st.commits} commit(s) on ${st.branch}`] : [];
    // kept for review (it committed) stays: no cloud re-run, no escalation
    const reviewed = committedFallThrough(why, commits);
    const escalated = await tryEscalate(a, wid, st, report, resp.resultEvent?.result, commits, why ?? (st.loopStopped ? "loop-guard stop" : null), !!reviewed);
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

/**
 * Capacity gate, then stagger gate, for one headless run — the single place
 * both the pooled and the fresh-spawn path pass through. `status` is the
 * run's saved status; its capacity/warmup/last fields carry the queue line.
 */
export async function runGates(a: ExecuteArgs, wid: string, status: WorkerStatus): Promise<void> {
  const { logDir, target, config } = a;
  const saved = status.last;
  const gate: CapacityOpts = {
    logDir,
    self: { id: wid, provider: target.providerName },
    cap: admitCap(target.provider.maxConcurrent, target.provider.conversationSlots, isLocalProvider(target.provider.baseUrl)),
    config: config.capacity,
    disabled: a.noQueue,
    priority: a.priority,
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
  };
  // the session's own limit ("one after the other"): same gate, counted per session across providers
  const max = status.sessionKey ? getProfile(status.sessionKey)?.max_parallel : undefined;
  if (status.sessionKey && max) {
    const key = status.sessionKey;
    await capacityGate({ ...gate, scope: { key: sessionScopeKey(key), label: `session ${key}`, holds: (s) => s.sessionKey === key }, cap: max });
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
  const spawner = resolveSpawnerSession(a.logDir, a.cwd ?? process.cwd());
  const status: WorkerStatus = {
    id: wid,
    pid: process.pid,
    runPid: process.pid,
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
    const verified = await requireVisiblePane(a.logDir, a.config, wid, term, a.noPane, false, ledger);
    a.panePrepared = { verified };
    a.setupPaneMs = Date.now() - paneT0;
    if (verified) status.pane = { opened: true, exec: true };
    else await announcePane(a.logDir, a.config, wid, term, a.noPane, ledger, status);
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
