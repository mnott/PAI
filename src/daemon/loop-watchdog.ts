/**
 * loop-watchdog.ts — the daemon restarts itself when its event loop is stuck.
 *
 * 2026-11-18: a task spun the loop at 95% CPU for 18 minutes; IPC timed out and
 * nothing inside the loop could notice. A timer on the same loop cannot fire
 * while it is blocked, so the watcher is a worker thread: the main loop posts a
 * heartbeat (with the names of the running periodic tasks) every second; when
 * none has arrived for `limitMs` the thread appends a DAEMON-LOOP-STALL ledger
 * line and kills the process (SIGKILL, non-zero), and launchd KeepAlive restarts it.
 */

import { Worker } from "node:worker_threads";
import { openTaskNames, setTaskOpenListener } from "./slow-task.js";

export const LOOP_STALL_LIMIT_MS = 5 * 60_000;
const HEARTBEAT_MS = 1_000;

export interface WatchdogOptions {
  ledgerFile: string;
  limitMs?: number;
  /** how often the thread checks; default 5 s */
  checkMs?: number;
  /** false in tests: report instead of killing */
  kill?: boolean;
  onStall?: (tasks: string[], stalledMs: number) => void;
}

const WORKER_SRC = `
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
let last = Date.now();
let tasks = [];
parentPort.on("message", (m) => { last = Date.now(); tasks = m.tasks || []; });
const p = (n) => String(n).padStart(2, "0");
const t = setInterval(() => {
  const stalled = Date.now() - last;
  if (stalled < workerData.limitMs) return;
  clearInterval(t);
  const d = new Date();
  const stamp = d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  try {
    fs.appendFileSync(workerData.ledgerFile, stamp + " DAEMON-LOOP-STALL pid=" + workerData.pid + " stalledMs=" + stalled + " tasks=" + (tasks.join(",") || "none") + " action=" + (workerData.kill ? "exit" : "report") + "\\n");
  } catch {}
  parentPort.postMessage({ stalled, tasks });
  if (workerData.kill) process.kill(workerData.pid, "SIGKILL");
}, workerData.checkMs);
`;

/** Start the watchdog thread; returns stop(). */
export function startLoopWatchdog(o: WatchdogOptions): () => void {
  const w = new Worker(WORKER_SRC, {
    eval: true,
    workerData: { ledgerFile: o.ledgerFile, limitMs: o.limitMs ?? LOOP_STALL_LIMIT_MS, checkMs: o.checkMs ?? 5_000, kill: o.kill ?? true, pid: process.pid },
  });
  w.unref();
  w.on("error", () => undefined);
  w.on("message", (m: { stalled: number; tasks: string[] }) => o.onStall?.(m.tasks, m.stalled));
  const beat = (): void => w.postMessage({ tasks: openTaskNames() });
  beat();
  setTaskOpenListener(beat);
  const timer = setInterval(beat, HEARTBEAT_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    setTaskOpenListener(undefined);
    void w.terminate();
  };
}
