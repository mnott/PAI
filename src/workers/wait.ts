/**
 * wait.ts — `pai worker wait <id...>`: the deterministic poller.
 *
 * A script, not guidance: polls each worker's status file until every one is
 * terminal (done/failed/killed/lost), then returns their result texts. The
 * orchestrator's Bash call stays synchronous and gets the JSON on stdout,
 * with exit 1 naming whoever failed or timed out.
 */

import { readFileSync } from "node:fs";
import { eventsPath } from "./paths.js";
import { parseWorkerReport, type WorkerReport } from "./report.js";
import { loadStatus, type WorkerStatus } from "./status.js";

export interface WaitResult {
  id: string;
  label: string;
  state: WorkerStatus["state"];
  rc: number | null;
  secs: number | null;
  ok: boolean;
  /** The `result` text of the last result event in the worker's transcript. */
  result: string | null;
  report: WorkerReport | null;
}

export interface WaitOptions {
  /** Give up after this long; default 15 min. */
  timeoutMs?: number;
  /** Poll interval; default 2 s. */
  intervalMs?: number;
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

function toWaitResult(logDir: string, st: WorkerStatus): WaitResult {
  const result = lastResultText(logDir, st.id);
  return {
    id: st.id,
    label: st.label,
    state: st.state,
    rc: st.rc,
    secs: st.secs,
    ok: st.state === "done" && (st.rc ?? 0) === 0,
    result,
    report: parseWorkerReport(result ?? ""),
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
  const pending = new Set<string>();
  // the pre-sleep check: already-finished workers return without waiting
  for (const id of ids) {
    const st = loadStatus(logDir, id);
    if (!st) throw new Error(`no worker named "${id}"`);
    known.set(id, st);
    if (!TERMINAL.includes(st.state)) pending.add(id);
  }
  const deadline = Date.now() + timeoutMs;
  while (pending.size > 0 && Date.now() < deadline) {
    await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
    for (const id of [...pending]) {
      const st = loadStatus(logDir, id);
      if (st) known.set(id, st); // a vanished file keeps the last known status
      if (!st || TERMINAL.includes(known.get(id)!.state)) pending.delete(id);
    }
  }
  return { results: ids.map((id) => toWaitResult(logDir, known.get(id)!)), timedOut: [...pending] };
}
