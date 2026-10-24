/**
 * run/execute.ts — the spawn engines: executeRun (claude), executeImageRun, executeCodexRun, moved verbatim out of
 * run.ts (split plan). run.ts re-exports everything here so every
 * existing import path keeps working.
 */

import { applyScratchEnv, scratchPromptLine } from "../scratch.js";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { openSync, closeSync, writeSync } from "node:fs";
import { shortText } from "../args.js";
import { readWorkersSection } from "../config.js";
import { appendLedger } from "../ledger.js";
import { parentInfo } from "../endreason.js";
import { eventsPath, ledgerPath } from "../paths.js";
import { type WorkerStatus, newWorkerId, saveStatus, nowStamp, markStartFailed, selfProcStart } from "../status.js";
import { resolveSession, resolveSpawnerSession } from "../scope.js";
import { runImageCapability } from "../engines/image.js";
import { resolveHostSession } from "../pane.js";
import { paneTitle } from "../pane-title.js";
import {
  salvageOnExit,
  recordWorktree,
  worktreeSystemPrompt,
  worktreeWanted,
  type WorktreeInfo,
} from "../worktree.js";
import { parseWorkerReport, verifyReportChanges, verifyFailNote } from "../report.js";
import { armDeadline, deadlinePromptLine } from "../deadline.js";
import { blockedMsOf } from "../active-time.js";
import {
  buildCodexArgs,
  buildCodexEnv,
  codexDroppedFlags,
  emptyCodexResult,
  foldCodexLine,
  parseCodexLine,
} from "../codex.js";
import { type StreamEvent, type ImageExecuteArgs, type ExecuteArgs, type CodexArgs } from "./types.js";
import { isoStamp, bumpContextTokens } from "./stream.js";
import { requireVisiblePane, spawnOwned, announcePane } from "./pane-handles.js";
import {
  SIGNAL_SALVAGE_MS,
  fireDeadline,
  trackBlocked,
  recordKilledEnd,
  finaliseRun,
  worktreeExtras,
  identityExtras,
  printResult,
} from "./finalise.js";
import { spawn } from "node:child_process";
import { reapRunTree } from "./lifecycle.js";
import { prepareRun, createRunWorktree } from "./execute-prepare.js";
import { foldRun } from "./execute-fold.js";

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
  const term = (await resolveHostSession()).term;
  const outPath = a.outPath ?? join(logDir, `${wid}.png`);

  const status: WorkerStatus = {
    id: wid,
    pid: process.pid,
    runPid: process.pid,
    procStart: selfProcStart(),
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
  const prepared = await prepareRun(a);
  if (typeof prepared === "number") return prepared;
  return foldRun(a, prepared);
}

export async function executeCodexRun(a: CodexArgs): Promise<number> {
  const { config, logDir, target, model, label, parsed, systemWaiver } = a;
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
  const paneVerified = await requireVisiblePane(logDir, config, wid, term, systemWaiver, false, ledgerPath(logDir));
  const session = resolveSession(term);
  const spawnerSession = resolveSpawnerSession(logDir, cwd, process.env);

  let worktree: WorktreeInfo | null = null;
  if (worktreeWanted(a.worktreeFlag, { cwd, allowedTools: parsed.allowedTools })) {
    const made = createRunWorktree(logDir, wid, cwd, parsed.allowedTools);
    if (made === "refused") return 1;
    worktree = made;
  }
  env.PAI_WORKER_ID = wid;
  const scratch = applyScratchEnv(env, wid);
  // codex takes instructions through the prompt, not a system prompt flag
  const prompt =
    scratchPromptLine(scratch) + "\n\n" +
    (a.limit ? deadlinePromptLine(a.limit) + "\n\n" : "") +
    (worktree ? worktreeSystemPrompt(wid, worktree.branch, worktree.dir, worktree.snapshot) + "\n\n" : "") +
    parsed.prompt;

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
  else void announcePane(logDir, config, wid, term, systemWaiver, ledger, status);

  // The signal handlers and the one failure path come first: the spawn must not run unguarded.
  let spawned: ReturnType<typeof spawn> | undefined;
  let t0 = Date.now();
  let eventsFd: number | null = null;
  let killed = false;
  let stopDeadline: (() => void) | null = null;
  let stopTrack: (() => void) | null = null;
  const cleanup = () => {
    stopDeadline?.();
    stopTrack?.();
    if (eventsFd !== null) {
      try {
        closeSync(eventsFd);
      } catch {
        /* already closed */
      }
      eventsFd = null;
    }
  };
  const onCodexSignal = (sig: string) => {
    killed = true;
    recordKilledEnd({ logDir, status, sig, t0, ledger, wid, providerName: target.providerName, model, label });
    // same as the claude path: a killed run's worktree and branch go now
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
    // the codex tree goes with it (finaliseRun, which reaps, never runs on this path)
    void reapRunTree(worktree?.dir).finally(() => process.exit(143));
    setTimeout(() => process.exit(143), 2000).unref();
  };
  const sigHandlers = (["SIGTERM", "SIGINT", "SIGHUP"] as const).map((sig) => [sig, () => onCodexSignal(sig)] as const);
  for (const [sig, h] of sigHandlers) process.once(sig, h);
  // A start that dies (spawn, process "error"): the same end as a normal exit — cleanup, status failed with the error, tree reaped, worktree salvaged.
  const failRun = async (e: unknown): Promise<void> => {
    for (const [sig, h] of sigHandlers) process.off(sig, h);
    markStartFailed(logDir, status, e);
    cleanup();
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
    spawned = await spawnOwned(wid, ["codex", ...buildCodexArgs(prompt, parsed.callerModel ? undefined : model)], {
      env,
      cwd: worktree?.dir ?? cwd,
      stdio: ["ignore", "pipe", "inherit"],
      title: paneTitle(label, target.providerName),
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

  const fold = emptyCodexResult();
  eventsFd = openSync(eventsPath(logDir, wid), "a");
  const writeEvent = (obj: Record<string, unknown>) => {
    if (eventsFd === null) return;
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

  stopDeadline = a.limit ? armDeadline(proc, a.limit, () => fireDeadline(logDir, status, ledger, a.limit!), undefined, () => blockedMsOf(logDir, wid)) : null;
  stopTrack = trackBlocked(logDir, status, a.limit);

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
    const onError = (e: Error) => void failRun(e).then(() => reject(e), () => reject(e));
    if (earlyError) onError(earlyError);
    else proc.on("error", onError);
    proc.on("close", (code) => resolve(code ?? (killed ? 143 : 1)));
  });

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
  cleanup();

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
      if (!a.quiet) printResult(parsed.outputFormat, resultEvent, rc, logDir, wid, rep, { ...worktreeExtras(st), ...identityExtras(wid, a.priorIds, st) });
    },
  });
}
