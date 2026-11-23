/**
 * queue-thread.ts — worker_thread entry that computes the /cockpit/queue snapshot off the router's
 * event loop. The queue walk (status files, ledgers, worktrees, scheduler file) costs seconds on a
 * large log dir; run on the router's own thread it stalled every request, including cloud proxying.
 * The thread is long-lived so its status caches stay warm. Protocol: parent posts { id, logDir };
 * the thread answers { id, value } or { id, error }.
 */

import { parentPort } from "node:worker_threads";
import { readWorkersCached } from "../workers/config.js";
import { cockpitQueue } from "./cockpit.js";

parentPort?.on("message", (m: { id: number; logDir: string }) => {
  try {
    parentPort?.postMessage({ id: m.id, value: cockpitQueue(m.logDir, readWorkersCached(), Date.now()) });
  } catch (e) {
    parentPort?.postMessage({ id: m.id, error: e instanceof Error ? e.message : String(e) });
  }
});
