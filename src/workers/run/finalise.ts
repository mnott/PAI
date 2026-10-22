/**
 * run/finalise.ts — end-of-run bookkeeping: deadline/signal ends, loop stop, finaliseRun, relaunch options, AG2 re-ask, printResult, moved verbatim out of
 * run.ts (split plan). run.ts re-exports everything here so every
 * existing import path keeps working.
 */

import { spawn } from "node:child_process";
import { shortText } from "../args.js";
import { buildRunEnv } from "../run-env.js";
import { appendLedger } from "../ledger.js";
import { appendStopEvent, decideEndReason, endFields, type EndInfo } from "../endreason.js";
import { takeLoopStop } from "../loop-stop.js";
import { eventsPath } from "../paths.js";
import { type WorkerStatus, saveStatus, UNLABELED } from "../status.js";
import { committedFallThrough } from "../policy.js";
import { checkOrphanedChildren, isWorkerId } from "../tree.js";
import { deliverHandoff } from "../handoff.js";
import {
  salvageOnExit,
  archiveEmptyResult,
  commitLines,
  recordWorktree,
} from "../worktree.js";
import { AG2_REASK_TEXT, type WorkerReport } from "../report.js";
import { killTree } from "../kill-tree.js";
import { removeRunSettings } from "../settings-file.js";
import { type RunLimit } from "../deadline.js";
import { reapWorkerProcesses } from "../reap.js";
import { blockedMsOf } from "../active-time.js";
import { resultFromOutput } from "./provider-test.js";
import {
  type RunOptions,
  type StreamEvent,
  type FinaliseArgs,
  type Ag2ReaskArgs,
} from "./types.js";
import { modelFlagArgs } from "./model.js";
import { ensureToolSearch } from "./argv.js";

/**
 * The finalisation every engine shares: orphaned-children check, state, the
 * WORKER-END ledger line, worktree outcome, parent handoff, final rc. A worker
 * owns its children's results (the worker contract says so): if it
 * backgrounded a sub-worker and exited without waiting, the run must not
 * report success, whatever the process returned.
 */
/** Per-git-call bound for the salvage a kill signal runs before exiting. */
export const SIGNAL_SALVAGE_MS = 5_000;

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

export async function finaliseRun(f: FinaliseArgs): Promise<number> {
  const { logDir, ledger, ok, rc } = f;
  let { status, report } = f;
  const wid = status.id;
  // the settings files carried the provider token: gone with the run
  removeRunSettings(logDir, wid);
  // nothing the worker started outlives it: descendants and detached processes parked in its worktree
  await reapWorkerProcesses({ rootPid: process.pid, dir: f.worktree?.dir });
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
    const reason = status.last.startsWith("deadline reached") ? status.last : `deadline reached after ${f.timedOut} min`;
    status.timedOut = true;
    status.last = reason;
    // partial state = the salvage summary (r=~: stopped, not failed outright)
    report = { ...(report ?? {}), result: "~", why: reason, notes: [reason, report?.notes ?? f.fallbackText].filter(Boolean).join("\n") };
  }
  const loopStop = takeLoopStop(logDir, wid);
  if (loopStop) report = applyLoopStop(status, loopStop, report, f.fallbackText, f.worktree);
  const orphanReason = checkOrphanedChildren(logDir, wid);
  const succeeded = ok && !orphanReason && !f.timedOut && !loopStop;
  status.state = succeeded ? "done" : "failed";
  status.rc = rc;
  status.secs = f.secs;
  if (orphanReason) {
    status.last = shortText(orphanReason, 90);
    report = { ...(report ?? {}), notes: orphanReason, result: "-" };
    appendLedger(ledger, "WORKER-ORPHAN-CHILDREN", { id: wid, reason: orphanReason });
  }
  const end = decideEndReason({ logDir, id: wid, timedOut: f.timedOut !== undefined, loopStopped: !!loopStop });
  status.endReason = end.reason;
  // PAI itself stopped the child (not the deadline, not a signal): the report says which timer or check did
  if (end.reason === "pai-worker-kill" && !f.timedOut && end.killReason && !succeeded) {
    status.last = shortText(end.killReason, 90);
    report = { ...(report ?? {}), result: report?.result ?? "-", why: end.killReason, notes: [end.killReason, report?.notes ?? f.fallbackText].filter(Boolean).join("\n") };
  }
  // r=~ (partial) means the work continues: saveStatus then keeps the issue claims
  status.claimsContinue = report?.result === "~";
  saveStatus(logDir, status);
  appendLedger(ledger, "WORKER-END", { id: wid, ...f.end, rc, secs: f.secs, ...endFields(end) });

  if (f.worktree) status = recordWorktree(logDir, status, f.worktree, ok);

  const reviewed = f.worktree ? committedFallThrough(f.fallThroughWhy?.(status, report) ?? null, commitLines(f.worktree.dir, f.worktree.base)) : null;
  if (reviewed) {
    process.stderr.write(`pai worker: ${wid} ended badly but committed — kept for review, no cloud re-run\n`);
    appendLedger(ledger, "WORKER-FALLTHROUGH-REVIEW", { id: wid, reason: reviewed.why });
    report = { ...(report ?? {}), ...reviewed };
    status.claimsContinue = true;
    saveStatus(logDir, status);
    f.onReviewed?.();
  }
  const early = await f.beforeHandoff?.(status, report);
  if (typeof early === "number") return early;

  const finalRc = rc !== 0 ? rc : succeeded ? 0 : 1;
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
  return finalRc;
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
export async function reaskAg2Report(a: Ag2ReaskArgs): Promise<string> {
  let cmd: string[] = [...(a.claudeCmd ?? ["claude"])];
  cmd.push(...modelFlagArgs(true, a.model, a.callerPinnedModel));
  cmd.push(...a.chromeArgs, ...a.mcpArgs, ...a.toolArgs, ...a.toolsFlag, ...(a.slimArgs ?? []));
  cmd.push("--resume", a.sessionId, "-p", AG2_REASK_TEXT, "--output-format", "json");
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
  proc.stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf8");
  });
  await new Promise<void>((resolve) => {
    proc.on("error", () => resolve());
    proc.on("close", () => resolve());
  });
  clearTimeout(timer);
  return resultFromOutput(out);
}

// ---------------------------------------------------------------------------
// codex engine (2d)
// ---------------------------------------------------------------------------

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
    console.log(JSON.stringify(payload));
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
