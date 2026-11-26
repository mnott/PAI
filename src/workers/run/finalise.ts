/**
 * run/finalise.ts — end-of-run bookkeeping: deadline/signal ends, loop stop, finaliseRun, relaunch options, AG2 re-ask, printResult, moved verbatim out of
 * run.ts (split plan). run.ts re-exports everything here so every
 * existing import path keeps working.
 */

import { spawn, execFileSync } from "node:child_process";
import { shortText } from "../args.js";
import { buildRunEnv } from "../run-env.js";
import { appendLedger } from "../ledger.js";
import { appendStopEvent, decideEndReason, endFields, requestKill, type EndInfo } from "../endreason.js";
import { takeLoopStop } from "../loop-stop.js";
import { readFileSync } from "node:fs";
import { eventsPath } from "../paths.js";
import { sumRunUsage } from "../usage.js";
import { usageLogFile } from "../../router/usage.js";
import { type WorkerStatus, saveStatus, UNLABELED } from "../status.js";
import { committedFallThrough, invalidCloudReport } from "../policy.js";
import { checkOrphanedChildren, isWorkerId } from "../tree.js";
import { deliverHandoff } from "../handoff.js";
import { aibrokerMessenger } from "../run-events.js";
import { ownerOf } from "../local-idle.js";
import { reviewNote } from "../time-budget.js";
import {
  salvageOnExit,
  archiveEmptyResult,
  commitLines,
  recordWorktree,
} from "../worktree.js";
import { AG2_REASK_TEXT, applyClaimCheck, type WorkerReport } from "../report.js";
import { scanWorkerRun } from "../scan.js";
import { readWorkersCached } from "../config.js";
import { killTree } from "../kill-tree.js";
import { deepfrozenIds } from "../deepfreeze.js";
import { removeRunSettings } from "../settings-file.js";
import { type RunLimit } from "../deadline.js";
import { reapWorkerProcesses } from "../reap.js";
import { blockedMsOf } from "../active-time.js";
import { resumePreempted } from "../preempt.js";
import { resultFromOutput } from "./provider-test.js";
import {
  type RunOptions,
  type StreamEvent,
  type FinaliseArgs,
  type Ag2ReaskArgs,
} from "./types.js";
import { modelFlagArgs } from "./model.js";
import { ensureToolSearch } from "./argv.js";
import { hasMalformedToolCall, MALFORMED_TOOL_CALL, DEGENERATE_ANSWER } from "../malformed-toolcall.js";
import { revokeRunToken } from "../run-token.js";
import { redactSecrets } from "../../utils/redact.js";
import { recordRunOutcomes } from "../../hooks/ts/lib/antipattern-log.js";

/**
 * The finalisation every engine shares: orphaned-children check, state, the
 * WORKER-END ledger line, worktree outcome, parent handoff, final rc. A worker
 * owns its children's results (the worker contract says so): if it
 * backgrounded a sub-worker and exited without waiting, the run must not
 * report success, whatever the process returned.
 */
/** Per-git-call bound for the salvage a kill signal runs before exiting. */
export const SIGNAL_SALVAGE_MS = 5_000;

/**
 * A budget checkpoint found no progress: stop the run like a deadline (SIGTERM,
 * then SIGKILL after the grace), with a PAI-kill marker so the end reads as
 * PAI's own stop. The salvage, the "review" state and the mailbox line happen on
 * the normal close path once the fold sees the child die (status.needsReview).
 */
export function fireBudgetStop(logDir: string, status: WorkerStatus, ledger: string, why: string): void {
  requestKill(logDir, ledger, status.id, "time-budget", false, `budget checkpoint: ${why}`);
  appendStopEvent(logDir, status.id, { killed_by: "time-budget", forced: false, reason: `budget checkpoint: ${why} (timer: workers.timeBudget)` });
  void killTree(logDir, status.id, { skipRoot: true, by: "time-budget", reason: `budget checkpoint: ${why}` }).catch(() => undefined);
}

/** The deadline fired: record it on the status and in the ledger (the caller then stops the child). */
export function fireDeadline(logDir: string, status: WorkerStatus, ledger: string, limit: RunLimit): void {
  const waited = Math.round(((status.queueWaitedMs ?? 0) + blockedMsOf(logDir, status.id)) / 60_000);
  const what = limit.absolute ? `deadline reached after ${limit.minutes} min` : `deadline reached after ${limit.minutes} active min${waited ? ` (waited ${waited} min, not counted)` : ""}`;
  status.timedOut = true;
  status.last = what;
  saveStatus(logDir, status);
  appendLedger(ledger, "WORKER-DEADLINE", { id: status.id, minutes: limit.minutes, waitedMin: waited });
  appendStopEvent(logDir, status.id, { killed_by: "deadline", forced: false, reason: `${what} (timer: --max-minutes/--deadline, armed at spawn)` });
  // the deadline stops the run's own process; its sub-workers go with it
  void killTree(logDir, status.id, { skipRoot: true, by: "deadline", reason: `parent worker ${what}` }).catch(() => undefined);
}

/**
 * Keep the status' deadline and blockedMs in step with build-gate waits (the
 * run's deadline counts active time), so ps shows the real time left. Returns the stop function.
 */
export function trackBlocked(logDir: string, status: WorkerStatus, limit: RunLimit | null): () => void {
  if (!limit) return () => undefined;
  const base = limit.deadlineAt;
  const t = setInterval(() => {
    const b = blockedMsOf(logDir, status.id);
    if (b === (status.blockedMs ?? 0)) return;
    status.blockedMs = b;
    if (!limit.absolute) status.deadlineAt = base + b;
    saveStatus(logDir, status);
  }, 15_000);
  t.unref();
  return () => clearInterval(t);
}

/** A signal killed the run: status killed/143, the end reason, and the WORKER-END ledger line (shared by the claude and codex paths). */
export function recordKilledEnd(p: {
  logDir: string;
  status: WorkerStatus;
  sig: string;
  t0: number;
  ledger: string;
  wid: string;
  providerName: string;
  model: string;
  label: string;
}): void {
  const { logDir, status, sig, ledger } = p;
  resumePreempted(logDir, status.id);
  // `pai stop` (deep freeze) names this id in its record: the end is a preserved stop, not a kill
  status.state = deepfrozenIds().has(status.id) ? "deepfrozen" : "killed";
  status.rc = 143;
  status.secs = Math.floor((Date.now() - p.t0) / 1000);
  const end = recordSignalEnd(logDir, status, sig);
  status.last = `killed by signal ${sig} (${end.reason}${end.by ? ` by ${end.by}` : ""})`;
  saveStatus(logDir, status);
  appendLedger(ledger, "WORKER-END", {
    id: p.wid,
    provider: p.providerName,
    mode: "headless",
    model: p.model,
    rc: 143,
    secs: status.secs,
    killed: 1,
    ...endFields(end),
    note: end.note,
    label: p.label,
  });
}

/** Decide why a signal ended the run and put it on the status; the caller writes WORKER-END. */
export function recordSignalEnd(logDir: string, status: WorkerStatus, signal: string): EndInfo {
  const end = decideEndReason({
    logDir,
    id: status.id,
    signal,
    timedOut: status.timedOut,
    parentPid: status.parentPid,
    parentComm: status.parentComm,
    parentBackground: status.parentBackground,
  });
  status.endReason = end.reason;
  status.endBy = end.by;
  status.endNote = end.note;
  if (end.killReason) status.endKillReason = end.killReason;
  if (end.forced) status.endForced = true;
  return end;
}

/**
 * A run the loop guard stopped: the status note and the report that ends it.
 * Commits on the branch make it finished work to review (r=~), none a failure
 * (r=-). Shared by the fresh finalise and the pool host's per-task ending.
 */
export function applyLoopStop(
  status: WorkerStatus,
  loopStop: { reason: string },
  report: WorkerReport | null,
  fallbackText: string | undefined,
  worktree: { dir: string; base: string } | null | undefined
): WorkerReport {
  const reason = `loop-stopped: ${loopStop.reason}`;
  status.loopStopped = true;
  status.last = shortText(reason, 90);
  // a loop after committing is finished work to review, not a failure
  const commits = worktree ? commitLines(worktree.dir, worktree.base) : [];
  if (commits.length) {
    const why = `loop-stopped after committing: ${loopStop.reason}`;
    const list = `commits: ${commits.join("; ")}`;
    return { ...(report ?? {}), result: "~", why, notes: [why, list, report?.notes ?? fallbackText].filter(Boolean).join("\n") };
  }
  return { ...(report ?? {}), result: "-", why: reason, notes: [reason, report?.notes ?? fallbackText].filter(Boolean).join("\n") };
}

/** The end-of-run scan under its budget (workers.scanBudgetMs, default 5000): a scan over budget is terminated, not waited for. */
async function scanWithinBudget(logDir: string, status: WorkerStatus, ledger: string): Promise<void> {
  let budgetMs = 5000;
  try {
    budgetMs = readWorkersCached().scanBudgetMs ?? budgetMs;
  } catch {
    // unreadable config: the default budget
  }
  const done = await scanWorkerRun(logDir, status, { budgetMs }).catch(() => undefined);
  if (done === "over") appendLedger(ledger, "WORKER-SCAN-STOPPED", { id: status.id, reason: "scan stopped: over budget", budgetMs });
}

export async function finaliseRun(f: FinaliseArgs): Promise<number> {
  const { logDir, ledger, ok, rc } = f;
  let { status, report } = f;
  const wid = status.id;
  // workers this run preempted (--now on a local provider) go on
  resumePreempted(logDir, wid);
  // the settings files carried the provider token: gone with the run
  removeRunSettings(logDir, wid);
  // a keyless run's placeholder dies with it
  await revokeRunToken(wid);
  // nothing the worker started outlives it: descendants, its process group (the backgrounded Bash
  // children), detached processes parked in its worktree, and escapees whose env still names this id
  await reapWorkerProcesses({ rootPid: process.pid, dir: f.worktree?.dir, id: wid });
  // first, whatever the outcome (rc 143 included): uncommitted edits in the
  // worktree must reach the branch before anything can drop the worktree
  const salvaged = f.worktree
    ? salvageOnExit(ledger, wid, status.label || UNLABELED, f.worktree.dir)
    : [];
  if (salvaged.length) {
    const msg = `WORKER-SALVAGE: committed uncommitted edits (${salvaged.join(", ")})`;
    report = { ...(report ?? {}), notes: [report?.notes ?? f.fallbackText, msg].filter(Boolean).join("\n"), result: report?.result ?? "-" };
  }
  if (f.timedOut) {
    const reason = status.last.startsWith("deadline reached") || status.handoffMin ? status.last : `deadline reached after ${f.timedOut} min`;
    status.timedOut = true;
    status.last = reason;
    // partial state = the salvage summary (r=~: stopped, not failed outright)
    report = { ...(report ?? {}), result: "~", why: reason, notes: [reason, report?.notes ?? f.fallbackText].filter(Boolean).join("\n") };
  }
  const loopStop = takeLoopStop(logDir, wid);
  if (loopStop) report = applyLoopStop(status, loopStop, report, f.fallbackText, f.worktree);
  const orphanReason = checkOrphanedChildren(logDir, wid);
  // a budget checkpoint stopped this run with no progress: the work above is on
  // the branch; the state says needs review, and nothing falls through to the
  // cloud from here — the owning session decides (resume / extend / cloud).
  const forReview = !!status.needsReview && !loopStop;
  if (forReview) {
    const reason = status.last || "stopped at a budget checkpoint";
    report = { ...(report ?? {}), result: "~", why: reason, notes: [reason, report?.notes ?? f.fallbackText].filter(Boolean).join("\n") };
  }
  const succeeded = ok && !orphanReason && !f.timedOut && !loopStop;
  status.state = forReview ? "review" : succeeded ? "done" : "failed";
  status.rc = rc;
  status.secs = f.secs;
  // one outcome line per anti-pattern firing of this run
  recordRunOutcomes(wid, loopStop ? "stopped" : succeeded ? "succeeded" : "failed");
  if (orphanReason) {
    status.last = shortText(orphanReason, 90);
    report = { ...(report ?? {}), notes: orphanReason, result: "-" };
    appendLedger(ledger, "WORKER-ORPHAN-CHILDREN", { id: wid, reason: orphanReason });
  }
  const end = decideEndReason({ logDir, id: wid, timedOut: f.timedOut !== undefined, loopStopped: !!loopStop, childSignal: status.childSignal });
  status.endReason = end.reason;
  status.endBy = end.by;
  status.endNote = end.note;
  if (end.reason === "exit" && hasMalformedToolCall(report?.notes ?? f.fallbackText)) status.endReason = MALFORMED_TOOL_CALL;
  // PAI itself stopped the child (not the deadline, not a signal): the report says which timer or check did
  if (end.reason === "pai-worker-kill" && !f.timedOut && end.killReason && !succeeded) {
    status.last = shortText(end.killReason, 90);
    report = { ...(report ?? {}), result: report?.result ?? "-", why: end.killReason, notes: [end.killReason, report?.notes ?? f.fallbackText].filter(Boolean).join("\n") };
  }
  // r=~ (partial) means the work continues: saveStatus then keeps the issue claims
  status.claimsContinue = report?.result === "~" || forReview;
  saveStatus(logDir, status);
  appendLedger(ledger, "WORKER-END", { id: wid, ...f.end, rc, secs: f.secs, ...endFields(end), ...(status.endReason === MALFORMED_TOOL_CALL ? { instrument: MALFORMED_TOOL_CALL } : {}) });

  if (f.worktree) status = recordWorktree(logDir, status, f.worktree, ok);

  // the after-the-fact rule scan over the run's transcript; counts land on
  // the status for ps/replay. Best effort: a scan never fails the run.
  await scanWithinBudget(logDir, status, ledger);

  const reviewed = f.worktree && !status.handoffMin && !forReview ? committedFallThrough(f.fallThroughWhy?.(status, report) ?? null, commitLines(f.worktree.dir, f.worktree.base)) : null;
  if (reviewed) {
    process.stderr.write(`pai worker: ${wid} ended badly but committed — kept for review, no cloud re-run\n`);
    appendLedger(ledger, "WORKER-FALLTHROUGH-REVIEW", { id: wid, reason: reviewed.why });
    report = { ...(report ?? {}), ...reviewed };
    status.claimsContinue = true;
    saveStatus(logDir, status);
    f.onReviewed?.();
  }
  // the report's claimed code must be in the branch's diff (Paperfull #74: a claimed handler was never written)
  if (f.worktree && report?.changed?.length) {
    try {
      const diff = execFileSync("git", ["diff", "--unified=0", `${f.worktree.base}..HEAD`], { cwd: f.worktree.dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
      const checked = applyClaimCheck(report, diff);
      if (checked !== report) {
        report = checked;
        if (checked.checks?.some((c) => c.name === "ClaimsInDiff" && c.ok === false)) {
          appendLedger(ledger, "REPORT-CLAIMS-ABSENT", { id: wid, detail: checked.checks.find((c) => c.name === "ClaimsInDiff")?.detail ?? "" });
          status.claimsContinue = report.result === "~";
          saveStatus(logDir, status);
        }
      }
    } catch {
      // no diff to check against: the claim check is skipped
    }
  }
  const cloudInvalid = !forReview && f.cloudRun?.(status) ? invalidCloudReport(status, report) : null;
  if (cloudInvalid) {
    appendLedger(ledger, "WORKER-REPORT-INVALID", { id: wid, reason: cloudInvalid.why });
    report = { ...(report ?? {}), ...cloudInvalid };
    status.claimsContinue = true;
    saveStatus(logDir, status);
  }
  // a review stop skips the handoff hooks entirely: no escalation, no rerun.
  const early = forReview ? undefined : await f.beforeHandoff?.(status, report);
  if (typeof early === "number") return early;

  const finalRc = rc !== 0 ? rc : succeeded ? 0 : 1;
  // a budget checkpoint stopped the run for review: one mailbox line to the
  // owning session with what it did and the three ways on (never a cloud
  // fall-through from this path).
  if (status.needsReview) {
    const why = status.last || "stopped at a budget checkpoint";
    const did = f.worktree ? commitLines(f.worktree.dir, f.worktree.base) : [];
    try {
      await aibrokerMessenger(logDir).toSession(ownerOf(status), reviewNote(wid, status.label || UNLABELED, why, did, status.last)).catch(() => false);
    } catch {
      // the mailbox line is best effort; the review state and ledger already stand
    }
  }
  if (status.parent && isWorkerId(logDir, status.parent)) {
    try {
      await deliverHandoff(logDir, {
        from: wid,
        to: status.parent,
        kind: "result",
        text: shortText(report?.notes ?? f.fallbackText ?? (succeeded ? "done" : "failed"), 400),
        data: {
          rc: finalRc,
          ok: succeeded,
          ...(status.branch ? { branch: status.branch, commits: status.commits ?? 0 } : {}),
          ...(report ? { report } : {}),
        },
      });
    } catch {
      // the inbox line is best effort; it must never fail the exit path
    }
  }
  // nothing to merge: the worktree goes now instead of piling up until gc
  if (f.worktree && status.worktreeDir) archiveEmptyResult(logDir, status);
  // a review stop exits 0: PAI stopped it on purpose, rc 1 would read as a model failure
  return forReview ? 0 : finalRc;
}

/** Own-identity fields of the final json: this run's id, every run's id in order, the provider, the instrument fault (or null). */
export function identityExtras(wid: string, priorIds: string[] | undefined, s: Pick<WorkerStatus, "provider"> & Partial<Pick<WorkerStatus, "endReason">>): Record<string, unknown> {
  const instrument = s.endReason === MALFORMED_TOOL_CALL || s.endReason === DEGENERATE_ANSWER ? s.endReason : null;
  return { worker_id: wid, worker_ids: [...(priorIds ?? []), wid], provider: s.provider, instrument };
}

/**
 * Options for a relaunch (empty-response retry, quota reroute): the original
 * run's options, minus the preset id (the relaunch is a new worker), with the
 * given changes applied. Nothing is copied field by field, so a new RunOptions
 * field is carried over by default.
 */
export function relaunchOptions(orig: RunOptions, changes: Partial<RunOptions>): RunOptions {
  return { ...orig, id: undefined, ...changes };
}

/** The worktree fields printResult adds to a json payload, when there is one. */
export function worktreeExtras(s: WorkerStatus): Record<string, unknown> | undefined {
  return s.branch ? { branch: s.branch, commits: s.commits ?? 0 } : undefined;
}

/**
 * The one bounded re-ask, cap exactly one: `claude --resume <session>` with
 * AG2_REASK_TEXT, single-shot `--output-format json` (one turn, no streaming
 * plumbing needed). Same env/model/mcp/tool flags as the original launch —
 * only --resume and the fixed re-ask prompt are new — so the resumed turn
 * sees the same grants the worker ran with.
 */
function emitEvent(onEvent: (e: StreamEvent) => void, line: string): void {
  if (!line.startsWith("{")) return;
  try {
    onEvent(JSON.parse(line) as StreamEvent);
  } catch {
    // a torn or unparsable line is not an event
  }
}

/**
 * Fold a continuation's result into the run's result so the printed stats cover the whole run: turns, duration,
 * cost and usage are summed (each resumed invocation reports only its own), the answer text is the latest one.
 */
export function foldContinuationResult(base: StreamEvent, cont: StreamEvent): void {
  const b = base as Record<string, unknown>;
  const c = cont as Record<string, unknown>;
  for (const k of ["num_turns", "duration_ms", "duration_api_ms", "total_cost_usd"]) {
    if (typeof c[k] === "number") b[k] = (typeof b[k] === "number" ? (b[k] as number) : 0) + (c[k] as number);
  }
  if (cont.usage) {
    const u: Record<string, unknown> = { ...(base.usage ?? {}) };
    for (const [k, v] of Object.entries(cont.usage as Record<string, unknown>)) {
      if (typeof v === "number") u[k] = (typeof u[k] === "number" ? (u[k] as number) : 0) + v;
    }
    base.usage = u as StreamEvent["usage"];
  }
  if (typeof cont.result === "string" && cont.result) base.result = cont.result;
  if (cont.is_error !== undefined) base.is_error = cont.is_error;
}

export async function reaskAg2Report(a: Ag2ReaskArgs): Promise<string> {
  let cmd: string[] = [...(a.claudeCmd ?? ["claude"])];
  cmd.push(...modelFlagArgs(true, a.model, a.callerPinnedModel));
  cmd.push(...a.chromeArgs, ...a.mcpArgs, ...a.toolArgs, ...a.toolsFlag, ...(a.slimArgs ?? []));
  cmd.push("--resume", a.sessionId, "-p", a.prompt ?? AG2_REASK_TEXT, ...(a.onEvent ? ["--output-format", "stream-json", "--verbose"] : ["--output-format", "json"]));
  cmd = ensureToolSearch(cmd);
  const proc = spawn(cmd[0], cmd.slice(1), { env: a.env, cwd: a.cwd, stdio: ["ignore", "pipe", "inherit"] });
  const timer = setTimeout(() => {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }, a.timeoutMs ?? 60_000);
  let out = "";
  let pending = "";
  proc.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    out += text;
    if (!a.onEvent) return;
    const lines = (pending + text).split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) emitEvent(a.onEvent, line);
  });
  await new Promise<void>((resolve) => {
    proc.on("error", () => resolve());
    proc.on("close", () => resolve());
  });
  clearTimeout(timer);
  if (a.onEvent) emitEvent(a.onEvent, pending);
  return resultFromOutput(out);
}

// ---------------------------------------------------------------------------
// codex engine (2d)
// ---------------------------------------------------------------------------

/**
 * The result a loop-stopped run prints when the killed claude never emitted one: the stop reason with the usage
 * (summed from the run's event log), turns and duration so far, so `--output-format json` is not empty.
 */
export function loopStopResult(logDir: string, wid: string, reason: string, turns: number, secs: number, routerLog: string = usageLogFile()): StreamEvent {
  let usage: StreamEvent["usage"];
  try {
    const events = readFileSync(eventsPath(logDir, wid), "utf8");
    const t = [...sumRunUsage(events).byModel.values()].reduce(
      (a, m) => ({ i: a.i + m.input, r: a.r + m.cacheRead, w: a.w + m.cacheWrite5m + m.cacheWrite1h, o: a.o + m.output }),
      { i: 0, r: 0, w: 0, o: 0 }
    );
    // A streamed assistant event carries the message_start usage (output 0); the real output arrives in the final
    // result, which a killed run never emits. The router's per-request ledger has it, keyed by the claude session.
    if (t.o === 0) {
      const sid = /"session_id":"([^"]+)"/.exec(events)?.[1];
      const routed = sid ? routerSessionTotals(routerLog, sid) : null;
      if (routed) Object.assign(t, routed);
    }
    usage = { input_tokens: t.i, output_tokens: t.o, cache_read_input_tokens: t.r, cache_creation_input_tokens: t.w };
  } catch {
    // no event log: usage stays absent
  }
  return { type: "result", subtype: "loop-stopped", is_error: true, result: `loop-stopped: ${reason}`, num_turns: turns, duration_ms: secs * 1000, ...(usage ? { usage } : {}) };
}

/** Summed router-ledger usage of one claude session (successful rows only); null when the session has none. */
function routerSessionTotals(file: string, sessionId: string): { i: number; r: number; w: number; o: number } | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const t = { i: 0, r: 0, w: 0, o: 0 };
  let rows = 0;
  for (const line of raw.split("\n")) {
    if (!line.includes(sessionId)) continue;
    try {
      const row = JSON.parse(line) as { session_id?: string; status?: number; input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
      if (row.session_id !== sessionId || (row.status ?? 200) >= 400) continue;
      t.i += row.input_tokens ?? 0;
      t.o += row.output_tokens ?? 0;
      t.r += row.cache_read_input_tokens ?? 0;
      t.w += row.cache_creation_input_tokens ?? 0;
      rows++;
    } catch {
      // a torn line is not a row
    }
  }
  return rows ? t : null;
}

export function printResult(
  fmt: "text" | "json" | "stream-json",
  resultEvent: StreamEvent | null,
  rc: number,
  logDir: string,
  wid: string,
  report?: WorkerReport | null,
  extras?: Record<string, unknown>
): void {
  if (fmt === "stream-json") return; // already mirrored live
  if (fmt === "json") {
    const payload = report
      ? { ...(resultEvent ?? { is_error: true, result: "no result event", rc }), report, ...extras }
      : { ...(resultEvent ?? { is_error: true, result: "no result event", rc }), ...extras };
    console.log(redactSecrets(JSON.stringify(payload)));
    return;
  }
  if (resultEvent) {
    console.log(resultEvent.result ?? "");
  } else {
    process.stderr.write(
      `pai worker: run produced no result (rc=${rc}); see ${eventsPath(logDir, wid)}\n`
    );
  }
}
