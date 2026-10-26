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
import {
  buildOpencodeArgs,
  buildOpencodeEnv,
  opencodeDroppedFlags,
  emptyOpencodeResult,
  foldOpencodeLine,
  parseOpencodeLine,
} from "../opencode.js";
import { type StreamEvent, type ImageExecuteArgs, type ExecuteArgs, type CodexArgs, type OpencodeArgs } from "./types.js";
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

/**
 * The CLI-engine run (codex / opencode): the whole spawn-and-fold path both
 * non-Claude spawn engines share — pane gate, worktree, status, ledger,
 * signal/fail guards, spawn, line-by-line fold, exit handling, finalise.
 * `engine` names it in the ledger/status/end line; the fold (parse + fold +
 * counters + session field) is the engine module's own; `envThunk`/`buildCmd`
 * run after the scratch env is applied (opencode writes its config into it).
 */
/** The fold both CLI-engine folds carry: counters + normalised events. */
interface EngineFold {
  events: Array<Record<string, unknown>>;
  turns: number;
  tools: number;
  last: string | null;
  isError: boolean;
  contextTokens: number | null;
  finalText: string | null;
}

interface CliEngineRun {
  engine: "codex" | "opencode";
  /** Env from the engine module (before worker identity/scratch are applied). */
  env: NodeJS.ProcessEnv;
  /** Env built once the scratch dir exists (opencode writes its config into it). */
  envThunk?: (scratch: string) => NodeJS.ProcessEnv;
  /** Flags the engine drops from the claude argv (ledgered as a WORKER-NOTE). */
  dropped: string[];
  /** Spawn argv (binary first), called with the run's prompt. */
  buildCmd: (prompt: string) => string[];
  /** Line parser + fold of the engine's JSONL stream, with its counters. */
  parse: (line: string) => unknown | null;
  foldLine: (parsedLine: unknown, fold: EngineFold) => void;
  emptyFold: () => EngineFold;
  /** The fold's session/thread id, stored as status.claudeSession. */
  sessionId: (fold: EngineFold) => string | null;
}

async function executeCliEngineRun(a: CodexArgs | OpencodeArgs, spec: CliEngineRun): Promise<number> {
  const { config, logDir, target, model, label, parsed, systemWaiver } = a;
  if (!parsed.headless || parsed.prompt === null) {
    throw new Error(
      `provider "${target.providerName}" (engine ${spec.engine}) supports headless runs only: ` +
        `pass the task with -p '<prompt>'`
    );
  }
  // opencode's config file lands in the scratch dir, so its env is built
  // after applyScratchEnv below; codex's env is ready here
  const env = spec.envThunk ? {} : spec.env;
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
  const scratch = applyScratchEnv(env, wid, worktree?.dir ?? cwd);
  if (spec.envThunk) Object.assign(env, spec.envThunk(scratch));
  // CLI engines take instructions through the prompt, not a system prompt flag
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
    // CLI engines take instructions through the prompt, not the AG2 contract flag
    reportFormat: "json",
    ...(session ? { session } : {}),
    ...(spawnerSession ? { spawnerSession } : {}),
    // a CLI engine has no init event of its own: the synthetic one below
    // announces an explicitly configured window (never a guessed default)
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
    engine: spec.engine,
    model,
    cwd,
    label,
    ...(a.capability ? { capability: a.capability } : {}),
  });
  if (spec.dropped.length) {
    appendLedger(ledger, "WORKER-NOTE", {
      id: wid,
      note: `dropped for ${spec.engine}: ${spec.dropped.join(", ")}`,
    });
  }

  if (paneVerified) status.pane = { opened: true, exec: true };
  else await announcePane(logDir, config, wid, term, systemWaiver, ledger, status);

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
  const onEngineSignal = (sig: string) => {
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
    // the engine's tree goes with it (finaliseRun, which reaps, never runs on this path)
    void reapRunTree(worktree?.dir).finally(() => process.exit(143));
    setTimeout(() => process.exit(143), 2000).unref();
  };
  const sigHandlers = (["SIGTERM", "SIGINT", "SIGHUP"] as const).map((sig) => [sig, () => onEngineSignal(sig)] as const);
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
    spawned = await spawnOwned(wid, spec.buildCmd(prompt), {
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

  const fold = spec.emptyFold();
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
    const parsedLine = spec.parse(line);
    if (parsedLine === null) return;
    spec.foldLine(parsedLine, fold);
    const sid = spec.sessionId(fold);
    if (sid && !status.claudeSession) status.claudeSession = sid;
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
  status.last =
    shortText(report?.notes ?? finalText, 90) ||
    (!ok && fold.last ? shortText(fold.last, 90) : "") ||
    (ok ? "done" : "failed");
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
      engine: spec.engine,
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

export async function executeCodexRun(a: CodexArgs): Promise<number> {
  return executeCliEngineRun(a, {
    engine: "codex",
    env: buildCodexEnv(a.target.provider),
    dropped: codexDroppedFlags(a.claudeArgs),
    buildCmd: (prompt) => ["codex", ...buildCodexArgs(prompt, a.parsed.callerModel ? undefined : a.model)],
    parse: parseCodexLine,
    foldLine: foldCodexLine as (p: unknown, f: EngineFold) => void,
    emptyFold: emptyCodexResult as () => EngineFold,
    sessionId: (f) => (f as unknown as { threadId: string | null }).threadId,
  });
}

export async function executeOpencodeRun(a: OpencodeArgs): Promise<number> {
  // buildOpencodeEnv writes OPENCODE_CONFIG into the scratch dir, so the env
  // goes through envThunk — executeCliEngineRun runs it after applyScratchEnv
  return executeCliEngineRun(a, {
    engine: "opencode",
    env: {},
    envThunk: (scratch) => buildOpencodeEnv(a.target.provider, a.target.providerName, a.model, scratch),
    dropped: opencodeDroppedFlags(a.claudeArgs),
    buildCmd: (prompt) => ["opencode", ...buildOpencodeArgs(prompt, a.parsed.callerModel ? undefined : a.model)],
    parse: parseOpencodeLine,
    foldLine: foldOpencodeLine as (p: unknown, f: EngineFold) => void,
    emptyFold: emptyOpencodeResult as () => EngineFold,
    sessionId: (f) => (f as unknown as { sessionId: string | null }).sessionId,
  });
}
