/**
 * stall.ts — the daemon's event-loop stall monitor: the router's detector, with the daemon tasks
 * running at that moment named on the line (slow-task.ts keeps the set).
 */
import { startStallMonitor, type StallMonitor } from "../router/stall.js";
import { runningTasks } from "./slow-task.js";

export const DAEMON_STALL_MS = 500;

export function startDaemonStallMonitor(o: { log?: (line: string) => void; thresholdMs?: number; tickMs?: number; now?: () => number } = {}): StallMonitor {
  const log = o.log ?? ((l) => void process.stderr.write(l + "\n"));
  return startStallMonitor({
    thresholdMs: o.thresholdMs ?? DAEMON_STALL_MS,
    tickMs: o.tickMs,
    now: o.now,
    log: (line) => log(`[pai-daemon] ${line}; running tasks: ${runningTasks().join(", ") || "-"}`),
  });
}
