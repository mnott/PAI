/**
 * run/execute-uhp.ts — executeUhpRun: the "uhp" engine's run (see ../uhp.ts).
 * No process is spawned: the run process holds the SSE stream, so `kill`
 * (SIGTERM) reaches it and it cancels the response upstream before exiting.
 * Mirrors executeCodexRun's status, ledger and transcript contract; no
 * worktree (the harness is remote) — returned files are listed in the notes.
 */

import { openSync, closeSync, writeSync } from "node:fs";
import { shortText } from "../args.js";
import { appendLedger } from "../ledger.js";
import { parentInfo } from "../endreason.js";
import { eventsPath, ledgerPath } from "../paths.js";
import { type WorkerStatus, newWorkerId, saveStatus, loadStatus, nowStamp, selfProcStart } from "../status.js";
import { resolveSession, resolveSpawnerSession } from "../scope.js";
import { resolveHostSession } from "../pane.js";
import { parseWorkerReport, type WorkerReport } from "../report.js";
import { armDeadline, deadlinePromptLine } from "../deadline.js";
import { blockedMsOf } from "../active-time.js";
import { cancelUhp, discoverUhpVersion, emptyUhpResult, runUhp, uhpVersionWarning, UhpProtocolError, type UhpResult } from "../uhp.js";
import { modelRecord, uhpErrorReason, uhpStatusToState, type Ag2Result } from "../uhp-vocab.js";
import { type StreamEvent, type CodexArgs } from "./types.js";
import { isoStamp } from "./stream.js";
import { requireVisiblePane, announcePane } from "./pane-handles.js";
import { fireDeadline, trackBlocked, recordKilledEnd, finaliseRun, identityExtras, printResult } from "./finalise.js";

export type UhpArgs = CodexArgs & { harnessId?: string };

/** The report for a uhp run: the worker's own AG2/JSON report when parseable, else one built from the terminal status. */
export function uhpReport(r: UhpResult, finalText: string, warnings: string[] = []): WorkerReport | null {
  const parsed = parseWorkerReport(finalText);
  const result: Ag2Result = r.result ?? "?";
  const files = r.downloadUrls.length ? `files: ${r.downloadUrls.join(" ")}` : "";
  const warn = [...warnings, ...r.warnings].map((w) => `uhp warning: ${w}`).join("\n");
  if (!parsed && result === "+" && !files && !warn) return null;
  const base: WorkerReport = parsed ?? { notes: finalText.slice(0, 500) };
  const why = result === "+" ? undefined : [r.errorCode, r.errorMessage].filter(Boolean).join(": ") || r.status || undefined;
  return {
    ...base,
    result: base.result ?? result,
    ...(why && !base.why ? { why } : {}),
    notes: [base.notes, files, warn].filter(Boolean).join("\n"),
  };
}

export async function executeUhpRun(a: UhpArgs): Promise<number> {
  const { config, logDir, target, model, label, parsed, systemWaiver } = a;
  if (!parsed.headless || parsed.prompt === null) {
    throw new Error(
      `provider "${target.providerName}" (engine uhp) supports headless runs only: pass the task with -p '<prompt>'`
    );
  }
  const provider = target.provider;
  const harnessId = a.harnessId ?? provider.harnessId;
  const wid = a.id ?? newWorkerId();
  const cwd = a.cwd ?? process.cwd();
  const term = (await resolveHostSession()).term;
  const paneVerified = await requireVisiblePane(logDir, config, wid, term, systemWaiver, false, ledgerPath(logDir));
  const session = resolveSession(term);
  const spawnerSession = resolveSpawnerSession(logDir, cwd, process.env);
  const old = a.resumeOf ? loadStatus(logDir, a.resumeOf) : null;
  const previousResponseId = old?.uhpResponseId ?? undefined;
  const prompt = (a.limit ? deadlinePromptLine(a.limit) + "\n\n" : "") + parsed.prompt;

  const status: WorkerStatus = {
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
    started: nowStamp(),
    updated: nowStamp(),
    turns: 0,
    tools: 0,
    last: "starting",
    rc: null,
    secs: null,
    origin: "spawn",
    outputFormat: parsed.outputFormat,
    reportFormat: "json",
    ...(harnessId ? { uhpHarnessId: harnessId } : {}),
    ...(old?.uhpSessionId ? { uhpSessionId: old.uhpSessionId } : {}),
    ...(session ? { session } : {}),
    ...(spawnerSession ? { spawnerSession } : {}),
    ...(provider.contextWindow ? { contextWindow: provider.contextWindow } : {}),
    ...(a.parent ? { parent: a.parent, stage: a.stage } : {}),
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
    engine: "uhp",
    model,
    cwd,
    label,
    ...(harnessId ? { harness: harnessId } : {}),
    ...(provider.uhpProtocol ? { uhp_protocol: provider.uhpProtocol } : {}),
    ...(a.capability ? { capability: a.capability } : {}),
  });
  if (paneVerified) status.pane = { opened: true, exec: true };
  else await announcePane(logDir, config, wid, term, systemWaiver, ledger, status);

  // the pin is a record, not a negotiation: a different advertised version only warns
  const warnings: string[] = [];
  if (provider.uhpProtocol) {
    const w = uhpVersionWarning(provider.uhpProtocol, await discoverUhpVersion(provider));
    if (w) {
      warnings.push(w);
      appendLedger(ledger, "WORKER-NOTE", { id: wid, note: `uhp version: ${w}` });
    }
  }

  const t0 = Date.now();
  const ctl = new AbortController();
  const fold = emptyUhpResult();
  let eventsFd: number | null = openSync(eventsPath(logDir, wid), "a");
  const writeEvent = (obj: Record<string, unknown>) => {
    if (eventsFd === null) return;
    try {
      writeSync(eventsFd, JSON.stringify({ ...obj, _ts: isoStamp() }) + "\n");
    } catch {
      // best effort transcript
    }
  };
  const closeEvents = () => {
    if (eventsFd === null) return;
    try {
      closeSync(eventsFd);
    } catch {
      /* already closed */
    }
    eventsFd = null;
  };
  writeEvent({
    type: "system",
    subtype: "init",
    model,
    cwd,
    ...(provider.contextWindow ? { context_window: provider.contextWindow } : {}),
  });

  const stopDeadline = a.limit
    ? armDeadline(
        { kill: () => ctl.abort() } as never,
        a.limit,
        () => fireDeadline(logDir, status, ledger, a.limit!),
        undefined,
        () => blockedMsOf(logDir, wid),
      )
    : null;
  const stopTrack = trackBlocked(logDir, status, a.limit);

  let killed = false;
  const onSignal = (sig: string) => {
    killed = true;
    recordKilledEnd({ logDir, status, sig, t0, ledger, wid, providerName: target.providerName, model, label });
    stopDeadline?.();
    stopTrack?.();
    closeEvents();
    ctl.abort();
    const done = () => process.exit(143);
    if (fold.responseId) void cancelUhp(provider, fold.responseId, wid).finally(done);
    else done();
    setTimeout(done, 6000).unref();
  };
  const sigs = (["SIGTERM", "SIGINT", "SIGHUP"] as const).map((sig) => [sig, () => onSignal(sig)] as const);
  for (const [sig, h] of sigs) process.once(sig, h);

  let failure: string | null = null;
  let failureCode = uhpErrorReason(undefined);
  try {
    await runUhp({
      provider,
      workerId: wid,
      prompt,
      harnessId,
      model,
      previousResponseId,
      signal: ctl.signal,
      timeoutSeconds: a.limit ? a.limit.minutes * 60 : undefined,
      onEvent: (r, e) => {
        Object.assign(fold, r);
        if (r.responseId) status.uhpResponseId = r.responseId;
        if (r.sessionId) status.uhpSessionId = r.sessionId;
        if (!status.claudeSession && (r.sessionId ?? r.responseId)) status.claudeSession = r.sessionId ?? r.responseId;
        status.turns = r.turns;
        status.tools = r.tools;
        if (r.last) status.last = shortText(r.last, 90);
        saveStatus(logDir, status);
        for (const ev of r.events.splice(0)) {
          writeEvent(ev);
          if (parsed.outputFormat === "stream-json") process.stdout.write(JSON.stringify(ev) + "\n");
        }
        void e;
      },
    }).then((r) => {
      Object.assign(fold, r);
    });
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
    if (e instanceof UhpProtocolError) failureCode = "provider_error";
    else if (status.timedOut) failureCode = "timeout";
    else failureCode = "harness_unavailable";
  } finally {
    for (const [sig, h] of sigs) process.off(sig, h);
    stopDeadline?.();
    stopTrack?.();
  }

  const secs = Math.floor((Date.now() - t0) / 1000);
  const finalText = fold.finalText ?? "";
  if (killed) {
    // a kill ends the run as cancelled whatever the aborted stream looked like
    fold.status = "cancelled";
    fold.result = "!";
    fold.errorCode = "cancelled";
  } else if (failure) {
    fold.status = fold.status ?? "failed";
    fold.result = fold.result ?? "-";
    fold.errorCode = fold.errorCode ?? failureCode;
    fold.errorMessage = fold.errorMessage ?? failure;
  }
  const state = uhpStatusToState(fold.status ?? "failed");
  const ok = state === "done";
  const rc = ok ? 0 : state === "killed" ? 143 : 1;
  const report = uhpReport(fold, finalText, warnings);
  Object.assign(status, modelRecord(model, fold.model ?? undefined, "harness used another model"));
  if (fold.errorCode) status.last = shortText(`${fold.errorCode}: ${fold.errorMessage ?? ""}`, 90);
  else status.last = shortText(report?.notes ?? finalText, 90) || (ok ? "done" : "failed");
  const resultEvent: StreamEvent = {
    type: "result",
    result: finalText,
    is_error: !ok,
    num_turns: fold.turns,
    duration_ms: secs * 1000,
  };
  writeEvent(resultEvent);
  closeEvents();
  if (fold.errorCode) appendLedger(ledger, "WORKER-NOTE", { id: wid, note: `uhp ${fold.status ?? "failed"}: ${fold.errorCode}` });

  const code = await finaliseRun({
    logDir,
    ledger,
    status,
    ok,
    rc,
    secs,
    end: {
      provider: target.providerName,
      mode: "headless",
      engine: "uhp",
      model,
      turns: status.turns,
      tools: status.tools,
      label,
      ...(fold.errorCode ? { reason: fold.errorCode } : {}),
    },
    report,
    fallbackText: finalText,
    timedOut: status.timedOut ? a.limit?.minutes : undefined,
    beforeHandoff: (st, rep) => {
      if (!a.quiet) printResult(parsed.outputFormat, resultEvent, rc, logDir, wid, rep, { ...identityExtras(wid, a.priorIds, st) });
    },
  });
  if (fold.status === "cancelled") {
    const st = loadStatus(logDir, wid);
    if (st && st.state !== "killed") {
      st.state = "killed";
      saveStatus(logDir, st);
    }
  }
  return code;
}
