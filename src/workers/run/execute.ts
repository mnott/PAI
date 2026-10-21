/**
 * run/execute.ts — the spawn engines: executeRun (claude), executeImageRun, executeCodexRun, moved verbatim out of
 * run.ts (split plan). run.ts re-exports everything here so every
 * existing import path keeps working.
 */

import { grantedToolNames, recordToolError } from "../tool-errors.js";
import { editHintFor } from "../edit-assist.js";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { openSync, closeSync, writeSync } from "node:fs";
import { shortText } from "../args.js";
import { readWorkersSection } from "../config.js";
import { appendLedger } from "../ledger.js";
import { endFields, parentInfo } from "../endreason.js";
import { peekLoopStop } from "../loop-stop.js";
import { TroubleWatcher } from "../worker-trouble.js";
import { reportOriginWithHost, runMessenger } from "../run-report-wiring.js";
import { eventsPath, ledgerPath } from "../paths.js";
import {
  type WorkerStatus,
  newWorkerId,
  loadStatus,
  saveStatus,
  markStartFailed,
  describeTool,
  nowStamp,
  parseSleepSecs,
} from "../status.js";
import { certainContextWindow } from "../../utils/model-window.js";
import { resolveSession, resolveSpawnerSession } from "../scope.js";
import { fallThroughReason } from "../policy.js";
import { recordWarmup } from "../stagger.js";
import { autoOrder, isQuotaFailure, nextAutoProvider, setCooldown } from "../routing.js";
import { runImageCapability } from "../engines/image.js";
import { resolveHostSession } from "../pane.js";
import { paneTitle } from "../pane-title.js";
import { isHandoffMessage } from "../handoff.js";
import {
  addWorktree,
  markResumed,
  salvageOnExit,
  commitLines,
  recordWorktree,
  worktreeSystemPrompt,
  worktreeRefusesStart,
  worktreeWanted,
  type WorktreeInfo,
} from "../worktree.js";
import {
  promptTrailer,
  parseWorkerReport,
  verifyReportChanges,
  verifyFailNote,
  checkProof,
  newUntracked,
  untrackedPaths,
  type BashRun,
  type WorkerReport,
} from "../report.js";
import { parseDenialText, recordDenial } from "../denials.js";
import { repairAndValidateAg2, validateAg2 } from "../agentish.js";
import { preambleLine } from "../preamble.js";
import { armResultGrace, leftoverNote } from "../result-grace.js";
import { armDeadline, deadlinePromptLine } from "../deadline.js";
import { blockedMsOf } from "../active-time.js";
import { createOperatorServer } from "../operator.js";
import { buildsDir, releaseBuildsOf } from "../../builds/queue.js";
import {
  buildCodexArgs,
  buildCodexEnv,
  codexDroppedFlags,
  emptyCodexResult,
  foldCodexLine,
  parseCodexLine,
} from "../codex.js";
import { type StreamEvent, type ImageExecuteArgs, type ExecuteArgs, type CodexArgs } from "./types.js";
import {
  stdinUserMessage,
  operatorUserText,
  isoStamp,
  usageContextUsed,
  bumpContextTokens,
  resetContextTokensOnCompact,
  isCompactBoundary,
  bashCommand,
  toolResultText,
  toolResultFailed,
  adoptInitModel,
  shouldRetryReport,
  isEmptyResponse,
  runSucceeded,
  initContextWindow,
} from "./stream.js";
import { requireVisiblePane, spawnOwned, preEventFailure, announcePane } from "./pane-handles.js";
import {
  SIGNAL_SALVAGE_MS,
  fireDeadline,
  trackBlocked,
  recordSignalEnd,
  finaliseRun,
  relaunchOptions,
  worktreeExtras,
  reaskAg2Report,
  printResult,
} from "./finalise.js";
import { tryEscalate, rerunOnCloud } from "./escalate.js";
import { runWorker } from "./worker-ref.js";
import { runGates } from "./gate.js";
import { prepareRun } from "./execute-prepare.js";

export async function executeImageRun(a: ImageExecuteArgs & { config: ReturnType<typeof readWorkersSection>["workers"] }): Promise<number> {
  const { logDir, target, model, label, parsed } = a;
  if (!parsed.headless || parsed.prompt === null) {
    throw new Error(
      `provider "${target.providerName}" (engine image) supports headless runs only: ` +
        `pass the task with -p '<prompt>'`
    );
  }
  const wid = a.id ?? newWorkerId();
  const cwd = a.cwd ?? process.cwd();
  const term = process.env.ITERM_SESSION_ID ?? "";
  const outPath = a.outPath ?? join(logDir, `${wid}.png`);

  const status: WorkerStatus = {
    id: wid,
    pid: process.pid,
    runPid: process.pid,
    label,
    cwd,
    term,
    provider: target.providerName,
    model,
    state: "running",
    started: nowStamp(),
    updated: nowStamp(),
    turns: 0,
    tools: 0,
    last: "generating image",
    rc: null,
    secs: null,
    origin: "spawn",
    outputFormat: parsed.outputFormat,
    reportFormat: "json",
    ...(a.parent ? { parent: a.parent, stage: a.stage } : {}),
    ...(a.specPath ? { spec: a.specPath } : {}),
  };
  saveStatus(logDir, status);
  a.onWorkerStart?.(wid);
  const ledger = ledgerPath(logDir);
  appendLedger(ledger, "WORKER-START", {
    id: wid,
    provider: target.providerName,
    mode: "headless",
    engine: "image",
    model,
    cwd,
    label,
    capability: a.capability,
    ...(a.specPath ? { spec: a.specPath } : {}),
  });

  const imageEnd = {
    provider: target.providerName,
    mode: "headless",
    engine: "image",
    model,
    label,
    capability: a.capability,
  };
  const t0 = Date.now();
  try {
    const result = await runImageCapability({
      providerName: target.providerName,
      provider: target.provider,
      model,
      prompt: parsed.prompt,
      outPath,
      size: a.size,
      timeoutMs: a.timeoutMs,
    });
    const secs = Math.round((Date.now() - t0) / 1000);
    status.last = `wrote ${result.path}`;
    return await finaliseRun({
      logDir,
      ledger,
      status,
      ok: true,
      rc: 0,
      secs,
      end: imageEnd,
      report: null,
      beforeHandoff: () => {
        if (!a.quiet) process.stdout.write(JSON.stringify(result) + "\n");
      },
    });
  } catch (e) {
    const secs = Math.round((Date.now() - t0) / 1000);
    status.last = e instanceof Error ? e.message : String(e);
    await finaliseRun({ logDir, ledger, status, ok: false, rc: 1, secs, end: imageEnd, report: null });
    throw e;
  }
}

export async function executeRun(a: ExecuteArgs): Promise<number> {
  const { config, logDir, target, model, label, parsed, limit, noBrowser, noPane } = a;
  const prepared = await prepareRun(a);
  if (typeof prepared === "number") return prepared;
  const {
    headless, wid, adopted, cwd, term, paneVerified, session, sessionKey, spawnerSession, worktree, preamble,
    addendum, trailerApplied, env, claudeCmd, cmd, chromeArgs, mcpArgs, toolArgs, toolsFlag, slimArgs, promptText,
  } = prepared;

  // a gate that already ran (gateStart) rewrote `started` at the slot grant;
  // keep that stamp so the deadline and ps age count from the grant
  const gated = a.gated ? loadStatus(logDir, wid) : null;
  const started = gated && Number.isFinite(Date.parse(gated.started.replace(" ", "T")))
    ? new Date(Date.parse(gated.started.replace(" ", "T")))
    : new Date();
  let status: WorkerStatus = {
    id: wid,
    pid: process.pid,
    runPid: process.pid,
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
  else if (headless && !a.panePrepared) void announcePane(logDir, config, wid, term, noPane, ledger, status);

  let proc: ReturnType<typeof spawn>;
  try {
    if (headless && !a.gated) await runGates(a, wid, status);
    proc = await spawnOwned(wid, cmd, {
      env,
      cwd: worktree?.dir ?? cwd,
      stdio: headless ? ["pipe", "pipe", "pipe"] : "inherit",
      render: "stream",
      title: paneTitle(label, target.providerName),
      statusLine: { kind: "worker", id: wid, logDir },
    });
  } catch (e) {
    markStartFailed(logDir, status, e);
    throw e;
  }
  const t0 = Date.now();
  // claude's stderr: passed through, and the tail kept for a start that dies before any model event
  let stderrTail = "";
  proc.stderr?.on("data", (d: Buffer) => {
    process.stderr.write(d);
    stderrTail = (stderrTail + d.toString()).slice(-2000);
  });

  // --- stdin lifecycle (2i): prompt in, socket forwards, close 2 s after result
  let operatorInFlight = 0;
  let closeTimer: NodeJS.Timeout | null = null;
  const armStdinClose = () => {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      if (operatorInFlight === 0) {
        try {
          proc.stdin?.end();
        } catch {
          /* already closed */
        }
      }
    }, 2_000);
  };

  let eventsFd: number | null = null;
  const writeEvent = (obj: Record<string, unknown>): void => {
    if (eventsFd === null) return;
    try {
      writeSync(eventsFd, JSON.stringify({ ...obj, _ts: isoStamp() }) + "\n");
    } catch {
      // a full disk must not take the worker transcript's process down
    }
  };

  const operatorServer = headless
    ? createOperatorServer(logDir, wid, async (text) => {
        const stdin = proc.stdin;
        if (!stdin || !stdin.writable || stdin.writableEnded) {
          return "the worker's stdin is already closed (its turn ended) — use: pai worker resume";
        }
        operatorInFlight += 1;
        resultGrace.cancel();
        if (closeTimer) {
          clearTimeout(closeTimer);
          closeTimer = null;
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

  let killed = false;
  const resultGrace = armResultGrace(headless ? proc.pid : undefined);
  const stopDeadline = limit ? armDeadline(proc, limit, () => fireDeadline(logDir, status, ledger, limit), undefined, () => blockedMsOf(logDir, wid)) : null;
  const stopTrack = trackBlocked(logDir, status, limit);
  const cleanup = () => {
    stopDeadline?.();
    stopTrack();
    if (closeTimer) clearTimeout(closeTimer);
    operatorServer?.close();
  };
  const onSignal = (sig: string) => {
    killed = true;
    status.state = "killed";
    status.rc = 143;
    status.secs = Math.floor((Date.now() - t0) / 1000);
    const end = recordSignalEnd(logDir, status, sig);
    status.last = `killed by signal ${sig} (${end.reason}${end.by ? ` by ${end.by}` : ""})`;
    saveStatus(logDir, status);
    appendLedger(ledger, "WORKER-END", {
      id: wid,
      provider: target.providerName,
      mode: "headless",
      model,
      rc: 143,
      secs: status.secs,
      killed: 1,
      ...endFields(end),
      note: end.note,
      label,
    });
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
      proc.kill();
    } catch {
      /* already gone */
    }
    // the build lock and tree of a killed worker go with it
    void releaseBuildsOf(buildsDir(), wid).catch(() => []).finally(() => process.exit(143));
    setTimeout(() => process.exit(143), 2000).unref();
  };
  process.once("SIGTERM", () => onSignal("SIGTERM"));
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGHUP", () => onSignal("SIGHUP"));

  // Holder for the last result event + its parsed report: assigned inside the
  // readline callback below, read after the await.
  const ctx: {
    resultEvent: StreamEvent | null;
    resultReport: WorkerReport | null;
  } = {
    resultEvent: null,
    resultReport: null,
  };
  // The latest per-turn fill (input side of the newest assistant usage, reset
  // at a compact boundary): the context meter's high-water mark is kept on the
  // status, but a compact result must drop it to THIS value — a result event's
  // usage is the run's cumulative total, never the post-compact context.
  // Holder object: a plain `let` would be flow-narrowed to null at the use
  // site below, since only the readline callback ever assigns it.
  const turnFill: { last: number | null } = { last: null };
  // every Bash call + outcome, and the untracked files present at spawn: the
  // end-of-run proof check (checkProof) and stray-file listing read these
  const bashRuns: BashRun[] = [];
  let trouble: TroubleWatcher | undefined;
  let troubleTimer: ReturnType<typeof setInterval> | undefined;
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
      trouble = new TroubleWatcher(wid, label, runMessenger(logDir), origin);
      troubleTimer = setInterval(() => trouble?.tick(), 60_000);
      troubleTimer.unref();
    }
    eventsFd = openSync(eventsPath(logDir, wid), "a");
    writeEvent({ type: "preamble", text: preambleLine(preamble), ...(preamble ? { hash: preamble.hash } : {}) });
    if (addendum) writeEvent({ type: "contract-addendum", text: `${addendum.path} sha ${addendum.sha}`, sha: addendum.sha });
    const rl = createInterface({ input: proc.stdout! });
    const toolUses = new Map<string, { name: string; input: unknown }>();
    rl.on("line", (line) => {
      trouble?.activity();
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
        turnFill.last = usageContextUsed(e.usage) ?? null;
        saveStatus(logDir, status);
      } else if (e.type === "assistant") {
        status.turns += 1;
        timing.firstAt ??= Date.now();
        if (status.turns === 1) recordWarmup(logDir, status.provider, (Date.now() - t0) / 1000);
        bumpContextTokens(status, usageContextUsed(e.message?.usage));
        turnFill.last = usageContextUsed(e.message?.usage) ?? turnFill.last;
        status.contextUsed = usageContextUsed(e.message?.usage) ?? status.contextUsed;
        for (const block of e.message?.content ?? []) {
          if (block.type === "tool_use") {
            status.tools += 1;
            if (block.id) toolUses.set(block.id, { name: block.name ?? "?", input: block.input });
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
              if (d) trouble?.onDenial(d.hook, d.reason);
            }
            if (block.is_error === true) {
              recordToolError(logDir, {
                worker: wid,
                provider: target.providerName,
                label,
                tool: toolUses.get(block.tool_use_id ?? "")?.name ?? "?",
                text: toolResultText(block.content),
                input: toolUses.get(block.tool_use_id ?? "")?.input,
                granted: headless ? grantedToolNames(toolsFlag.slice(1), parsed.allowedTools) : undefined,
              });
            }
            const use = block.tool_use_id ? toolUses.get(block.tool_use_id) : undefined;
            if (use?.name === "Edit" && block.is_error === true) {
              const hint = editHintFor(use.input, toolResultText(block.content), worktree?.dir ?? cwd);
              if (hint) injectHarnessHint(hint);
            }
            if (use?.name === "Bash") bashRuns.push({ command: bashCommand(use.input), failed: toolResultFailed(block), output: toolResultText(block.content).slice(-400) });
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
        if (e.is_compact) status.contextTokens = turnFill.last ?? status.contextTokens;
        const report = parseWorkerReport(e.result ?? "");
        if (report?.notes) status.last = shortText(report.notes, 90);
        else if (e.result) status.last = shortText(e.result, 90);
        saveStatus(logDir, status);
        operatorInFlight = 0;
        armStdinClose();
        ctx.resultEvent = e;
        ctx.resultReport = report;
        resultGrace.onResult();
      }
    });
  }

  let rc = await new Promise<number>((resolve, reject) => {
    proc.on("error", (e) => {
      markStartFailed(logDir, status, e);
      reject(e);
    });
    proc.on("close", (code) => resolve(code ?? (killed ? 143 : 1)));
  });
  if (troubleTimer) clearInterval(troubleTimer);
  if (trouble) {
    const stop = peekLoopStop(logDir, wid);
    if (stop) trouble.onLoopStop(stop.reason);
    await trouble.flush();
  }
  resultGrace.cancel();
  await resultGrace.settled();
  // the result already received is the outcome; the signal that ended the leftovers is not
  if (resultGrace.fired && ctx.resultEvent) rc = ctx.resultEvent.is_error ? 1 : 0;
  if (eventsFd !== null) closeSync(eventsFd);
  cleanup();

  const secs = Math.floor((Date.now() - t0) / 1000);
  const resultEvent = ctx.resultEvent;
  const empty = headless && rc === 0 && resultEvent !== null && isEmptyResponse(resultEvent.result, status.tools);
  const ok = !empty && runSucceeded(headless, rc, resultEvent);
  if (resultEvent) status.last = shortText(resultEvent.result ?? "", 90);
  else if (headless) status.last = preEventFailure(rc, status.turns, stderrTail) ?? status.last;
  if (ctx.resultReport?.notes) status.last = shortText(ctx.resultReport.notes, 90);
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
    if (rep.repairs.length) {
      resultEvent.result = rep.text;
      ctx.resultReport = parseWorkerReport(rep.text);
      if (ctx.resultReport?.notes) status.last = shortText(ctx.resultReport.notes, 90);
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
          ctx.resultReport = parseWorkerReport(reaskText);
          if (ctx.resultReport?.notes) status.last = shortText(ctx.resultReport.notes, 90);
        }
      } catch {
        // the re-ask is best effort; the original invalid report stands
      }
    }
  }
  if (headless && a.reportFormat === "ag2" && resultEvent?.result) {
    const stray = newUntracked(worktree?.dir ?? cwd, untrackedAtStart);
    const chk = checkProof(resultEvent.result, bashRuns, stray);
    if (chk.rewritten || stray.length) {
      resultEvent.result = chk.text;
      ctx.resultReport = parseWorkerReport(chk.text);
      if (ctx.resultReport) ctx.resultReport.untracked = stray.length ? stray : undefined;
    }
    if (chk.rewritten) {
      status.reportValid = false;
      status.last = shortText(`claimed proof not run or failed: ${chk.proof}`, 90);
      appendLedger(ledger, "REPORT-PROOF-UNVERIFIED", { id: wid, proof: chk.proof });
    }
    if (stray.length) process.stderr.write(`pai worker: warning: ${stray.length} untracked file(s) left by the worker: ${stray.join(", ")}\n`);
  }
  if (ctx.resultReport && status.denials?.length) ctx.resultReport.denials = status.denials;
  if (headless && ctx.resultReport?.changed?.length) {
    const verify = verifyReportChanges(ctx.resultReport.changed, worktree?.dir ?? cwd, t0);
    if (!verify.ok) {
      status.reportValid = false;
      const note = verifyFailNote(verify);
      status.last = shortText(note, 90);
      ctx.resultReport.notes = ctx.resultReport.notes ? `${ctx.resultReport.notes} — ${note}` : note;
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
    report: ctx.resultReport,
    fallbackText: resultEvent?.result,
    worktree,
    timedOut: status.timedOut ? limit?.minutes : undefined,
    fallThroughWhy: (st, rep) => (headless ? fallThroughReason(a.route, st, rep) : null),
    onReviewed: () => {
      reviewed = true;
    },
    beforeHandoff: async (st, rep) => {
      // Fall-through: a local run that failed its own report is repeated once on the cloud
      // (unless it committed: finaliseRun keeps that one for review — and a run
      // kept for review is not escalated either; escalation starts from the
      // salvaged branch instead).
      const failWhy = headless ? fallThroughReason(a.route, st, rep) ?? (st.loopStopped ? "loop-guard stop" : null) : null;
      const escalated = headless
        ? await tryEscalate(a, wid, st, rep, resultEvent?.result, worktree ? commitLines(worktree.dir, worktree.base) : [], failWhy, reviewed)
        : null;
      if (escalated !== null) return escalated;
      const why = headless && !reviewed ? fallThroughReason(a.route, st, rep) : null;
      if (why && a.route && !st.escalated) {
        return rerunOnCloud(a, wid, why, st);
      }
      if (headless && !a.quiet) {
        printResult(parsed.outputFormat, resultEvent, rc, logDir, wid, rep, worktreeExtras(st));
      }

    // Empty response: one automatic re-launch of the same spec in the same cwd.
    if (empty && !a.emptyRetried) {
      appendLedger(ledger, "WORKER-EMPTY-RETRY", { id: wid, provider: target.providerName });
      return runWorker(
        relaunchOptions(a.opts, {
          providerFlag: target.providerName,
          onWorkerStart: a.onWorkerStart,
          _emptyRetried: true,
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

export async function executeCodexRun(a: CodexArgs): Promise<number> {
  const { config, logDir, target, model, label, parsed, noPane } = a;
  if (!parsed.headless || parsed.prompt === null) {
    throw new Error(
      `provider "${target.providerName}" (engine codex) supports headless runs only: ` +
        `pass the task with -p '<prompt>'`
    );
  }
  const env = buildCodexEnv(target.provider);
  const wid = a.id ?? newWorkerId();
  const cwd = a.cwd ?? process.cwd();
  const term = (await resolveHostSession()).term;
  const paneVerified = await requireVisiblePane(logDir, config, wid, term, noPane, false, ledgerPath(logDir));
  const session = resolveSession(term);
  const spawnerSession = resolveSpawnerSession(logDir, cwd);

  let worktree: WorktreeInfo | null = null;
  if (worktreeWanted(a.worktreeFlag, { cwd, allowedTools: parsed.allowedTools })) {
    try {
      worktree = addWorktree(logDir, wid, cwd);
      if (worktree.snapshotSkipped) process.stderr.write(`pai worker: ${worktree.snapshotSkipped}\n`);
    } catch (e) {
      const why = (e as Error).message;
      if (worktreeRefusesStart(logDir, wid, why, parsed.allowedTools)) {
        process.stderr.write(`pai worker: not started, no worktree (${why})\n`);
        return 1;
      }
      process.stderr.write(`pai worker: no worktree (${why}) — read-only, running in place\n`);
      appendLedger(ledgerPath(logDir), "WORKER-NOTE", { id: wid, note: `no worktree: ${why}` });
    }
  }
  env.PAI_WORKER_ID = wid;
  // codex takes instructions through the prompt, not a system prompt flag
  const prompt =
    (a.limit ? deadlinePromptLine(a.limit) + "\n\n" : "") +
    (worktree ? worktreeSystemPrompt(wid, worktree.branch, worktree.dir, worktree.snapshot) + "\n\n" : "") +
    parsed.prompt;

  let status: WorkerStatus = {
    id: wid,
    pid: process.pid,
    runPid: process.pid,
    ...parentInfo(),
    label,
    cwd,
    term,
    provider: target.providerName,
    model,
    state: "running",
    started: nowStamp(),
    updated: nowStamp(),
    turns: 0,
    tools: 0,
    last: "starting",
    rc: null,
    secs: null,
    origin: "spawn",
    outputFormat: parsed.outputFormat,
    // codex takes instructions through the prompt, not the AG2 contract flag
    reportFormat: "json",
    ...(session ? { session } : {}),
    ...(spawnerSession ? { spawnerSession } : {}),
    // codex has no init event of its own: the synthetic one below announces
    // an explicitly configured window (never a guessed default)
    ...(target.provider.contextWindow ? { contextWindow: target.provider.contextWindow } : {}),
    ...(a.parent ? { parent: a.parent, stage: a.stage } : {}),
    ...(worktree
      ? {
          worktreeDir: worktree.dir,
          branch: worktree.branch,
          worktreeBase: worktree.base,
          worktreeSnapshot: worktree.snapshot,
        }
      : {}),
    ...(a.specPath ? { spec: a.specPath } : {}),
    ...(a.limit ? { deadlineAt: a.limit.deadlineAt, maxMinutes: a.limit.minutes } : {}),
    ...(a.queueWaitedMs ? { queueWaitedMs: a.queueWaitedMs } : {}),
  };
  saveStatus(logDir, status);
  a.onWorkerStart?.(wid);
  const ledger = ledgerPath(logDir);
  appendLedger(ledger, "WORKER-START", {
    id: wid,
    provider: target.providerName,
    mode: "headless",
    engine: "codex",
    model,
    cwd,
    label,
    ...(a.capability ? { capability: a.capability } : {}),
  });
  const dropped = codexDroppedFlags(a.claudeArgs);
  if (dropped.length) {
    appendLedger(ledger, "WORKER-NOTE", {
      id: wid,
      note: `dropped for codex: ${dropped.join(", ")}`,
    });
  }

  if (paneVerified) status.pane = { opened: true, exec: true };
  else void announcePane(logDir, config, wid, term, noPane, ledger, status);

  const t0 = Date.now();
  const proc = await spawnOwned(wid, ["codex", ...buildCodexArgs(prompt, parsed.callerModel ? undefined : model)], {
    env,
    cwd: worktree?.dir ?? cwd,
    stdio: ["ignore", "pipe", "inherit"],
    title: paneTitle(label, target.providerName),
  });

  const fold = emptyCodexResult();
  const eventsFd = openSync(eventsPath(logDir, wid), "a");
  const writeEvent = (obj: Record<string, unknown>) => {
    try {
      writeSync(eventsFd, JSON.stringify({ ...obj, _ts: isoStamp() }) + "\n");
    } catch {
      // best effort transcript
    }
  };
  writeEvent({
    type: "system",
    subtype: "init",
    model,
    cwd,
    ...(target.provider.contextWindow ? { context_window: target.provider.contextWindow } : {}),
  });

  let killed = false;
  const stopDeadline = a.limit ? armDeadline(proc, a.limit, () => fireDeadline(logDir, status, ledger, a.limit!), undefined, () => blockedMsOf(logDir, wid)) : null;
  const stopTrack = trackBlocked(logDir, status, a.limit);
  process.once("SIGTERM", onCodexSignal("SIGTERM"));
  process.once("SIGINT", onCodexSignal("SIGINT"));
  process.once("SIGHUP", onCodexSignal("SIGHUP"));
  function onCodexSignal(sig: string) {
    return () => {
      killed = true;
      status.state = "killed";
      status.rc = 143;
      status.secs = Math.floor((Date.now() - t0) / 1000);
      const end = recordSignalEnd(logDir, status, sig);
      status.last = `killed by signal ${sig} (${end.reason}${end.by ? ` by ${end.by}` : ""})`;
      saveStatus(logDir, status);
      appendLedger(ledger, "WORKER-END", {
        id: wid,
        provider: target.providerName,
        mode: "headless",
        model,
        rc: 143,
        secs: status.secs,
        killed: 1,
        ...endFields(end),
        note: end.note,
        label,
      });
      // same as the claude path: a killed run's worktree and branch go now
      if (worktree) {
        salvageOnExit(ledger, wid, label, worktree.dir, SIGNAL_SALVAGE_MS);
        try {
          recordWorktree(logDir, status, worktree, false);
        } catch {
          /* best effort: the status already says killed */
        }
      }
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
      process.exit(143);
    };
  }

  const rl = createInterface({ input: proc.stdout! });
  rl.on("line", (line) => {
    if (parsed.outputFormat === "stream-json") process.stdout.write(line + "\n");
    const parsedLine = parseCodexLine(line);
    if (parsedLine === null) return;
    foldCodexLine(parsedLine, fold);
    if (fold.threadId && !status.claudeSession) status.claudeSession = fold.threadId;
    status.turns = fold.turns;
    status.tools = fold.tools;
    if (fold.last) status.last = shortText(fold.last, 90);
    bumpContextTokens(status, fold.contextTokens);
    saveStatus(logDir, status);
    for (const ev of fold.events.splice(0)) writeEvent(ev);
  });

  const rc = await new Promise<number>((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (code) => resolve(code ?? (killed ? 143 : 1)));
  });
  stopDeadline?.();
  stopTrack();
  closeSync(eventsFd);

  const secs = Math.floor((Date.now() - t0) / 1000);
  const finalText = fold.finalText ?? "";
  const report = parseWorkerReport(finalText);
  const resultEvent: StreamEvent = {
    type: "result",
    result: finalText,
    is_error: fold.isError || rc !== 0,
    num_turns: fold.turns,
    duration_ms: secs * 1000,
  };
  writeEvent(resultEvent);

  const ok = rc === 0 && !fold.isError;
  status.last = shortText(report?.notes ?? finalText, 90) || (ok ? "done" : "failed");
  if (report?.changed?.length) {
    const verify = verifyReportChanges(report.changed, worktree?.dir ?? cwd, t0);
    if (!verify.ok) {
      status.reportValid = false;
      const note = verifyFailNote(verify);
      status.last = shortText(note, 90);
      report.notes = report.notes ? `${report.notes} — ${note}` : note;
      appendLedger(ledger, "REPORT-UNVERIFIED", {
        id: wid,
        failures: verify.failures.length,
        paths: verify.failures.map((f) => f.path).slice(0, 5).join(","),
      });
    }
  }
  return finaliseRun({
    logDir,
    ledger,
    status,
    ok,
    rc,
    secs,
    end: {
      provider: target.providerName,
      mode: "headless",
      engine: "codex",
      model,
      turns: status.turns,
      tools: status.tools,
      label,
    },
    report,
    fallbackText: finalText,
    worktree,
    timedOut: status.timedOut ? a.limit?.minutes : undefined,
    beforeHandoff: (st, rep) => {
      if (!a.quiet) printResult(parsed.outputFormat, resultEvent, rc, logDir, wid, rep, worktreeExtras(st));
    },
  });
}
