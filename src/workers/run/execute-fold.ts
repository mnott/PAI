/**
 * run/execute-fold.ts — executeRun from the finished argv on: status seed, spawn, the stream-json readline fold,
 * the end-of-run report checks, finaliseRun. State the readline callbacks assign and the code after the await reads
 * lives on one RunState (see execute-prepare.ts).
 */

import { grantedToolNames, recordToolError } from "../tool-errors.js";
import { createToolFold, runProofCheck, proofNote } from "./tool-fold.js";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { openSync, closeSync, writeSync } from "node:fs";
import { shortText } from "../args.js";
import { appendLedger, parseStamp } from "../ledger.js";
import { parentInfo } from "../endreason.js";
import { peekLoopStop } from "../loop-stop.js";
import { TroubleWatcher } from "../worker-trouble.js";
import { reportOriginWithHost, runMessenger } from "../run-report-wiring.js";
import { eventsPath, ledgerPath } from "../paths.js";
import {
  type WorkerStatus,
  loadStatus,
  saveStatus,
  markStartFailed,
  describeTool,
  nowStamp,
  parseSleepSecs,
  selfProcStart,
} from "../status.js";
import { certainContextWindow } from "../../utils/model-window.js";
import { fallThroughReason } from "../policy.js";
import { isBenchmarkLabel } from "../../daemon/battery-guard.js";
import { recordWarmup } from "../stagger.js";
import { autoOrder, isQuotaFailure, nextAutoProvider, setCooldown } from "../routing.js";
import { paneTitle } from "../pane-title.js";
import { isHandoffMessage } from "../handoff.js";
import { markResumed, salvageOnExit, commitLines, recordWorktree } from "../worktree.js";
import {
  promptTrailer,
  parseWorkerReport,
  verifyReportChanges,
  verifyFailNote,
  untrackedPaths,
} from "../report.js";
import { parseDenialText, recordDenial } from "../denials.js";
import { repairAndValidateAg2, validateAg2 } from "../agentish.js";
import { preambleLine } from "../preamble.js";
import { armResultGrace, leftoverNote } from "../result-grace.js";
import { armDeadline } from "../deadline.js";
import { blockedMsOf } from "../active-time.js";
import { createOperatorServer } from "../operator.js";
import { reapRunTree } from "./lifecycle.js";
import { buildsDir, releaseBuildsOf } from "../../builds/queue.js";
import { type StreamEvent, type ExecuteArgs } from "./types.js";
import {
  stdinUserMessage,
  operatorUserText,
  isoStamp,
  usageContextUsed,
  bumpContextTokens,
  resetContextTokensOnCompact,
  isCompactBoundary,
  bashCommand,
  isProgressTool,
  toolResultText,
  toolResultFailed,
  adoptInitModel,
  shouldRetryReport,
  isEmptyResponse,
  runSucceeded,
  initContextWindow,
} from "./stream.js";
import { spawnOwned, preEventFailure, announcePane } from "./pane-handles.js";
import {
  SIGNAL_SALVAGE_MS,
  fireDeadline,
  trackBlocked,
  recordKilledEnd,
  finaliseRun,
  relaunchOptions,
  worktreeExtras,
  identityExtras,
  reaskAg2Report,
  printResult,
} from "./finalise.js";
import { tryEscalate, rerunOn, ranLocal } from "./escalate.js";
import { runWorker } from "./worker-ref.js";
import { runGates } from "./gate.js";
import type { PreparedRun } from "./execute-prepare.js";

export async function foldRun(a: ExecuteArgs, p: PreparedRun): Promise<number> {
  const { config, logDir, target, model, label, parsed, limit, systemWaiver } = a;
  const {
    headless, wid, adopted, cwd, term, paneVerified, session, sessionKey, spawnerSession, worktree, preamble,
    addendum, trailerApplied, env, claudeCmd, cmd, chromeArgs, mcpArgs, toolArgs, toolsFlag, slimArgs, promptText, state,
  } = p;

  // a gate that already ran (gateStart) rewrote `started` at the slot grant;
  // keep that stamp so the deadline and ps age count from the grant
  const gated = a.gated ? loadStatus(logDir, wid) : null;
  const started = gated && Number.isFinite(parseStamp(gated.started))
    ? new Date(parseStamp(gated.started))
    : new Date();
  let status: WorkerStatus = {
    id: wid,
    pid: process.pid,
    runPid: process.pid,
    procStart: selfProcStart(),
    ...parentInfo(),
    label,
    cwd,
    term,
    provider: target.providerName,
    model,
    state: "running",
    started: nowStamp(started),
    updated: nowStamp(),
    turns: 0,
    tools: 0,
    last: headless ? "starting" : "interactive",
    rc: null,
    secs: null,
    // interactive runs ARE the chat pane, not a spawned subagent of it
    origin: headless ? "spawn" : "chat",
    outputFormat: parsed.outputFormat,
    ...(a.route ? { route: a.route } : {}),
    ...(a.routeWhy ? { routeWhy: a.routeWhy } : {}),
    ...(a.modelRecord ?? {}),
    ...(target.via === "auto" && target.switchReason ? { switchReason: target.switchReason } : {}),
    ...(a.fallThroughOf ? { fallThroughOf: a.fallThroughOf } : {}),
    ...(headless ? { reportFormat: a.reportFormat } : {}),
    ...(trailerApplied ? { promptTrailer: true } : {}),
    ...(preamble ? { preamble: { path: preamble.path, hash: preamble.hash } } : {}),
    ...(addendum ? { contractAddendum: { path: addendum.path, sha: addendum.sha } } : {}),
    ...(session ? { session } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(spawnerSession ? { spawnerSession } : {}),
    // no window seed: contextWindow comes from the init event only, and the
    // meter stays hidden until one is announced (never a guessed default)
    ...(a.parent ? { parent: a.parent, stage: a.stage } : {}),
    ...(worktree
      ? {
          worktreeDir: worktree.dir,
          branch: worktree.branch,
          worktreeBase: worktree.base,
          worktreeSnapshot: worktree.snapshot,
        }
      : {}),
    ...(adopted ? { resumedFrom: a.resumeOf } : {}),
    ...(a.specPath ? { spec: a.specPath } : {}),
    ...(limit ? { deadlineAt: limit.deadlineAt, maxMinutes: limit.minutes } : {}),
    ...(a.queueWaitedMs ? { queueWaitedMs: a.queueWaitedMs } : {}),
  };
  saveStatus(logDir, status);
  if (adopted && a.resumeOf) markResumed(logDir, a.resumeOf, wid);
  a.onWorkerStart?.(wid);
  const ledger = ledgerPath(logDir);
  appendLedger(ledger, "WORKER-START", {
    id: wid,
    provider: target.providerName,
    mode: headless ? "headless" : "interactive",
    model,
    cwd,
    label,
    ...(a.capability ? { capability: a.capability } : {}),
    ...(a.specPath ? { spec: a.specPath } : {}),
    ...(target.switchReason ? { switch: target.switchReason } : {}),
  });

  // Follow pane: headless only (interactive runs ARE the chat pane). Verified
  // above when the gate applies; best effort otherwise.
  if (paneVerified) status.pane = { opened: true, exec: true };
  else if (headless) await announcePane(logDir, config, wid, term, systemWaiver, ledger, status);

  // The signal handlers and the one failure path come first: nothing below that can block (gates, the spawn) may run unguarded.
  let spawned: ReturnType<typeof spawn> | undefined;
  let t0 = Date.now();
  let stopDeadline: (() => void) | null = null;
  let stopTrack: (() => void) | null = null;
  let operatorServer: ReturnType<typeof createOperatorServer> | null = null;
  const cleanup = () => {
    stopDeadline?.();
    stopTrack?.();
    if (state.closeTimer) clearTimeout(state.closeTimer);
    operatorServer?.close();
  };
  const onSignal = (sig: string) => {
    state.killed = true;
    recordKilledEnd({ logDir, status, sig, t0, ledger, wid, providerName: target.providerName, model, label });
    // a killed worktree run leaves nothing to merge — drop its worktree and
    // branch too, or every kill strands them for hand-pruning (2026-09-18)
    if (worktree) {
      salvageOnExit(ledger, wid, label, worktree.dir, SIGNAL_SALVAGE_MS);
      try {
        recordWorktree(logDir, status, worktree, false);
      } catch {
        /* best effort: the status already says killed */
      }
    }
    cleanup();
    try {
      spawned?.kill();
    } catch {
      /* already gone */
    }
    // the worker's process tree, build lock and tree go with it (finaliseRun, which reaps, never runs on this path)
    void reapRunTree(worktree?.dir)
      .then(() => releaseBuildsOf(buildsDir(), wid))
      .catch(() => [])
      .finally(() => process.exit(143));
    setTimeout(() => process.exit(143), 2000).unref();
  };
  const sigHandlers = (["SIGTERM", "SIGINT", "SIGHUP"] as const).map((sig) => [sig, () => onSignal(sig)] as const);
  for (const [sig, h] of sigHandlers) process.once(sig, h);
  // A start that dies (gates, spawn, process "error"): the same end as a normal exit — cleanup, status failed with the error, tree reaped, worktree salvaged.
  const failRun = async (e: unknown): Promise<void> => {
    for (const [sig, h] of sigHandlers) process.off(sig, h);
    markStartFailed(logDir, status, e);
    cleanup();
    if (state.troubleTimer) clearInterval(state.troubleTimer);
    if (state.eventsFd !== null) {
      try {
        closeSync(state.eventsFd);
      } catch {
        /* already closed */
      }
      state.eventsFd = null;
    }
    try {
      spawned?.kill();
    } catch {
      /* already gone */
    }
    await reapRunTree(worktree?.dir);
    if (worktree) {
      salvageOnExit(ledger, wid, label, worktree.dir, SIGNAL_SALVAGE_MS);
      try {
        recordWorktree(logDir, status, worktree, false);
      } catch {
        /* best effort: the status already says failed */
      }
    }
  };

  try {
    if (headless && !a.gated) await runGates(a, wid, status);
    spawned = await spawnOwned(wid, cmd, {
      env,
      cwd: worktree?.dir ?? cwd,
      stdio: headless ? ["pipe", "pipe", "pipe"] : "inherit",
      render: "stream",
      title: paneTitle(label, target.providerName),
      statusLine: { kind: "worker", id: wid, logDir },
      // a possible report retry runs after this process ends: the pane closes when the run does
      hold: headless && a.reportFormat === "ag2" && !(a.noReportRetry ?? false),
    });
  } catch (e) {
    await failRun(e);
    throw e;
  }
  const proc = spawned;
  // a spawn failure is emitted on the next tick, before the listener below exists in a headless run
  let earlyError: Error | null = null;
  proc.once("error", (e) => (earlyError = e));
  t0 = Date.now();
  // claude's stderr: passed through, and the tail kept for a start that dies before any model event
  proc.stderr?.on("data", (d: Buffer) => {
    process.stderr.write(d);
    state.stderrTail = (state.stderrTail + d.toString()).slice(-2000);
  });

  // --- stdin lifecycle (2i): prompt in, socket forwards, close 2 s after result
  const armStdinClose = () => {
    if (state.closeTimer) clearTimeout(state.closeTimer);
    state.closeTimer = setTimeout(() => {
      if (state.operatorInFlight === 0) {
        try {
          proc.stdin?.end();
        } catch {
          /* already closed */
        }
      }
    }, 2_000);
  };

  const writeEvent = (obj: Record<string, unknown>): void => {
    if (state.eventsFd === null) return;
    try {
      writeSync(state.eventsFd, JSON.stringify({ ...obj, _ts: isoStamp() }) + "\n");
    } catch {
      // a full disk must not take the worker transcript's process down
    }
  };

  operatorServer = headless
    ? createOperatorServer(logDir, wid, async (text) => {
        const stdin = proc.stdin;
        if (!stdin || !stdin.writable || stdin.writableEnded) {
          return "the worker's stdin is already closed (its turn ended) — use: pai worker resume";
        }
        state.operatorInFlight += 1;
        resultGrace.cancel();
        if (state.closeTimer) {
          clearTimeout(state.closeTimer);
          state.closeTimer = null;
        }
        // a handoff delivery's mirror carries a flag: the viewer shows the
        // inbox ◆ line instead, never both
        writeEvent({ type: "operator", text, handoff: isHandoffMessage(text) });
        return new Promise<void | string>((resolve) => {
          try {
            stdin.write(stdinUserMessage(operatorUserText(text)) + "\n", (e) =>
              resolve(e ? `write to the worker failed: ${e.message}` : undefined)
            );
          } catch (e) {
            resolve(`write to the worker failed: ${(e as Error).message}`);
          }
        });
      })
    : null;

  // A failed Edit fires no hook, so the closest-region hint rides in as a user turn (harness line, not an operator message to answer).
  const injectHarnessHint = (text: string): void => {
    const stdin = proc.stdin;
    if (!headless || !stdin || !stdin.writable || stdin.writableEnded) return;
    try {
      stdin.write(stdinUserMessage(`[harness] ${text}`) + "\n");
    } catch {
      // the hint is a courtesy
    }
  };

  const resultGrace = armResultGrace(headless ? proc.pid : undefined);
  stopDeadline = limit ? armDeadline(proc, limit, () => fireDeadline(logDir, status, ledger, limit), undefined, () => blockedMsOf(logDir, wid)) : null;
  stopTrack = trackBlocked(logDir, status, limit);

  const toolFold = createToolFold({
    logDir,
    worker: wid,
    provider: target.providerName,
    label,
    cwd: worktree?.dir ?? cwd,
    granted: headless ? grantedToolNames(toolsFlag.slice(1), parsed.allowedTools) : undefined,
    inject: injectHarnessHint,
  });
  state.bashRuns = toolFold.bashRuns;
  const untrackedAtStart = new Set(headless ? untrackedPaths(worktree?.dir ?? cwd) : []);

  // setup ends when the worker process holds its first turn; the first answer is timed from there
  const timing: { readyAt: number; firstAt: number | null } = { readyAt: Date.now(), firstAt: null };
  if (headless) {
    // the first user message carries the prompt (the -p value was stripped)
    if (promptText !== null) {
      try {
        timing.readyAt = Date.now();
        proc.stdin!.write(stdinUserMessage(promptText) + "\n");
      } catch {
        /* child died instantly; the close handler reports it */
      }
    }
    const origin = await reportOriginWithHost();
    if (origin) {
      state.trouble = new TroubleWatcher(wid, label, runMessenger(logDir), origin);
      state.troubleTimer = setInterval(() => state.trouble?.tick(), 60_000);
      state.troubleTimer.unref();
    }
    state.eventsFd = openSync(eventsPath(logDir, wid), "a");
    writeEvent({ type: "preamble", text: preambleLine(preamble), ...(preamble ? { hash: preamble.hash } : {}) });
    if (addendum) writeEvent({ type: "contract-addendum", text: `${addendum.path} sha ${addendum.sha}`, sha: addendum.sha });
    const rl = createInterface({ input: proc.stdout! });
    const toolUses = toolFold.uses;
    rl.on("line", (line) => {
      state.trouble?.activity();
      if (parsed.outputFormat === "stream-json") {
        process.stdout.write(line + "\n");
      }
      if (!line.startsWith("{")) return;
      let e: StreamEvent;
      try {
        e = JSON.parse(line) as StreamEvent;
      } catch {
        return;
      }
      writeEvent(e as Record<string, unknown>);
      if (e.type === "system" && e.subtype === "init") {
        if (e.session_id) status.claudeSession = e.session_id;
        adoptInitModel(status, e);
        const cw =
          initContextWindow(e) ?? target.provider.contextWindow ?? certainContextWindow(status.model);
        if (cw) status.contextWindow = cw;
        saveStatus(logDir, status);
      } else if (isCompactBoundary(e)) {
        resetContextTokensOnCompact(status, e);
        state.lastFill = usageContextUsed(e.usage) ?? null;
        saveStatus(logDir, status);
      } else if (e.type === "assistant") {
        status.turns += 1;
        timing.firstAt ??= Date.now();
        if (status.turns === 1) recordWarmup(logDir, status.provider, (Date.now() - t0) / 1000);
        bumpContextTokens(status, usageContextUsed(e.message?.usage));
        state.lastFill = usageContextUsed(e.message?.usage) ?? state.lastFill;
        status.contextUsed = usageContextUsed(e.message?.usage) ?? status.contextUsed;
        for (const block of e.message?.content ?? []) {
          if (block.type === "tool_use") {
            status.tools += 1;
            toolFold.onToolUse(block);
            status.last = describeTool(block.name ?? "?", block.input);
            // a long single sleep is worth seeing while it runs (supervision's
            // "sleeping" kind) — set when issued, cleared when it completes
            if (block.name === "Bash") status.sleepSec = parseSleepSecs(bashCommand(block.input));
          } else if (block.type === "text" && (block.text ?? "").trim()) {
            status.last = "says: " + shortText(block.text, 70);
          }
        }
        saveStatus(logDir, status);
      } else if (e.type === "user") {
        // tool results arrive as user events: each one advances (or resets)
        // the consecutive-failure counter supervision's thrashing detector
        // reads, and retires a pending sleep observation. Plain user turns
        // (operator input) have no tool_result blocks and change nothing.
        const blocks = e.message?.content;
        if (Array.isArray(blocks)) {
          let sawResult = false;
          for (const block of blocks) {
            if (block.type !== "tool_result") continue;
            sawResult = true;
            status.consecFails = toolResultFailed(block) ? (status.consecFails ?? 0) + 1 : 0;
            status.sleepSec = null;
            if (recordDenial(status, block, toolResultText(block.content), toolUses, parsed.prompt, new Date().toISOString())) {
              const d = parseDenialText(toolResultText(block.content), "?");
              if (d) state.trouble?.onDenial(d.hook, d.reason);
            }
            toolFold.onToolResult(block);
            const use = block.tool_use_id ? toolUses.get(block.tool_use_id) : undefined;
            if (use && !toolResultFailed(block) && isProgressTool(use.name, use.input)) status.progressAt = nowStamp();
          }
          if (sawResult) saveStatus(logDir, status);
        }
      } else if (e.type === "result") {
        // a result event's usage is the run's CUMULATIVE total (summed over
        // all turns), never a turn fill: it must not raise the context meter
        // (a 200k-window run once read "context 690%" from its 1.38M total).
        // A compact result legitimately restarts the context lower: the meter
        // drops to the last per-turn fill the assistant events recorded (the
        // post-compact context), never to the result's cumulative usage.
        if (e.is_compact) status.contextTokens = state.lastFill ?? status.contextTokens;
        const report = parseWorkerReport(e.result ?? "");
        if (report?.notes) status.last = shortText(report.notes, 90);
        else if (e.result) status.last = shortText(e.result, 90);
        saveStatus(logDir, status);
        state.operatorInFlight = 0;
        armStdinClose();
        state.resultEvent = e;
        state.resultReport = report;
        resultGrace.onResult();
      }
    });
  }

  let rc = await new Promise<number>((resolve, reject) => {
    const onError = (e: Error) => void failRun(e).then(() => reject(e), () => reject(e));
    if (earlyError) onError(earlyError);
    else proc.on("error", onError);
    proc.on("close", (code) => resolve(code ?? (state.killed ? 143 : 1)));
  });
  if (state.troubleTimer) clearInterval(state.troubleTimer);
  if (state.trouble) {
    const stop = peekLoopStop(logDir, wid);
    if (stop) state.trouble.onLoopStop(stop.reason);
    await state.trouble.flush();
  }
  resultGrace.cancel();
  await resultGrace.settled();
  // the result already received is the outcome; the signal that ended the leftovers is not
  if (resultGrace.fired && state.resultEvent) rc = state.resultEvent.is_error ? 1 : 0;
  if (state.eventsFd !== null) closeSync(state.eventsFd);
  cleanup();

  const secs = Math.floor((Date.now() - t0) / 1000);
  const resultEvent = state.resultEvent;
  const empty = headless && rc === 0 && resultEvent !== null && isEmptyResponse(resultEvent.result, status.tools);
  const ok = !empty && runSucceeded(headless, rc, resultEvent);
  if (resultEvent) status.last = shortText(resultEvent.result ?? "", 90);
  else if (headless) status.last = preEventFailure(rc, status.turns, state.stderrTail) ?? status.last;
  if (state.resultReport?.notes) status.last = shortText(state.resultReport.notes, 90);
  if (empty) {
    status.last = "harness: empty-response (model returned nothing)";
    recordToolError(logDir, {
      worker: wid,
      provider: target.providerName,
      label,
      tool: "model",
      text: "empty-response: model answered with zero usage and no tool call",
    });
  }
  if (headless && a.reportFormat === "ag2" && resultEvent?.result) {
    const rep = repairAndValidateAg2(resultEvent.result);
    const v = rep.validation;
    if (rep.normalised) status.reportNormalised = true;
    if (rep.repairs.length || rep.normalised || rep.details !== undefined) {
      resultEvent.result = rep.text;
      state.resultReport = parseWorkerReport(rep.text);
      if (rep.details !== undefined && state.resultReport) state.resultReport.details = rep.details;
      if (state.resultReport?.notes) status.last = shortText(state.resultReport.notes, 90);
    }
    status.reportValid = v.ok;
    status.reportErrors = v.errors;
    // one bounded re-ask, cap exactly one — see shouldRetryReport
    if (shouldRetryReport(v, a.noReportRetry ?? false, Boolean(status.claudeSession))) {
      status.reportRetried = true;
      saveStatus(logDir, status);
      appendLedger(ledger, "WORKER-REPORT-RETRY", { id: wid, reason: v.errors.join("; ") || "invalid AG2 message" });
      try {
        const reaskText = await reaskAg2Report({
          env,
          cwd: worktree?.dir ?? cwd,
          model,
          callerPinnedModel: Boolean(parsed.callerModel),
          chromeArgs,
          mcpArgs,
          toolArgs,
          toolsFlag,
          slimArgs,
          sessionId: status.claudeSession!,
          claudeCmd,
        });
        const v2 = validateAg2(reaskText);
        status.reportValid = v2.ok;
        status.reportErrors = v2.errors;
        if (v2.ok) {
          resultEvent.result = reaskText;
          state.resultReport = parseWorkerReport(reaskText);
          if (state.resultReport?.notes) status.last = shortText(state.resultReport.notes, 90);
        }
      } catch {
        // the re-ask is best effort; the original invalid report stands
      }
    }
  }
  (spawned as { release?: () => void }).release?.(); // the retry (if any) is over: the held pane may close
  if (headless && a.reportFormat === "ag2" && resultEvent?.result) {
    const { text, report, stray, rewritten, proof } = runProofCheck(resultEvent.result, state.bashRuns, worktree?.dir ?? cwd, untrackedAtStart, ledger, wid);
    if (rewritten || stray.length) {
      resultEvent.result = text;
      state.resultReport = report;
    }
    if (rewritten) {
      status.reportValid = false;
      status.last = proofNote(proof);
    }
    if (stray.length) process.stderr.write(`pai worker: warning: ${stray.length} untracked file(s) left by the worker: ${stray.join(", ")}\n`);
  }
  if (state.resultReport && status.denials?.length) state.resultReport.denials = status.denials;
  if (headless && state.resultReport?.changed?.length) {
    const verify = verifyReportChanges(state.resultReport.changed, worktree?.dir ?? cwd, t0);
    if (!verify.ok) {
      status.reportValid = false;
      const note = verifyFailNote(verify);
      status.last = shortText(note, 90);
      state.resultReport.notes = state.resultReport.notes ? `${state.resultReport.notes} — ${note}` : note;
      appendLedger(ledger, "REPORT-UNVERIFIED", {
        id: wid,
        failures: verify.failures.length,
        paths: verify.failures.map((f) => f.path).slice(0, 5).join(","),
      });
    }
  }
  if (resultGrace.fired && resultEvent) {
    status.last = leftoverNote(resultGrace.leftover);
    appendLedger(ledger, "WORKER-LEFTOVER-ENDED", { id: wid, processes: resultGrace.leftover });
  }
  let reviewed = false;
  return finaliseRun({
    logDir,
    ledger,
    status,
    ok,
    rc,
    secs,
    end: {
      provider: target.providerName,
      mode: headless ? "headless" : "interactive",
      model,
      turns: status.turns,
      tools: status.tools,
      label,
      ...(a.runT0 ? { setupMs: Math.max(0, timing.readyAt - a.runT0) } : {}),
      ...(a.setupPaneMs !== undefined ? { setupPaneMs: a.setupPaneMs } : {}),
      ...(a.admissionMs !== undefined ? { admissionMs: a.admissionMs } : {}),
      ...(a.spawnT0 ? { spawnMs: Math.max(0, timing.readyAt - a.spawnT0) } : {}),
      ...(timing.firstAt !== null ? { firstAnswerMs: timing.firstAt - timing.readyAt } : {}),
      ...(a.spareMiss ? { spare: "miss", spareMiss: a.spareMiss } : {}),
    },
    report: state.resultReport,
    fallbackText: resultEvent?.result,
    worktree,
    timedOut: status.timedOut ? limit?.minutes : undefined,
    cloudRun: (st) => headless && !isBenchmarkLabel(label) && !ranLocal(a, st),
    fallThroughWhy: (st, rep) => (headless ? fallThroughReason(a.route, st, rep, label, ranLocal(a, st)) : null),
    onReviewed: () => {
      reviewed = true;
    },
    beforeHandoff: async (st, rep) => {
      // Fall-through: a local run that failed its own report is repeated once on the cloud
      // (unless it committed: finaliseRun keeps that one for review — and a run
      // kept for review is not escalated either; escalation starts from the
      // salvaged branch instead).
      const failWhy = headless ? fallThroughReason(a.route, st, rep, label, ranLocal(a, st)) ?? (st.loopStopped ? "loop-guard stop" : null) : null;
      const escalated = headless
        ? await tryEscalate(a, wid, st, rep, resultEvent?.result, worktree ? commitLines(worktree.dir, worktree.base) : [], failWhy, reviewed)
        : null;
      if (escalated !== null) return escalated;
      const why = headless && !reviewed ? fallThroughReason(a.route, st, rep, label, ranLocal(a, st)) : null;
      if (why && a.route && !st.escalated) {
        return rerunOn(a, wid, why, st);
      }
      if (headless && !a.quiet) {
        printResult(parsed.outputFormat, resultEvent, rc, logDir, wid, rep, { ...worktreeExtras(st), ...identityExtras(wid, a.priorIds, st) });
      }

    // Empty response: one automatic re-launch of the same spec in the same cwd.
    if (empty && !a.emptyRetried) {
      appendLedger(ledger, "WORKER-EMPTY-RETRY", { id: wid, provider: target.providerName });
      return runWorker(
        relaunchOptions(a.opts, {
          providerFlag: target.providerName,
          onWorkerStart: a.onWorkerStart,
          _emptyRetried: true,
          _priorIds: [...(a.priorIds ?? []), wid],
        })
      );
    }

    // Quota reroute: only auto-routed runs, dead before the first tool call.
    const resultText = resultEvent?.result ?? "";
    if (
      !ok &&
      headless &&
      a.target.via === "auto" &&
      config.routing.retryOnQuota &&
      status.turns <= 1 &&
      status.tools === 0 &&
      isQuotaFailure(resultText)
    ) {
      setCooldown(logDir, target.providerName, config.routing.cooldownMinutes);
      const next = nextAutoProvider(config, logDir, target.providerName);
      if (next && a.reroutes < autoOrder(config).length) {
        appendLedger(ledger, "WORKER-REROUTE", {
          from: target.providerName,
          to: next,
          reason: "quota",
        });
        return runWorker(
          relaunchOptions(a.opts, {
            providerFlag: next,
            modelFlag: undefined,
            onWorkerStart: a.onWorkerStart,
            _reroutes: a.reroutes + 1,
          })
        );
      }
    }
    },
  });
}
