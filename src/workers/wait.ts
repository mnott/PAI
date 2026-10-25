/**
 * wait.ts — `pai worker wait <id...>`: the deterministic poller.
 *
 * A script, not guidance: polls each worker's status file until every one is
 * terminal (done/failed/killed/lost), then returns their result texts. The
 * orchestrator's Bash call stays synchronous and gets the JSON on stdout,
 * with exit 1 naming whoever failed or timed out.
 */

import { existsSync, readFileSync } from "node:fs";
import { eventsPath } from "./paths.js";
import { parseWorkerReport, verifyReportChanges, type WorkerReport } from "./report.js";
import { loadStatus, reconcileStatuses, type WorkerStatus } from "./status.js";

export interface WaitResult {
  id: string;
  label: string;
  state: WorkerStatus["state"];
  rc: number | null;
  secs: number | null;
  /** Absent while the worker is still running (wait timed out): not a verdict. */
  ok?: boolean;
  /** Claimed changes the filesystem does not confirm (same check as the result banner's "verify:" note). */
  unconfirmed?: string[];
  /** True when the wait's own timeout elapsed with the worker still running. */
  timedOut?: true;
  /** The `result` text of the last result event in the worker's transcript. */
  result: string | null;
  report: WorkerReport | null;
}

export interface WaitOptions {
  /** Give up after this long; default 15 min. */
  timeoutMs?: number;
  /** Poll interval; default 2 s. */
  intervalMs?: number;
  /** Return as soon as ANY named worker is terminal (default: wait for all). */
  any?: boolean;
  /** Pid ownership check (default: the one kill uses). */
  owns?: (s: Pick<WorkerStatus, "pid" | "started">) => boolean;
}

const TERMINAL: readonly WorkerStatus["state"][] = ["done", "failed", "killed", "lost"];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The `result` text of the last result event in the worker's `<id>.jsonl`,
 * scanning the file backwards; null when the file or the event is absent.
 */
function lastResultText(logDir: string, id: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(eventsPath(logDir, id), "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    try {
      const e = JSON.parse(line) as { type?: string; result?: unknown };
      if (e.type === "result" && typeof e.result === "string") return e.result;
    } catch {
      // a torn line is skipped, not fatal
    }
  }
  return null;
}

/**
 * Paths the report claims changed that verifyReportChanges (the check behind
 * the "verify: ... not confirmed" banner and the R! marker) does not confirm.
 * Empty when there is no claim or the worker's tree is gone (merged/discarded).
 */
function unconfirmedClaims(st: WorkerStatus, report: WorkerReport | null): string[] {
  if (!report?.changed?.length) return [];
  const dir = st.worktreeDir ?? st.cwd;
  if (!dir || !existsSync(dir)) return [];
  const startMs = Date.parse(st.started);
  const v = verifyReportChanges(report.changed, dir, Number.isNaN(startMs) ? 0 : startMs);
  return v.failures.map((f) => f.path);
}

function toWaitResult(logDir: string, st: WorkerStatus, pending: boolean): WaitResult {
  const result = lastResultText(logDir, st.id);
  const report = parseWorkerReport(result ?? "");
  const unconfirmed = pending ? [] : unconfirmedClaims(st, report);
  return {
    id: st.id,
    label: st.label,
    state: st.state,
    rc: st.rc,
    secs: st.secs,
    ...(pending ? { timedOut: true as const } : { ok: st.state === "done" && (st.rc ?? 0) === 0 && unconfirmed.length === 0 }),
    ...(unconfirmed.length ? { unconfirmed } : {}),
    result,
    report,
  };
}

/**
 * Wait until every named worker reaches a terminal state. Unknown ids throw
 * immediately. On timeout nothing is thrown: the return carries what is known
 * and `timedOut` names the still-pending ids.
 */
export async function waitWorkers(
  logDir: string,
  ids: string[],
  opts: WaitOptions = {}
): Promise<{ results: WaitResult[]; timedOut: string[] }> {
  const timeoutMs = opts.timeoutMs ?? 900_000;
  const intervalMs = opts.intervalMs ?? 2_000;
  const known = new Map<string, WorkerStatus>();
  reconcileStatuses(logDir, new Date(), 0, opts.owns);
  const pending = new Set<string>();
  // the pre-sleep check: already-finished workers return without waiting
  for (const id of ids) {
    const st = loadStatus(logDir, id);
    if (!st) throw new Error(`no worker named "${id}"`);
    known.set(id, st);
    if (!TERMINAL.includes(st.state)) pending.add(id);
  }
  const deadline = Date.now() + timeoutMs;
  const anyDone = () => opts.any === true && pending.size < ids.length;
  while (pending.size > 0 && !anyDone() && Date.now() < deadline) {
    await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
    reconcileStatuses(logDir, new Date(), 0, opts.owns);
    for (const id of [...pending]) {
      const st = loadStatus(logDir, id);
      if (st) known.set(id, st); // a vanished file keeps the last known status
      if (!st || TERMINAL.includes(known.get(id)!.state)) pending.delete(id);
    }
  }
  return { results: ids.map((id) => toWaitResult(logDir, known.get(id)!, pending.has(id))), timedOut: [...pending] };
}

/** Exit code of every wait verb that means "not yet, call again". */
export const WAIT_EXIT_STILL_RUNNING = 3;

/**
 * Whether the last command of a Bash `command` is a `pai worker wait*` poll.
 * `last` is that last segment (after ; && | etc.), as the caller splits it.
 */
export function isWaitPollCommand(last: string): boolean {
  return /^pai\s+worker\s+wait(-on|-url|-file)?\b/.test(last.trim());
}

/** A wait poll that exited with its documented "still running" code: an answer, not an error. */
export function isExpectedWaitExit(lastSegment: string, exitCode: number | null): boolean {
  return exitCode === WAIT_EXIT_STILL_RUNNING && isWaitPollCommand(lastSegment);
}

/** The N of a leading "Exit code N" line in a Bash error result, else null. */
export function bashExitCode(text: string): number | null {
  const m = /^\s*Exit code (\d+)/i.exec(text);
  return m ? Number(m[1]) : null;
}

export const WAIT_MAX_DEFAULT_SECS = 100;
export const WAIT_MAX_CAP_SECS = 590;

/**
 * The `pai worker wait` verb: one JSON status line per id. With --max (default
 * 100, limit 115) it returns as soon as ANY worker finishes or the max elapses:
 * exit 0 all done, 1 a finished worker failed, 3 some still running (call again
 * with the unfinished ids). The legacy --timeout waits for ALL and exits 1 on timeout
 * (same code as a failed worker; stderr and `timedOut:true` in the JSON tell them apart).
 */
export async function runWait(
  logDir: string,
  ids: string[],
  o: { max?: number; timeout?: number },
  out: (line: string) => void,
  errOut: (line: string) => void
): Promise<number> {
  const legacy = o.timeout !== undefined;
  const { results, timedOut } = await waitWorkers(logDir, ids, {
    timeoutMs: (legacy ? o.timeout! : Math.min(o.max ?? WAIT_MAX_DEFAULT_SECS, WAIT_MAX_CAP_SECS)) * 1000,
    any: !legacy,
  });
  for (const r of results) out(JSON.stringify(r));
  const failed = results.filter((r) => r.ok === false).map((r) => r.id);
  if (legacy && timedOut.length) {
    errOut(`still running after ${o.timeout}s (wait timed out, worker not affected): ${timedOut.join(", ")}`);
    return 1;
  }
  if (failed.length) {
    errOut(`pai worker wait: failed: ${failed.join(", ")}`);
    return 1;
  }
  if (timedOut.length) {
    errOut(`pai worker wait: still running: ${timedOut.join(" ")}; call wait again with these ids`);
    return 3;
  }
  return 0;
}
